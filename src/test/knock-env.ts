import { createMemoryKv, type MemoryKv } from "./memory-kv";
import { createSerialQueue, refreshKnockSession } from "../token-store";

/**
 * An `Env` slice with the KV namespace and a `KNOCK_TOKEN_LOCK` whose stubs run
 * `refreshKnockSession` through a per-session serial queue, like the real
 * Durable Object does.
 */
export function createKnockEnv(kv: MemoryKv = createMemoryKv()) {
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>();

  const KNOCK_TOKEN_LOCK = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      const queue = queues.get(id) ?? createSerialQueue();
      queues.set(id, queue);
      return {
        refresh: (tokenId: string, options: { renewTtl?: boolean }) =>
          queue(() => refreshKnockSession(env, tokenId, options)),
      };
    },
  };

  const env = { OAUTH_KV: kv, KNOCK_TOKEN_LOCK } as unknown as Pick<
    Env,
    "OAUTH_KV" | "KNOCK_TOKEN_LOCK"
  >;
  return { env, kv };
}
