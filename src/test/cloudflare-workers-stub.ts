/** Stand-in for the `cloudflare:workers` runtime module in Node-based tests. */
export class WorkerEntrypoint<E = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
}

export class DurableObject<E = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
}

export const env = {};
