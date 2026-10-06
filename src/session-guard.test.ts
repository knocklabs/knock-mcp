import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthError: class OAuthError extends Error {
    constructor(
      readonly code: string,
      readonly options: {
        description: string;
        statusCode?: number;
        headers?: Record<string, string>;
      },
    ) {
      super(options.description);
    }
  },
}));

const getOrRefreshKnockToken = vi.hoisted(() => vi.fn());
const hasKnockTokens = vi.hoisted(() => vi.fn());

vi.mock("./token-store", async () => {
  const actual = await vi.importActual<typeof import("./token-store")>("./token-store");
  return { ...actual, getOrRefreshKnockToken, hasKnockTokens };
});

import { ensureUpstreamSession, withKnockSessionGuard } from "./session-guard";
import { KnockSessionError } from "./token-store";

const nowSeconds = () => Math.floor(Date.now() / 1000);

const env = { OAUTH_KV: {} } as unknown as Env;

function guardedFetch(props: Record<string, unknown> | undefined) {
  const inner = { fetch: vi.fn(async () => new Response("mcp-ok")) };
  const guarded = withKnockSessionGuard(inner);
  const request = new Request("https://mcp.knock.app/mcp", { method: "POST" });
  const ctx = { props } as unknown as ExecutionContext;
  return { inner, run: () => guarded.fetch(request, env, ctx) };
}

describe("withKnockSessionGuard", () => {
  beforeEach(() => {
    hasKnockTokens.mockReset();
  });

  it("forwards the request when the upstream session exists", async () => {
    hasKnockTokens.mockResolvedValue(true);
    const { inner, run } = guardedFetch({ tokenId: "t1", issuedAt: nowSeconds() - 3600 });

    const response = await run();

    expect(await response.text()).toBe("mcp-ok");
    expect(inner.fetch).toHaveBeenCalledOnce();
  });

  it("answers 401 with an invalid_token challenge when the upstream session is gone", async () => {
    hasKnockTokens.mockResolvedValue(false);
    const { inner, run } = guardedFetch({ tokenId: "t1", issuedAt: nowSeconds() - 3600 });

    const response = await run();

    expect(response.status).toBe(401);
    const challenge = response.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      'resource_metadata="https://mcp.knock.app/.well-known/oauth-protected-resource/mcp"',
    );
    expect(await response.json()).toMatchObject({ error: "invalid_token" });
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("answers 401 for legacy grants that predate issuedAt", async () => {
    hasKnockTokens.mockResolvedValue(false);
    const { run } = guardedFetch({ tokenId: "t1" });

    expect((await run()).status).toBe(401);
  });

  it("lets a just-issued grant through while KV may still be catching up", async () => {
    hasKnockTokens.mockResolvedValue(false);
    const { inner, run } = guardedFetch({ tokenId: "t1", issuedAt: nowSeconds() - 5 });

    await run();

    expect(inner.fetch).toHaveBeenCalledOnce();
  });

  it("does not check KV for service-token sessions", async () => {
    const { inner, run } = guardedFetch({ serviceToken: "knock_st_abc" });

    await run();

    expect(hasKnockTokens).not.toHaveBeenCalled();
    expect(inner.fetch).toHaveBeenCalledOnce();
  });
});

describe("ensureUpstreamSession", () => {
  const refreshOptions = (props: Record<string, unknown>) =>
    ({
      grantType: "refresh_token",
      env,
      props,
    }) as unknown as Parameters<typeof ensureUpstreamSession>[0];

  beforeEach(() => {
    getOrRefreshKnockToken.mockReset();
  });

  it("ignores authorization code exchanges", async () => {
    await ensureUpstreamSession({
      ...refreshOptions({ tokenId: "t1" }),
      grantType: "authorization_code",
    } as unknown as Parameters<typeof ensureUpstreamSession>[0]);

    expect(getOrRefreshKnockToken).not.toHaveBeenCalled();
  });

  it("ignores service-token sessions", async () => {
    await ensureUpstreamSession(refreshOptions({ serviceToken: "knock_st_abc" }));

    expect(getOrRefreshKnockToken).not.toHaveBeenCalled();
  });

  it("allows the refresh and renews the record when the upstream session is healthy", async () => {
    getOrRefreshKnockToken.mockResolvedValue("access");

    await expect(ensureUpstreamSession(refreshOptions({ tokenId: "t1" }))).resolves.toBeUndefined();
    expect(getOrRefreshKnockToken).toHaveBeenCalledWith(env, "t1", { renewTtl: true });
  });

  it("returns invalid_grant (which revokes the grant) when the upstream refresh is terminal", async () => {
    getOrRefreshKnockToken.mockRejectedValue(new KnockSessionError("terminal", "dead"));

    await expect(ensureUpstreamSession(refreshOptions({ tokenId: "t1" }))).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("returns invalid_grant when the upstream record is missing for an established grant", async () => {
    getOrRefreshKnockToken.mockRejectedValue(new KnockSessionError("missing", "gone"));

    await expect(
      ensureUpstreamSession(refreshOptions({ tokenId: "t1", issuedAt: nowSeconds() - 3600 })),
    ).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("asks the client to retry on transient upstream failures", async () => {
    getOrRefreshKnockToken.mockRejectedValue(new KnockSessionError("transient", "later"));

    await expect(ensureUpstreamSession(refreshOptions({ tokenId: "t1" }))).rejects.toMatchObject({
      code: "temporarily_unavailable",
      options: { statusCode: 503, headers: { "Retry-After": "5" } },
    });
  });

  it("asks the client to retry when a brand new grant's record is not visible yet", async () => {
    getOrRefreshKnockToken.mockRejectedValue(new KnockSessionError("missing", "gone"));

    await expect(
      ensureUpstreamSession(refreshOptions({ tokenId: "t1", issuedAt: nowSeconds() - 5 })),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });

  it("rethrows unexpected errors", async () => {
    getOrRefreshKnockToken.mockRejectedValue(new Error("boom"));

    await expect(ensureUpstreamSession(refreshOptions({ tokenId: "t1" }))).rejects.toThrow("boom");
  });
});
