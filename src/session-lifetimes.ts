/**
 * Lifetimes for the MCP-facing OAuth grant (workers-oauth-provider).
 *
 * Each MCP refresh rotates the refresh token, and the provider only accepts the
 * current and immediately previous token, so a longer access token means fewer
 * refreshes (about two a day) and fewer chances for concurrent clients to
 * orphan each other.
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 12;

/**
 * Sliding lifetime of a grant: set when the grant is created and moved forward
 * by the same amount on every successful refresh, so it only expires after
 * this long without being used.
 */
export const MCP_GRANT_TTL_SECONDS = 60 * 60 * 24 * 90;

/**
 * Absolute lifetime of a grant regardless of use. Enforced from the refresh
 * callback using the `issuedAt` prop, so grants minted before that prop existed
 * are only bound by the sliding window.
 */
export const MCP_GRANT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * KV reads can lag a recent write by up to a minute. For this long after a grant
 * is issued a missing `knock-token:` record is treated as not yet visible
 * instead of as a dead session, because declaring it dead revokes the grant.
 */
const NEW_GRANT_GRACE_SECONDS = 120;

/**
 * - `legacy`: minted before `issuedAt` existed, so only the sliding window bounds it.
 * - `new`: issued within the KV propagation grace window.
 * - `established`: past the grace window and within its absolute lifetime.
 * - `expired`: older than the absolute lifetime.
 */
export type GrantPhase = "legacy" | "new" | "established" | "expired";

export function grantPhase(props: { issuedAt?: number } | undefined, now: number): GrantPhase {
  if (typeof props?.issuedAt !== "number") return "legacy";
  const age = now - props.issuedAt;
  if (age < NEW_GRANT_GRACE_SECONDS) return "new";
  return age > MCP_GRANT_MAX_AGE_SECONDS ? "expired" : "established";
}
