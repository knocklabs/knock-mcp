import { describe, expect, it } from "vitest";

import { getOrRefreshKnockToken, resolveKnockAccessToken, storeKnockTokens } from "./token-store";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

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

    await expect(resolveKnockAccessToken(env, { tokenId: "oauth-1" })).resolves.toBe("oauth-access");
  });

  it("throws when neither service token nor tokenId is present", async () => {
    const kv = memoryKv();
    await expect(
      resolveKnockAccessToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, {}),
    ).rejects.toThrow("MCP session missing Knock credentials");
  });
});

describe("getOrRefreshKnockToken", () => {
  it("throws when the OAuth session is missing", async () => {
    const kv = memoryKv();
    await expect(
      getOrRefreshKnockToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, "missing"),
    ).rejects.toThrow("Knock session not found");
  });
});
