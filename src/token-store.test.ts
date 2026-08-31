import { describe, expect, it } from "vitest";

import { getOrRefreshKnockToken } from "./token-store";

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
});
