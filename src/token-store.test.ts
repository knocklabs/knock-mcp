import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock("@sentry/cloudflare", () => ({ captureMessage }));

import {
  KnockSessionError,
  getOrRefreshKnockToken,
  hasKnockTokens,
  storeKnockTokens,
  type KnockTokenData,
} from "./token-store";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

type Kv = ReturnType<typeof memoryKv>;
const envFor = (kv: Kv) => ({ OAUTH_KV: kv }) as unknown as Pick<Env, "OAUTH_KV">;

const nowSeconds = () => Math.floor(Date.now() / 1000);

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

function upstreamOk(body: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
      ...body,
    }),
    { status: 200 },
  );
}

function upstreamError(status: number, error?: string) {
  return new Response(error ? JSON.stringify({ error }) : "Bad Gateway", { status });
}

describe("getOrRefreshKnockToken", () => {
  let kv: Kv;

  beforeEach(() => {
    kv = memoryKv();
    captureMessage.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws a missing error when the OAuth session is missing", async () => {
    await expect(getOrRefreshKnockToken(envFor(kv), "missing")).rejects.toMatchObject({
      kind: "missing",
      message: expect.stringContaining("Knock session not found"),
    });
  });

  it("returns the stored access token while it is fresh", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).resolves.toBe("access-old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-writes a fresh record to renew its KV expiry only when asked", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));
    const putSpy = vi.spyOn(kv, "put");

    await getOrRefreshKnockToken(envFor(kv), "t1");
    expect(putSpy).not.toHaveBeenCalled();

    await getOrRefreshKnockToken(envFor(kv), "t1", { renewTtl: true });
    expect(putSpy).toHaveBeenCalledOnce();
  });

  it("refreshes an expired token and persists the rotated refresh token", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(upstreamOk());

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).resolves.toBe("access-new");

    const stored = JSON.parse(kv.store.get("knock-token:t1") as string) as KnockTokenData;
    expect(stored).toMatchObject({ accessToken: "access-new", refreshToken: "refresh-new" });
  });

  it("shares one upstream refresh between concurrent callers", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return upstreamOk();
    });

    const results = await Promise.all([
      getOrRefreshKnockToken(envFor(kv), "t1"),
      getOrRefreshKnockToken(envFor(kv), "t1"),
      getOrRefreshKnockToken(envFor(kv), "t1"),
    ]);

    expect(results).toEqual(["access-new", "access-new", "access-new"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws a terminal error and drops the record when upstream rejects the refresh token", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => upstreamError(400, "invalid_grant"));

    const error = await getOrRefreshKnockToken(envFor(kv), "t1").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KnockSessionError);
    expect(error).toMatchObject({ kind: "terminal" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await hasKnockTokens(envFor(kv), "t1")).toBe(false);
    expect(captureMessage).toHaveBeenCalledWith(
      "Knock token refresh failed",
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("uses the record another isolate rotated instead of failing", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await storeKnockTokens(
        envFor(kv),
        "t1",
        tokenData({
          accessToken: "access-rotated",
          refreshToken: "refresh-rotated",
          expiresAt: nowSeconds() + 3600,
        }),
      );
      return upstreamError(400, "invalid_grant");
    });

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).resolves.toBe("access-rotated");
    expect(await hasKnockTokens(envFor(kv), "t1")).toBe(true);
  });

  it("retries a transient failure once and keeps the record on repeated failure", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => upstreamError(502));

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).rejects.toMatchObject({
      kind: "transient",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await hasKnockTokens(envFor(kv), "t1")).toBe(true);
  });

  it("recovers when the retry after a transient failure succeeds", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(upstreamError(503))
      .mockResolvedValueOnce(upstreamOk());

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).resolves.toBe("access-new");
  });

  it("treats a network error as transient", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData());
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).rejects.toMatchObject({
      kind: "transient",
    });
    expect(await hasKnockTokens(envFor(kv), "t1")).toBe(true);
  });

  it("throws a terminal error when no refresh token was issued", async () => {
    await storeKnockTokens(envFor(kv), "t1", tokenData({ refreshToken: null }));

    await expect(getOrRefreshKnockToken(envFor(kv), "t1")).rejects.toMatchObject({
      kind: "terminal",
    });
  });
});
