import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { ensureUpstreamSession, withKnockSessionGuard } from "./session-guard";
import { MCP_ACCESS_TOKEN_TTL_SECONDS, MCP_GRANT_TTL_SECONDS } from "./session-lifetimes";
import { createKnockEnv } from "./test/knock-env";
import { nowSeconds } from "./time";
import { buildOauthProps } from "./session-auth";
import { storeKnockTokens, type KnockTokenData } from "./token-store";
import type { MemoryKv } from "./test/memory-kv";

const ORIGIN = "https://mcp.knock.app";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = "http://localhost:3334/callback";

function staleTokens(): KnockTokenData {
  return {
    accessToken: "up-access",
    refreshToken: "up-refresh",
    expiresAt: 1,
    tokenEndpoint: "https://signin.example.com/oauth2/token",
    upstreamClientId: "up-client",
  };
}

/**
 * Drives the real OAuth provider (not a mock) with the options index.ts uses
 * for lifetimes, refresh callback and guard, over in-memory KV.
 */
function createWorld() {
  const { env, kv } = createKnockEnv();
  const mcpHandler = {
    fetch: vi.fn(async (_request: Request, _env: unknown, ctx: { props?: unknown }) =>
      Response.json({ props: ctx.props }),
    ),
  };

  const options = {
    apiRoute: "/mcp",
    apiHandler: withKnockSessionGuard(mcpHandler as never, {
      resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    }) as never,
    defaultHandler: { fetch: async () => new Response("default") } as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: MCP_GRANT_TTL_SECONDS,
    refreshTokenIdleTTL: MCP_GRANT_TTL_SECONDS,
    tokenExchangeCallback: ensureUpstreamSession,
    resourceMetadata: { resource: RESOURCE },
  };
  const provider = new OAuthProvider<Env>(options);
  const fullEnv = env as unknown as Env;

  const fetchProvider = (path: string, init?: RequestInit) =>
    provider.fetch(new Request(`${ORIGIN}${path}`, init), fullEnv, {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext);

  const tokenRequest = (params: Record<string, string>) =>
    fetchProvider("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });

  const helpers = getOAuthApi(options as never, fullEnv);

  /** Registers a client, mints a grant bound to a stale upstream record, and exchanges the code. */
  async function signIn(opts: {
    tokenId: string;
    userId?: string;
    issuedAt?: number;
    client?: { clientId: string };
  }) {
    const client =
      opts.client ??
      (await helpers.createClient({
        redirectUris: [REDIRECT_URI],
        clientName: "test",
        tokenEndpointAuthMethod: "none",
      }));
    await storeKnockTokens(env, opts.tokenId, staleTokens());

    const verifier = "v".repeat(64);
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");

    const { redirectTo } = await helpers.completeAuthorization({
      request: {
        responseType: "code",
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        scope: [],
        state: "s",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        resource: RESOURCE,
      },
      userId: opts.userId ?? "user-1",
      metadata: {},
      scope: [],
      revokeExistingGrants: false,
      props: buildOauthProps({
        tokenId: opts.tokenId,
        clientId: "up-client",
        issuedAt: opts.issuedAt ?? nowSeconds() - 3600,
        selectedGroups: ["documentation"],
      }),
    });

    const code = new URL(redirectTo).searchParams.get("code") as string;
    const response = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    return { client, tokens, status: response.status };
  }

  const refresh = (clientId: string, refreshToken: string) =>
    tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: RESOURCE,
    });

  const callMcp = (accessToken: string) =>
    fetchProvider("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: "{}",
    });

  return { env, kv, mcpHandler, signIn, refresh, callMcp };
}

describe("MCP OAuth sessions against the real provider", () => {
  let world: ReturnType<typeof createWorld>;
  let kv: MemoryKv;

  beforeEach(() => {
    world = createWorld();
    kv = world.kv;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("issues a 12 hour access token and keeps the grant alive across refreshes", async () => {
    const { client, tokens, status } = await world.signIn({ tokenId: "t1" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", refresh_token: "rot", expires_in: 3600 }),
        ),
    );

    expect(status).toBe(200);
    expect(tokens.expires_in).toBe(MCP_ACCESS_TOKEN_TTL_SECONDS);

    const refreshed = await world.refresh(client.clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { refresh_token: string };

    const again = await world.refresh(client.clientId, next.refresh_token);
    expect(again.status).toBe(200);
  });

  it("revokes the grant and answers invalid_grant when the upstream refresh token is dead", async () => {
    const { client, tokens } = await world.signIn({ tokenId: "t1" });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const response = await world.refresh(client.clientId, tokens.refresh_token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });

    const retry = await world.refresh(client.clientId, tokens.refresh_token);
    expect(await retry.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Grant not found",
    });
    expect((await world.callMcp(tokens.access_token)).status).toBe(401);
  });

  it("answers 503 with Retry-After and keeps the grant when the upstream is down", async () => {
    const { client, tokens } = await world.signIn({ tokenId: "t1" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("Bad Gateway", { status: 502 }));

    const down = await world.refresh(client.clientId, tokens.refresh_token);
    expect(down.status).toBe(503);
    expect(down.headers.get("Retry-After")).toBe("5");
    expect(await down.json()).toMatchObject({ error: "temporarily_unavailable" });

    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", refresh_token: "rot", expires_in: 3600 }),
        ),
    );
    expect((await world.refresh(client.clientId, tokens.refresh_token)).status).toBe(200);
  });

  it("serves 401 with the metadata challenge on /mcp once the upstream record is gone", async () => {
    const { tokens } = await world.signIn({ tokenId: "t1" });
    expect((await world.callMcp(tokens.access_token)).status).toBe(200);

    kv.store.delete("knock-token:t1");
    const response = await world.callMcp(tokens.access_token);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("keeps the first install signed in when the same user authorizes the same client again", async () => {
    const first = await world.signIn({ tokenId: "t1" });
    const second = await world.signIn({ tokenId: "t2", client: first.client });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", refresh_token: "rot", expires_in: 3600 }),
        ),
    );

    expect((await world.refresh(first.client.clientId, first.tokens.refresh_token)).status).toBe(
      200,
    );
    expect((await world.refresh(second.client.clientId, second.tokens.refresh_token)).status).toBe(
      200,
    );
  });
});
