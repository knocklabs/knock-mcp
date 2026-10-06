import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";

import { sessionAuthFromProps } from "./session-auth";
import { MCP_GRANT_MAX_AGE_SECONDS } from "./session-lifetimes";
import { nowSeconds } from "./time";
import { getOrRefreshKnockToken, hasKnockTokens, KnockSessionError } from "./token-store";
import type { Props } from "./types";

const DEAD_SESSION_DESCRIPTION = "Knock session expired; please re-authenticate.";

/**
 * KV reads can lag a recent write by up to a minute. For this long after a grant
 * is issued a missing `knock-token:` record is treated as not yet visible
 * instead of as a dead session, because declaring it dead revokes the grant.
 */
const NEW_GRANT_GRACE_SECONDS = 120;

function ageSeconds(props: Pick<Props, "issuedAt"> | undefined): number | undefined {
  return typeof props?.issuedAt === "number" ? nowSeconds() - props.issuedAt : undefined;
}

function isNewGrant(props: Pick<Props, "issuedAt"> | undefined): boolean {
  const age = ageSeconds(props);
  return age !== undefined && age < NEW_GRANT_GRACE_SECONDS;
}

function isExpiredGrant(props: Pick<Props, "issuedAt"> | undefined): boolean {
  const age = ageSeconds(props);
  return age !== undefined && age > MCP_GRANT_MAX_AGE_SECONDS;
}

type ApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext<Props | undefined>): Promise<Response>;
};

/**
 * Answers 401 before reaching the MCP Durable Object when an OAuth session's
 * upstream Knock tokens no longer exist. Without this the failure surfaces as
 * a tool error on a valid MCP token and the client never re-authorizes. The
 * challenge mirrors the provider's own `invalid_token` response.
 */
export function withKnockSessionGuard(
  handler: ApiHandler,
  options: { resourceMetadataUrl: string },
): ApiHandler {
  const challenge = `Bearer realm="OAuth", resource_metadata="${options.resourceMetadataUrl}", error="invalid_token", error_description="${DEAD_SESSION_DESCRIPTION}"`;

  return {
    async fetch(request, env, ctx) {
      const auth = sessionAuthFromProps(ctx.props);
      if (
        auth?.kind === "oauth" &&
        !isNewGrant(ctx.props) &&
        !(await hasKnockTokens(env, auth.tokenId))
      ) {
        return new Response(
          JSON.stringify({ error: "invalid_token", error_description: DEAD_SESSION_DESCRIPTION }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "WWW-Authenticate": challenge,
            },
          },
        );
      }
      return handler.fetch(request, env, ctx);
    },
  };
}

/**
 * Ties the MCP refresh grant to upstream health. When the MCP client refreshes
 * its access token we make sure the Knock session behind it still works. If it
 * is dead we throw `invalid_grant`, which the provider turns into a revoked
 * grant so the client goes through a new authorization. Transient upstream
 * failures come back as `temporarily_unavailable` so the client keeps its
 * tokens and retries.
 */
export async function ensureUpstreamSession(
  options: Pick<TokenExchangeCallbackOptions<Env>, "grantType" | "props" | "env">,
): Promise<void> {
  if (options.grantType !== "refresh_token") return;

  const props = options.props as Props | undefined;
  const auth = sessionAuthFromProps(props);
  if (auth?.kind !== "oauth") return;

  if (isExpiredGrant(props)) {
    throw new OAuthError("invalid_grant", {
      description: DEAD_SESSION_DESCRIPTION,
      internal: { category: "token-exchange-callback", reason: "grant_max_age_exceeded" },
    });
  }

  try {
    await getOrRefreshKnockToken(options.env, auth.tokenId, { renewTtl: true });
  } catch (error) {
    if (!(error instanceof KnockSessionError)) throw error;

    const retryLater =
      error.kind === "transient" || (error.kind === "missing" && isNewGrant(props));
    if (retryLater) {
      throw new OAuthError("temporarily_unavailable", {
        description: "Knock session is temporarily unavailable; retry shortly.",
        statusCode: 503,
        headers: { "Retry-After": "5" },
        internal: { category: "token-exchange-callback", reason: "upstream_unavailable" },
      });
    }

    throw new OAuthError("invalid_grant", {
      description: DEAD_SESSION_DESCRIPTION,
      internal: { category: "token-exchange-callback", reason: "upstream_session_dead" },
    });
  }
}
