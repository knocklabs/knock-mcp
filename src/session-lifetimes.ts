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
