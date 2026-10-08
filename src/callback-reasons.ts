/**
 * `internal` diagnostics attached to the OAuth errors that
 * `ensureUpstreamSession` throws. Shared with the Sentry predicate, which
 * decides from them which errors are already reported elsewhere.
 */
export const CALLBACK_ERROR_CATEGORY = "token-exchange-callback";

export const CALLBACK_ERROR_REASON = {
  /** Upstream is failing; already reported where the refresh failed. */
  upstreamUnavailable: "upstream_unavailable",
  /** A bug or infrastructure error; reported by the callback itself. */
  unexpectedError: "unexpected_error",
  /** A new grant whose upstream record is not visible yet. Not reported anywhere else. */
  recordNotVisible: "record_not_visible",
  sessionDead: "upstream_session_dead",
  maxAgeExceeded: "grant_max_age_exceeded",
} as const;
