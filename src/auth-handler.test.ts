import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { AuthHandler } from "./auth-handler";
import { createMemoryKv, type MemoryKv } from "./test/memory-kv";
import { nowSeconds } from "./time";
import { storePendingKnockTokens } from "./token-store";

const CSRF = "csrf-token";

function setup(sessionOverrides: Record<string, unknown> = {}) {
  const kv: MemoryKv = createMemoryKv();
  const completeAuthorization = vi.fn(async () => ({ redirectTo: "http://localhost/cb?code=abc" }));
  const env = {
    OAUTH_KV: kv,
    COOKIE_ENCRYPTION_KEY: "key",
    OAUTH_PROVIDER: {
      lookupClient: vi.fn(async () => ({ clientName: "Cursor" })),
      completeAuthorization,
    },
  };

  const session = {
    tokenId: "t1",
    userId: "user-1",
    email: "a@example.com",
    clientId: "up-client",
    oauthReqInfo: { clientId: "mcp-client" },
    ...sessionOverrides,
  };
  const ready = async () => {
    await storePendingKnockTokens(env as never, "t1", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: nowSeconds() + 3600,
      tokenEndpoint: "https://signin.example.com/oauth2/token",
      upstreamClientId: "up-client",
    });
    await kv.put("tool-auth:s1", JSON.stringify(session), { expirationTtl: 300 });
  };

  const authorizeTools = () =>
    AuthHandler.request(
      "https://mcp.knock.app/api/authorize-tools",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `knock_tool_csrf=${CSRF}` },
        body: JSON.stringify({ session: "s1", csrfToken: CSRF, selectedGroups: [] }),
      },
      env as never,
    );

  return { kv, env, completeAuthorization, ready, authorizeTools };
}

describe("POST /api/authorize-tools", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("creates a per-device grant keyed by the Knock user and activates the upstream record", async () => {
    const { kv, completeAuthorization, ready, authorizeTools } = setup();
    await ready();
    expect(kv.ttl("knock-token:t1")).toBeLessThanOrEqual(15 * 60);

    const response = await authorizeTools();

    expect(response.status).toBe(200);
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        revokeExistingGrants: false,
        props: expect.objectContaining({
          tokenId: "t1",
          clientId: "up-client",
          issuedAt: expect.any(Number),
        }),
      }),
    );
    expect(kv.ttl("knock-token:t1")).toBeGreaterThan(90 * 24 * 60 * 60);
  });

  it("refuses to authorize a session that has no user id instead of using a shared placeholder", async () => {
    const { completeAuthorization, ready, authorizeTools } = setup({ userId: undefined });
    await ready();

    const response = await authorizeTools();

    expect(response.status).toBe(400);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
