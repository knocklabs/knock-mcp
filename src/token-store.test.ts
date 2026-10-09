import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMessage = vi.hoisted(() => vi.fn());
vi.mock("@sentry/cloudflare", () => ({ captureMessage }));

import { createKnockEnv } from "./test/knock-env";
import { tokenData, upstreamError, upstreamOk } from "./test/token-fixtures";
import { nowSeconds } from "./time";
import {
  KnockSessionError,
  activateKnockTokens,
  decideFailure,
  getOrRefreshKnockToken,
  hasKnockTokens,
  refreshKnockSession,
  storeKnockTokens,
  storePendingKnockTokens,
  type KnockTokenData,
} from "./token-store";

const DAY = 24 * 60 * 60;

function storedRecord(kv: { store: Map<string, { value: string }> }, tokenId: string) {
  const entry = kv.store.get(`knock-token:${tokenId}`);
  return entry ? (JSON.parse(entry.value) as KnockTokenData) : undefined;
}

/** Lets the refresh retry delay elapse without waiting for it. */
async function run<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  const result = await settled;
  if ("error" in result) throw result.error;
  return result.value;
}

describe("knock token store", () => {
  let { env, kv } = createKnockEnv();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    ({ env, kv } = createKnockEnv());
    captureMessage.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("getOrRefreshKnockToken", () => {
    it("throws a missing error when the OAuth session is missing", async () => {
      await expect(getOrRefreshKnockToken(env, "missing")).rejects.toMatchObject({
        kind: "missing",
        message: expect.stringContaining("Knock session not found"),
      });
    });

    it("serves a fresh token from KV without calling the upstream or the lock", async () => {
      await storeKnockTokens(env, "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const getLock = vi.spyOn(env.KNOCK_TOKEN_LOCK, "get");

      await expect(getOrRefreshKnockToken(env, "t1")).resolves.toBe("access-old");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getLock).not.toHaveBeenCalled();
    });

    it("refreshes a stale token and persists the rotated refresh token", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamOk());

      await expect(getOrRefreshKnockToken(env, "t1")).resolves.toBe("access-new");
      expect(storedRecord(kv, "t1")).toMatchObject({
        accessToken: "access-new",
        refreshToken: "refresh-new",
      });
    });

    it("runs concurrent refreshes one at a time so the rotated token is used once", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      const usedRefreshTokens: string[] = [];
      let release: () => void = () => {};
      const upstreamGate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const body = new URLSearchParams((init as RequestInit).body as URLSearchParams);
        usedRefreshTokens.push(body.get("refresh_token") as string);
        await upstreamGate;
        return upstreamOk();
      });

      const results = Promise.all([
        getOrRefreshKnockToken(env, "t1"),
        getOrRefreshKnockToken(env, "t1"),
        getOrRefreshKnockToken(env, "t1"),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      release();

      expect(await results).toEqual(["access-new", "access-new", "access-new"]);
      expect(usedRefreshTokens).toEqual(["refresh-old"]);
    });

    it("throws a terminal error and drops the record when the upstream says invalid_grant", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => upstreamError(400, "invalid_grant"));

      const error = await getOrRefreshKnockToken(env, "t1").catch((e: unknown) => e);

      expect(error).toBeInstanceOf(KnockSessionError);
      expect(error).toMatchObject({ kind: "terminal" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await hasKnockTokens(env, "t1")).toBe(false);
    });

    it("reports upstream failures from the caller, where Sentry is available", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        upstreamError(400, "invalid_grant"),
      );
      await getOrRefreshKnockToken(env, "t1").catch(() => undefined);

      expect(captureMessage).toHaveBeenCalledWith(
        "Knock token refresh failed",
        expect.objectContaining({
          level: "warning",
          tags: { "knock.refresh_failure": "terminal" },
        }),
      );
    });

    it("never deletes the record for errors on the shared upstream client, and alerts loudly", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        upstreamError(401, "invalid_client"),
      );

      await expect(run(getOrRefreshKnockToken(env, "t1"))).rejects.toMatchObject({
        kind: "transient",
      });
      expect(await hasKnockTokens(env, "t1")).toBe(true);
      expect(captureMessage).toHaveBeenCalledWith(
        "Knock token refresh failed",
        expect.objectContaining({
          level: "error",
          tags: { "knock.refresh_failure": "client_error" },
        }),
      );
    });

    it("retries a transient failure once and keeps the record", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => upstreamError(502));

      await expect(run(getOrRefreshKnockToken(env, "t1"))).rejects.toMatchObject({
        kind: "transient",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await hasKnockTokens(env, "t1")).toBe(true);
    });

    it("recovers when the retry after a transient failure succeeds", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch")
        .mockImplementationOnce(async () => upstreamError(503))
        .mockImplementationOnce(async () => upstreamOk());

      await expect(run(getOrRefreshKnockToken(env, "t1"))).resolves.toBe("access-new");
    });

    it("treats a network error as transient", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));

      await expect(run(getOrRefreshKnockToken(env, "t1"))).rejects.toMatchObject({
        kind: "transient",
      });
      expect(await hasKnockTokens(env, "t1")).toBe(true);
    });

    it("renews the record's KV expiry on request even when the token is fresh", async () => {
      await storeKnockTokens(env, "t1", tokenData({ expiresAt: nowSeconds() + 3600 }), 1000);
      expect(kv.ttl("knock-token:t1")).toBeLessThanOrEqual(1000);

      await getOrRefreshKnockToken(env, "t1", { renewTtl: true });

      expect(kv.ttl("knock-token:t1")).toBeGreaterThan(90 * DAY);
    });

    it("reports a rotated record that could not be saved while still returning the token", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamOk());
      kv.failPuts = 3;

      await expect(getOrRefreshKnockToken(env, "t1")).resolves.toBe("access-new");
      expect(captureMessage).toHaveBeenCalledWith(
        "Failed to persist rotated Knock tokens",
        expect.objectContaining({ level: "error" }),
      );
    });
  });

  describe("refreshKnockSession", () => {
    it("drops a stale record that has no refresh token", async () => {
      await storeKnockTokens(env, "t1", tokenData({ refreshToken: null }));

      await expect(refreshKnockSession(env, "t1")).resolves.toEqual({
        ok: false,
        kind: "terminal",
      });
      expect(await hasKnockTokens(env, "t1")).toBe(false);
    });

    it("treats an unreadable record as missing", async () => {
      kv.store.set("knock-token:t1", { value: "{not json" });
      kv.store.set("knock-token:t2", { value: JSON.stringify({ accessToken: 5 }) });

      await expect(refreshKnockSession(env, "t1")).resolves.toEqual({ ok: false, kind: "missing" });
      await expect(refreshKnockSession(env, "t2")).resolves.toEqual({ ok: false, kind: "missing" });
    });

    it("remembers when upstream failures started and clears it after a success", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => upstreamError(503));

      await run(refreshKnockSession(env, "t1"));
      expect(storedRecord(kv, "t1")?.failingSince).toBeCloseTo(nowSeconds(), -1);

      fetchMock.mockImplementation(async () => upstreamOk());
      await expect(refreshKnockSession(env, "t1")).resolves.toMatchObject({ ok: true });
      expect(storedRecord(kv, "t1")?.failingSince).toBeUndefined();
    });

    it("declares the session dead after a full day of upstream failures", async () => {
      await storeKnockTokens(env, "t1", tokenData({ failingSince: nowSeconds() - DAY - 60 }));
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        upstreamError(400, "invalid_request"),
      );

      await expect(run(refreshKnockSession(env, "t1"))).resolves.toMatchObject({
        ok: false,
        kind: "terminal",
      });
      expect(await hasKnockTokens(env, "t1")).toBe(false);
    });

    it("keeps retrying within the first day of upstream failures", async () => {
      await storeKnockTokens(env, "t1", tokenData({ failingSince: nowSeconds() - DAY / 2 }));
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamError(503));

      await expect(run(refreshKnockSession(env, "t1"))).resolves.toMatchObject({
        ok: false,
        kind: "transient",
      });
      expect(await hasKnockTokens(env, "t1")).toBe(true);
    });

    it("treats a malformed upstream success as transient instead of storing it", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async () => new Response("<html>maintenance</html>", { status: 200 }),
      );

      await expect(run(refreshKnockSession(env, "t1"))).resolves.toMatchObject({
        ok: false,
        kind: "transient",
      });
      expect(storedRecord(kv, "t1")?.accessToken).toBe("access-old");
    });

    it("retries the write of a rotated record", async () => {
      await storeKnockTokens(env, "t1", tokenData());
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamOk());
      kv.failPuts = 2;

      const outcome = await refreshKnockSession(env, "t1");

      expect(outcome).toEqual({ ok: true, accessToken: "access-new" });
      expect(storedRecord(kv, "t1")?.refreshToken).toBe("refresh-new");
    });

    it("does not fail the refresh when renewing a fresh record's TTL fails", async () => {
      await storeKnockTokens(env, "t1", tokenData({ expiresAt: nowSeconds() + 3600 }));
      kv.failPuts = 1;

      await expect(refreshKnockSession(env, "t1", { renewTtl: true })).resolves.toEqual({
        ok: true,
        accessToken: "access-old",
      });
    });
  });

  describe("decideFailure", () => {
    const now = 1_000_000;

    it.each([
      ["invalid_grant is terminal", {}, { kind: "terminal", clientError: false }, "drop"],
      [
        "a shared client error is kept however long it lasts",
        { failingSince: now - 5 * DAY },
        { kind: "transient", clientError: true },
        "keep",
      ],
      [
        "the first transient failure is remembered",
        {},
        { kind: "transient", clientError: false },
        "remember",
      ],
      [
        "a transient failure inside the bound is kept",
        { failingSince: now - DAY / 2 },
        { kind: "transient", clientError: false },
        "keep",
      ],
      [
        "a transient failure past the bound is dropped",
        { failingSince: now - DAY - 1 },
        { kind: "transient", clientError: false },
        "drop",
      ],
    ] as const)("%s", (_name, data, failure, action) => {
      expect(decideFailure(data, failure, now).action).toBe(action);
    });
  });

  describe("pending records", () => {
    it("keeps the sign-in record short-lived until a grant activates it", async () => {
      await storePendingKnockTokens(env, "t1", tokenData());
      expect(kv.ttl("knock-token:t1")).toBeLessThanOrEqual(15 * 60);

      await activateKnockTokens(env, "t1");

      expect(kv.ttl("knock-token:t1")).toBeGreaterThan(90 * DAY);
    });

    it("fails to activate a record that already expired", async () => {
      await expect(activateKnockTokens(env, "t1")).rejects.toMatchObject({ kind: "missing" });
    });
  });
});
