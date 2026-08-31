import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "./sha256";
import {
  SERVICE_TOKEN_CLIENT_ID,
  buildServiceTokenProps,
  isKnockServiceToken,
  parseWhoamiIdentity,
  resolveKnockServiceToken,
} from "./service-token";
import { allToolGroupKeys } from "./tool-groups";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

function testEnv(kv = memoryKv()) {
  return {
    kv,
    env: {
      OAUTH_KV: kv,
      KNOCK_CONTROL_URL: "https://control.knock.app/",
    },
  };
}

const whoamiBody = {
  type: "service_token",
  account_slug: "acme",
  account_name: "Acme",
  service_token_name: "CI",
  account_features: {},
};

describe("isKnockServiceToken", () => {
  it("accepts the knock_st_ prefix", () => {
    expect(isKnockServiceToken("knock_st_abc")).toBe(true);
  });

  it("rejects other bearer credentials", () => {
    expect(isKnockServiceToken("st_abc")).toBe(false);
    expect(isKnockServiceToken("sk_test_abc")).toBe(false);
    expect(isKnockServiceToken("eyJhbGciOiJIUzI1NiJ9.e30.x")).toBe(false);
  });
});

describe("parseWhoamiIdentity", () => {
  it("reads account identity from a service-token whoami payload", () => {
    expect(parseWhoamiIdentity(whoamiBody)).toEqual({
      accountSlug: "acme",
      accountName: "Acme",
    });
  });

  it("rejects oauth_context payloads", () => {
    expect(parseWhoamiIdentity({ ...whoamiBody, type: "oauth_context" })).toBeNull();
  });

  it("rejects payloads without type service_token", () => {
    expect(parseWhoamiIdentity({ account_slug: "acme", account_name: "Acme" })).toBeNull();
  });

  it("rejects payloads without an account slug", () => {
    expect(parseWhoamiIdentity({ type: "service_token", account_name: "Acme" })).toBeNull();
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
      }),
    ).toMatchObject({
      accountSlug: "acme",
      accountName: "Acme",
    });
  });
});

describe("resolveKnockServiceToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for non-service-token bearers without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("not-a-service-token", env)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when Management API rejects the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_revoked", env)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.knock.app/v1/whoami",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer knock_st_revoked",
          "x-knock-client-id": SERVICE_TOKEN_CLIENT_ID,
        }),
      }),
    );
  });

  it("returns service-token props when whoami accepts the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(whoamiBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { env, kv } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).resolves.toEqual({
      props: buildServiceTokenProps("knock_st_valid", {
        accountSlug: "acme",
        accountName: "Acme",
      }),
    });

    const cacheKey = `service-token-identity:v2:${await sha256Hex("knock_st_valid")}`;
    expect(JSON.parse(kv.store.get(cacheKey) ?? "null")).toEqual({
      accountSlug: "acme",
      accountName: "Acme",
    });
  });

  it("reuses the identity cache and does not re-probe Management API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(whoamiBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { env } = testEnv();

    await resolveKnockServiceToken("knock_st_cached", env);
    await expect(resolveKnockServiceToken("knock_st_cached", env)).resolves.toEqual({
      props: buildServiceTokenProps("knock_st_cached", {
        accountSlug: "acme",
        accountName: "Acme",
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on Management API server errors so clients do not start OAuth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 503 })));
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).rejects.toThrow(
      "Knock service token validation failed (503)",
    );
  });

  it("throws on rate limits so clients retry instead of starting OAuth", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).rejects.toThrow(
      "Knock service token validation failed (429)",
    );
  });

  it("throws when whoami returns a non-JSON 200 so clients do not start OAuth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>ok</html>", { status: 200 })),
    );
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).rejects.toThrow(
      "Knock service token validation failed (invalid whoami body)",
    );
  });

  it("returns null when whoami is an oauth_context payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...whoamiBody, type: "oauth_context" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).resolves.toBeNull();
  });

  it("throws when a service_token whoami payload is missing an account slug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ type: "service_token", account_name: "Acme" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { env } = testEnv();

    await expect(resolveKnockServiceToken("knock_st_valid", env)).rejects.toThrow(
      "Knock service token validation failed (incomplete whoami identity)",
    );
  });
});
