import { DurableObject } from "cloudflare:workers";

import { createSerialQueue, refreshKnockSession, type RefreshOutcome } from "./token-store";

/**
 * One instance per upstream session (named by tokenId). The upstream rotates
 * refresh tokens on every use, so concurrent refreshes from the MCP Worker and
 * from tool calls in the session Durable Objects would invalidate each other.
 * Running them one at a time here means the second caller finds the record the
 * first one already refreshed.
 */
export class KnockTokenLock extends DurableObject<Env> {
  private readonly enqueue = createSerialQueue();

  refresh(tokenId: string, options: { renewTtl?: boolean }): Promise<RefreshOutcome> {
    return this.enqueue(() => refreshKnockSession(this.env, tokenId, options));
  }
}
