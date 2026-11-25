import { afterEach, describe, expect, it, vi } from "vitest";

import { withKeepAlive } from "./keep-alive";
import { getOrRefreshKnockToken, storeKnockTokens } from "./token-store";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("getOrRefreshKnockToken", () => {
  it("throws when the OAuth session is missing", async () => {
    const kv = memoryKv();
    await expect(
      getOrRefreshKnockToken({ OAUTH_KV: kv } as Pick<Env, "OAUTH_KV">, "missing"),
    ).rejects.toThrow("Knock session not found");
  });

  const expired = {
    accessToken: "old",
    refreshToken: "refresh-1",
    expiresAt: 0,
    tokenEndpoint: "https://auth.knock.test/token",
    upstreamClientId: "client",
  };
  const refreshed = () =>
    Response.json({ access_token: "new", refresh_token: "refresh-2", expires_in: 3600 });

  async function setUp() {
    const kv = memoryKv();
    const env = { OAUTH_KV: kv } as unknown as Pick<Env, "OAUTH_KV">;
    await storeKnockTokens(env, "t", expired);
    return { env, kv };
  }

  it("keeps a refresh alive until its result is stored", async () => {
    const { env, kv } = await setUp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refreshed()),
    );
    const kept: Promise<unknown>[] = [];
    void withKeepAlive(
      (promise) => kept.push(promise),
      () => getOrRefreshKnockToken(env, "t"),
    );
    await vi.waitFor(() => expect(kept).toHaveLength(1));
    await Promise.all(kept);
    expect(JSON.parse((await kv.get("knock-token:t")) as string)).toMatchObject({
      accessToken: "new",
      refreshToken: "refresh-2",
    });
  });

  it("uses the token a parallel request refreshed first", async () => {
    const { env } = await setUp();
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++refreshes === 1 ? refreshed() : new Response("invalid_grant", { status: 400 }),
      ),
    );
    expect(
      await Promise.all([getOrRefreshKnockToken(env, "t"), getOrRefreshKnockToken(env, "t")]),
    ).toEqual(["new", "new"]);
  });

  it("asks for a new sign-in when a refresh fails and nothing newer is stored", async () => {
    const { env } = await setUp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    await expect(getOrRefreshKnockToken(env, "t")).rejects.toThrow("Please re-authenticate");
  });
});
