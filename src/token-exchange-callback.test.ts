import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn(), captureException }));

import { CALLBACK_ERROR_CATEGORY, CALLBACK_ERROR_REASON } from "./callback-reasons";
import { MCP_GRANT_MAX_AGE_SECONDS } from "./session-lifetimes";
import { createKnockEnv } from "./test/knock-env";
import { tokenData, upstreamError, upstreamOk } from "./test/token-fixtures";
import { nowSeconds } from "./time";
import { ensureUpstreamSession } from "./token-exchange-callback";
import { storeKnockTokens } from "./token-store";
import type { Props } from "./types";

const established = (overrides: Partial<Props> = {}): Props => ({
  tokenId: "t1",
  clientId: "client_upstream",
  issuedAt: nowSeconds() - 3600,
  ...overrides,
});

describe("ensureUpstreamSession", () => {
  let { env, kv } = createKnockEnv();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    ({ env, kv } = createKnockEnv());
    captureException.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const refresh = async (props: Props) => {
    const settled = ensureUpstreamSession({
      grantType: "refresh_token",
      props,
      env,
    } as unknown as Parameters<typeof ensureUpstreamSession>[0]).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await settled;
    if (!result.ok) throw result.error;
  };

  it("ignores authorization code exchanges and service-token sessions", async () => {
    const getSpy = vi.spyOn(kv, "get");

    await ensureUpstreamSession({
      grantType: "authorization_code",
      props: established(),
      env,
    } as unknown as Parameters<typeof ensureUpstreamSession>[0]);
    await refresh({ serviceToken: "knock_st_abc", clientId: "c" });

    expect(getSpy).not.toHaveBeenCalled();
  });

  it("refreshes the upstream token and renews the record when the session is healthy", async () => {
    await storeKnockTokens(env, "t1", tokenData(), 1000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamOk());

    await expect(refresh(established())).resolves.toBeUndefined();

    expect(JSON.parse(kv.store.get("knock-token:t1")?.value as string)).toMatchObject({
      accessToken: "access-new",
    });
    expect(kv.ttl("knock-token:t1")).toBeGreaterThan(90 * 24 * 60 * 60);
  });

  it("returns invalid_grant when the upstream refresh token is dead", async () => {
    await storeKnockTokens(env, "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      upstreamError(400, "invalid_grant"),
    );

    const error = await refresh(established()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toMatchObject({
      code: "invalid_grant",
      options: {
        internal: {
          category: CALLBACK_ERROR_CATEGORY,
          reason: CALLBACK_ERROR_REASON.sessionDead,
        },
      },
    });
  });

  it("returns invalid_grant when the record is missing for an established grant", async () => {
    await expect(refresh(established())).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("asks the client to retry when the upstream is unavailable", async () => {
    await storeKnockTokens(env, "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamError(502));

    await expect(refresh(established())).rejects.toMatchObject({
      code: "temporarily_unavailable",
      options: {
        statusCode: 503,
        headers: { "Retry-After": "5" },
        internal: { reason: CALLBACK_ERROR_REASON.upstreamUnavailable },
      },
    });
    expect(kv.store.has("knock-token:t1")).toBe(true);
  });

  it("asks the client to retry when a brand new grant's record is not visible yet", async () => {
    await expect(refresh(established({ issuedAt: nowSeconds() - 5 }))).rejects.toMatchObject({
      code: "temporarily_unavailable",
      options: { internal: { reason: CALLBACK_ERROR_REASON.recordNotVisible } },
    });
  });

  it("answers 503 instead of a raw 500 when KV or the lock fails, and reports it", async () => {
    vi.spyOn(kv, "get").mockRejectedValue(new Error("KV GET failed"));

    await expect(refresh(established())).rejects.toMatchObject({
      code: "temporarily_unavailable",
      options: { statusCode: 503, internal: { reason: CALLBACK_ERROR_REASON.unexpectedError } },
    });
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("ends grants older than the absolute maximum age", async () => {
    await storeKnockTokens(env, "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));

    await expect(
      refresh(established({ issuedAt: nowSeconds() - MCP_GRANT_MAX_AGE_SECONDS - 60 })),
    ).rejects.toMatchObject({
      code: "invalid_grant",
      options: { internal: { reason: CALLBACK_ERROR_REASON.maxAgeExceeded } },
    });
  });
});
