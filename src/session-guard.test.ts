import { OAuthError } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { ensureUpstreamSession, withKnockSessionGuard } from "./session-guard";
import { MCP_GRANT_MAX_AGE_SECONDS } from "./session-lifetimes";
import { createKnockEnv } from "./test/knock-env";
import { nowSeconds } from "./time";
import { storeKnockTokens, type KnockTokenData } from "./token-store";
import type { Props } from "./types";

const RESOURCE_METADATA_URL = "https://mcp.knock.app/.well-known/oauth-protected-resource/mcp";

function tokenData(overrides: Partial<KnockTokenData> = {}): KnockTokenData {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: nowSeconds() - 10,
    tokenEndpoint: "https://signin.example.com/oauth2/token",
    upstreamClientId: "client_upstream",
    ...overrides,
  };
}

const upstreamOk = () =>
  new Response(
    JSON.stringify({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }),
    { status: 200 },
  );

const upstreamError = (status: number, error?: string) =>
  new Response(error ? JSON.stringify({ error }) : "Bad Gateway", { status });

const established = (overrides: Partial<Props> = {}): Props => ({
  tokenId: "t1",
  clientId: "client_upstream",
  issuedAt: nowSeconds() - 3600,
  ...overrides,
});

describe("session guard and refresh callback against the real token store", () => {
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
        guard.fetch(
          request,
          env as unknown as Env,
          { props } as unknown as ExecutionContext<Props | undefined>,
        ),
    };
  }

  const refresh = (props: Props) =>
    ensureUpstreamSession({
      grantType: "refresh_token",
      props,
      env: env as unknown as Env,
    } as unknown as Parameters<typeof ensureUpstreamSession>[0]);

  describe("withKnockSessionGuard", () => {
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

    it("turns a dead upstream session into a 401 on the next request", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        upstreamError(400, "invalid_grant"),
      );
      await expect(refresh(established())).rejects.toMatchObject({ code: "invalid_grant" });

      const { inner, run } = guarded(established());

      expect((await run()).status).toBe(401);
      expect(inner.fetch).not.toHaveBeenCalled();
    });
  });

  describe("ensureUpstreamSession", () => {
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
        options: { internal: { reason: "upstream_session_dead" } },
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
          internal: { reason: "upstream_unavailable" },
        },
      });
      expect(kv.store.has("knock-token:t1")).toBe(true);
    });

    it("asks the client to retry when a brand new grant's record is not visible yet", async () => {
      await expect(refresh(established({ issuedAt: nowSeconds() - 5 }))).rejects.toMatchObject({
        code: "temporarily_unavailable",
      });
    });

    it("ends grants older than the absolute maximum age", async () => {
      await storeKnockTokens(env, "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));

      await expect(
        refresh(established({ issuedAt: nowSeconds() - MCP_GRANT_MAX_AGE_SECONDS - 60 })),
      ).rejects.toMatchObject({
        code: "invalid_grant",
        options: { internal: { reason: "grant_max_age_exceeded" } },
      });
    });
  });
});
