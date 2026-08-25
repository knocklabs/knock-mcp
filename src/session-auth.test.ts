import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MISSING_SESSION_CREDENTIALS,
  applySessionSentryContext,
  buildOauthProps,
  buildServiceTokenProps,
  requireSessionAuth,
  resolveKnockAccessToken,
  sessionAuthFromProps,
  sessionAuthKind,
} from "./session-auth";
import { storeKnockTokens } from "./token-store";
import { allToolGroupKeys } from "./tool-groups";
import { SERVICE_TOKEN_CLIENT_ID } from "./types";

vi.mock("@sentry/cloudflare", () => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
}));

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("sessionAuthFromProps", () => {
  it("prefers a service token over tokenId", () => {
    expect(sessionAuthFromProps({ serviceToken: "knock_st_direct", tokenId: "oauth-1" })).toEqual({
      kind: "service_token",
      serviceToken: "knock_st_direct",
    });
  });

  it("reads an OAuth tokenId", () => {
    expect(sessionAuthFromProps({ tokenId: "oauth-1" })).toEqual({
      kind: "oauth",
      tokenId: "oauth-1",
    });
  });

  it("returns null when neither credential is present", () => {
    expect(sessionAuthFromProps({})).toBeNull();
    expect(sessionAuthFromProps(undefined)).toBeNull();
  });
});

describe("requireSessionAuth", () => {
  it("throws the shared missing-credentials error", () => {
    expect(() => requireSessionAuth({})).toThrow(MISSING_SESSION_CREDENTIALS);
  });
});

describe("sessionAuthKind", () => {
  it("defaults omitted authKind to oauth", () => {
    expect(sessionAuthKind({})).toBe("oauth");
    expect(sessionAuthKind({ authKind: "service_token" })).toBe("service_token");
  });

  it("derives service_token from the credential even when authKind is omitted", () => {
    expect(sessionAuthKind({ serviceToken: "knock_st_direct" })).toBe("service_token");
  });
});

describe("buildOauthProps", () => {
  it("omits optional consent fields when they are unset", () => {
    expect(
      buildOauthProps({
        tokenId: "oauth-1",
        clientId: "client-1",
        selectedGroups: ["documentation"],
      }),
    ).toEqual({
      tokenId: "oauth-1",
      clientId: "client-1",
      userId: undefined,
      email: undefined,
      selectedGroups: ["documentation"],
    });
  });
});

describe("buildServiceTokenProps", () => {
  it("enables every tool group with read/write Management API access", () => {
    expect(buildServiceTokenProps("knock_st_secret")).toEqual({
      authKind: "service_token",
      serviceToken: "knock_st_secret",
      clientId: SERVICE_TOKEN_CLIENT_ID,
      selectedGroups: allToolGroupKeys(),
      mapiAccessMode: "read_write",
    });
  });

  it("includes whoami account identity when provided", () => {
    expect(
      buildServiceTokenProps("knock_st_secret", {
        accountSlug: "acme",
        accountName: "Acme",
        serviceTokenName: "CI",
      }),
    ).toMatchObject({
      accountSlug: "acme",
      accountName: "Acme",
    });
  });
});

describe("resolveKnockAccessToken", () => {
  it("returns a service token without touching KV", async () => {
    const kv = memoryKv();
    const token = await resolveKnockAccessToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, {
      serviceToken: "knock_st_direct",
    });
    expect(token).toBe("knock_st_direct");
  });

  it("prefers a service token over tokenId", async () => {
    const kv = memoryKv();
    const token = await resolveKnockAccessToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, {
      serviceToken: "knock_st_direct",
      tokenId: "should-not-be-used",
    });
    expect(token).toBe("knock_st_direct");
  });

  it("refreshes OAuth tokens via tokenId when no service token is set", async () => {
    const kv = memoryKv();
    const env = { OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">;
    await storeKnockTokens(env, "oauth-1", {
      accessToken: "oauth-access",
      refreshToken: "refresh",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      tokenEndpoint: "https://auth.example/token",
      upstreamClientId: "client-1",
    });

    await expect(resolveKnockAccessToken(env, { tokenId: "oauth-1" })).resolves.toBe(
      "oauth-access",
    );
  });

  it("throws when neither service token nor tokenId is present", async () => {
    const kv = memoryKv();
    await expect(
      resolveKnockAccessToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, {}),
    ).rejects.toThrow(MISSING_SESSION_CREDENTIALS);
  });
});

describe("applySessionSentryContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tags oauth sessions with user id and default auth kind", async () => {
    const Sentry = await import("@sentry/cloudflare");
    applySessionSentryContext({
      tokenId: "oauth-1",
      clientId: "client-1",
      userId: "user-1",
      email: "dev@example.com",
    });

    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "user-1", email: "dev@example.com" });
    expect(Sentry.setTag).toHaveBeenCalledWith("knock.client_id", "client-1");
    expect(Sentry.setTag).toHaveBeenCalledWith("knock.auth_kind", "oauth");
  });

  it("tags service-token sessions with account identity", async () => {
    const Sentry = await import("@sentry/cloudflare");
    applySessionSentryContext({
      authKind: "service_token",
      serviceToken: "knock_st_secret",
      clientId: SERVICE_TOKEN_CLIENT_ID,
      accountSlug: "acme",
    });

    expect(Sentry.setUser).toHaveBeenCalledWith({ id: "acme", email: undefined });
    expect(Sentry.setTag).toHaveBeenCalledWith("knock.auth_kind", "service_token");
    expect(Sentry.setTag).toHaveBeenCalledWith("knock.account_slug", "acme");
  });
});
