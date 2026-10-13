import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/cloudflare", () => ({ captureMessage: vi.fn() }));

import { createSerialQueue } from "./knock-token-lock";
import { createKnockEnv } from "./test/knock-env";
import { tokenData, upstreamOk } from "./test/token-fixtures";
import { storeKnockTokens } from "./token-store";

describe("createSerialQueue", () => {
  it("runs tasks strictly one after another", async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      events.push(`end ${name}`);
    };

    await Promise.all([enqueue(task("a", 15)), enqueue(task("b", 1))]);

    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("keeps running after a task fails and still reports that failure to its caller", async () => {
    const enqueue = createSerialQueue();

    const failed = enqueue(async () => {
      throw new Error("boom");
    });
    const next = enqueue(async () => "ok");

    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("KnockTokenLock", () => {
  it("serializes refreshes so concurrent callers share one upstream call", async () => {
    const { env } = createKnockEnv();
    await storeKnockTokens(env, "t1", tokenData());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return upstreamOk();
    });
    const lock = env.KNOCK_TOKEN_LOCK.get(env.KNOCK_TOKEN_LOCK.idFromName("t1"));

    const outcomes = await Promise.all([lock.refresh("t1", {}), lock.refresh("t1", {})]);

    expect(outcomes).toEqual([
      { ok: true, accessToken: "access-new" },
      { ok: true, accessToken: "access-new" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });
});
