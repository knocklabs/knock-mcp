import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";

import { CALLBACK_ERROR_CATEGORY, CALLBACK_ERROR_REASON } from "./callback-reasons";
import { sessionAuthFromProps } from "./session-auth";
import { DEAD_SESSION_DESCRIPTION } from "./session-guard";
import { grantPhase } from "./session-lifetimes";
import { nowSeconds } from "./time";
import { getOrRefreshKnockToken, KnockSessionError } from "./token-store";
import type { Props } from "./types";

const fail = (
  code: "invalid_grant" | "temporarily_unavailable",
  description: string,
  reason: string,
  extra: { statusCode?: number; headers?: Record<string, string> } = {},
) =>
  new OAuthError(code, {
    description,
    ...extra,
    internal: { category: CALLBACK_ERROR_CATEGORY, reason },
  });

const retryLater = (reason: string) =>
  fail(
    "temporarily_unavailable",
    "Knock session is temporarily unavailable; retry shortly.",
    reason,
    {
      statusCode: 503,
      headers: { "Retry-After": "5" },
    },
  );

/**
 * Ties the MCP refresh grant to upstream health. When the MCP client refreshes
 * its access token we make sure the Knock session behind it still works. If it
 * is dead we throw `invalid_grant`, which the provider turns into a revoked
 * grant so the client goes through a new authorization. Anything that is not a
 * known-dead session comes back as `temporarily_unavailable`, so the client
 * keeps its tokens and retries instead of discarding a healthy session.
 */
export async function ensureUpstreamSession(
  options: Pick<TokenExchangeCallbackOptions<Env>, "grantType" | "props" | "env">,
): Promise<void> {
  if (options.grantType !== "refresh_token") return;

  const props = options.props as Props | undefined;
  const auth = sessionAuthFromProps(props);
  if (auth?.kind !== "oauth") return;

  const phase = grantPhase(props, nowSeconds());
  if (phase === "expired") {
    throw fail("invalid_grant", DEAD_SESSION_DESCRIPTION, CALLBACK_ERROR_REASON.maxAgeExceeded);
  }

  try {
    await getOrRefreshKnockToken(options.env, auth.tokenId, { renewTtl: true });
  } catch (error) {
    if (!(error instanceof KnockSessionError)) {
      // KV or Durable Object trouble, not a verdict on the session. A raw 500
      // would make SDK clients throw their tokens away and re-authorize.
      Sentry.captureException(error, { tags: { stage: "ensure_upstream_session" } });
      throw retryLater(CALLBACK_ERROR_REASON.unexpectedError);
    }
    if (error.kind === "transient") throw retryLater(CALLBACK_ERROR_REASON.upstreamUnavailable);
    if (error.kind === "missing" && phase === "new") {
      throw retryLater(CALLBACK_ERROR_REASON.recordNotVisible);
    }
    throw fail("invalid_grant", DEAD_SESSION_DESCRIPTION, CALLBACK_ERROR_REASON.sessionDead);
  }
}
