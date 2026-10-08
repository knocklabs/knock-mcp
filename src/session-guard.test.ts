import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn() }));

import { withKnockSessionGuard } from "./session-guard";
import { createKnockEnv } from "./test/knock-env";
import { tokenData, upstreamError } from "./test/token-fixtures";
import { nowSeconds } from "./time";
import { ensureUpstreamSession } from "./token-exchange-callback";
import { storeKnockTokens } from "./token-store";
import type { Props } from "./types";

const RESOURCE_METADATA_URL = "https://mcp.knock.app/.well-known/oauth-protected-resource/mcp";

const established = (overrides: Partial<Props> = {}): Props => ({
  tokenId: "t1",
  clientId: "client_upstream",
  issuedAt: nowSeconds() - 3600,
  ...overrides,
});

describe("withKnockSessionGuard", () => {
  let { env, kv } = createKnockEnv();

  beforeEach(() => {
    ({ env, kv } = createKnockEnv());
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  function guarded(props: Props | undefined) {
    const inner = { fetch: vi.fn(async () => new Response("mcp-ok")) };
    const guard = withKnockSessionGuard(inner, { resourceMetadataUrl: RESOURCE_METADATA_URL });
    const request = new Request("https://mcp.knock.app/mcp", { method: "POST" });
    return {
      inner,
      run: () =>
        guard.fetch(request, env, { props } as unknown as ExecutionContext<Props | undefined>),
    };
  }

  it("forwards the request when the upstream session exists", async () => {
    await storeKnockTokens(env, "t1", tokenData());
    const { inner, run } = guarded(established());

    expect(await (await run()).text()).toBe("mcp-ok");
    expect(inner.fetch).toHaveBeenCalledOnce();
  });

  it("answers 401 with an invalid_token challenge naming the canonical metadata URL", async () => {
    const { inner, run } = guarded(established());

    const response = await run();

    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA_URL}"`);
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("answers 401 for legacy grants that predate issuedAt", async () => {
    const { run } = guarded({ tokenId: "t1", clientId: "c" });

    expect((await run()).status).toBe(401);
  });

  it("lets a just-issued grant through while KV may still be catching up", async () => {
    const { inner, run } = guarded(established({ issuedAt: nowSeconds() - 5 }));

    await run();

    expect(inner.fetch).toHaveBeenCalledOnce();
  });

  it("does not check KV for service-token sessions", async () => {
    const getSpy = vi.spyOn(kv, "get");
    const { inner, run } = guarded({ serviceToken: "knock_st_abc", clientId: "c" });

    await run();

    expect(getSpy).not.toHaveBeenCalled();
    expect(inner.fetch).toHaveBeenCalledOnce();
  });

  it("never writes to KV, even for an unreadable record", async () => {
    kv.store.set("knock-token:t1", { value: "{not json" });
    const putSpy = vi.spyOn(kv, "put");
    const deleteSpy = vi.spyOn(kv, "delete");

    expect((await guarded(established()).run()).status).toBe(401);
    expect(putSpy).not.toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("turns a dead upstream session into a 401 on the next request", async () => {
    await storeKnockTokens(env, "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      upstreamError(400, "invalid_grant"),
    );
    await expect(
      ensureUpstreamSession({ grantType: "refresh_token", props: established(), env } as never),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const { inner, run } = guarded(established());

    expect((await run()).status).toBe(401);
    expect(inner.fetch).not.toHaveBeenCalled();
  });
});
