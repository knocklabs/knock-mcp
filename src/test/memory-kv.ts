type Entry = { value: string; expiresAt?: number; metadata?: unknown };

/**
 * In-memory KV honoring the parts of the API this worker and the OAuth
 * provider use: TTLs, prefix listing with metadata, and injectable put failures.
 */
export function createMemoryKv() {
  const store = new Map<string, Entry>();
  const now = () => Date.now() / 1000;
  const live = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };

  const kv = {
    store,
    failPuts: 0,
    async get(key: string, options?: string | { type?: string }) {
      const entry = live(key);
      if (!entry) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async getWithMetadata(key: string, options?: string | { type?: string }) {
      const entry = live(key);
      const value = await kv.get(key, options);
      return { value, metadata: entry?.metadata ?? null };
    },
    async put(
      key: string,
      value: string,
      options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
    ) {
      if (kv.failPuts > 0) {
        kv.failPuts--;
        throw new Error("KV put failed");
      }
      const expiresAt =
        options?.expiration ??
        (options?.expirationTtl !== undefined ? now() + options.expirationTtl : undefined);
      store.set(key, { value, expiresAt, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const keys = [...store.keys()]
        .filter((key) => live(key) && key.startsWith(options?.prefix ?? ""))
        .map((name) => ({ name, metadata: store.get(name)?.metadata }));
      return { keys, list_complete: true as const, cacheStatus: null };
    },
    /** Seconds until `key` expires, for asserting TTLs. */
    ttl(key: string): number | undefined {
      const expiresAt = live(key)?.expiresAt;
      return expiresAt === undefined ? undefined : Math.round(expiresAt - now());
    },
  };
  return kv;
}

export type MemoryKv = ReturnType<typeof createMemoryKv>;
