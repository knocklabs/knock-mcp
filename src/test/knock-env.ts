import { KnockTokenLock } from "../knock-token-lock";
import { createMemoryKv, type MemoryKv } from "./memory-kv";

/**
 * An `Env` slice with the KV namespace and a `KNOCK_TOKEN_LOCK` namespace that
 * hands out one real `KnockTokenLock` per session name, as the runtime does.
 */
export function createKnockEnv(kv: MemoryKv = createMemoryKv()) {
  const locks = new Map<string, KnockTokenLock>();

  const KNOCK_TOKEN_LOCK = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      const lock = locks.get(name) ?? new KnockTokenLock({} as DurableObjectState, env);
      locks.set(name, lock);
      return lock;
    },
  };

  const env = { OAUTH_KV: kv, KNOCK_TOKEN_LOCK } as unknown as Env;
  return { env, kv };
}
