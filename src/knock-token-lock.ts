import { DurableObject } from "cloudflare:workers";

import { refreshKnockSession, type RefreshOptions, type RefreshOutcome } from "./token-store";

/** Runs tasks one at a time, so a Durable Object serializes work for its session. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * One instance per upstream session (named by tokenId). The upstream rotates
 * refresh tokens on every use, so concurrent refreshes from the MCP Worker and
 * from tool calls in the session Durable Objects would invalidate each other.
 * Running them one at a time here means the second caller finds the record the
 * first one already refreshed.
 */
export class KnockTokenLock extends DurableObject<Env> {
  private readonly enqueue = createSerialQueue();

  refresh(tokenId: string, options: RefreshOptions): Promise<RefreshOutcome> {
    return this.enqueue(() => refreshKnockSession(this.env, tokenId, options));
  }
}
