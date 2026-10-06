/**
 * Lifetimes for the MCP-facing OAuth grant (workers-oauth-provider) and the
 * upstream Knock token record kept in KV.
 *
 * The MCP access token is long enough that clients refresh a handful of times
 * a week instead of every hour. Each refresh rotates the refresh token, and the
 * provider only accepts the current and immediately previous token, so fewer
 * refreshes means fewer chances for concurrent clients to orphan each other.
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 12;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;

/**
 * Sliding expiry: every successful MCP refresh pushes the grant this far out,
 * so a grant only expires after this long without being used.
 */
export const MCP_REFRESH_TOKEN_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;

/**
 * Outlives the grant it belongs to so the KV record never expires first. The
 * record is re-written on every MCP refresh, which is when the grant slides.
 */
export const KNOCK_TOKEN_KV_TTL_SECONDS =
  Math.max(MCP_REFRESH_TOKEN_TTL_SECONDS, MCP_REFRESH_TOKEN_IDLE_TTL_SECONDS) + 60 * 60 * 24;

/**
 * KV reads can lag a recent write by up to a minute. Within this window after
 * a grant is issued, a missing `knock-token:` record is treated as not yet
 * visible rather than as a dead session.
 */
export const NEW_GRANT_GRACE_SECONDS = 120;
