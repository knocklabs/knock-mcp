import { OAuthError } from "@cloudflare/workers-oauth-provider";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";

import { NEW_GRANT_GRACE_SECONDS } from "./session-lifetimes";
import { sessionAuthFromProps } from "./session-auth";
import { getOrRefreshKnockToken, hasKnockTokens, KnockSessionError } from "./token-store";
import type { Props } from "./types";

function isRecentGrant(props: Pick<Props, "issuedAt"> | null | undefined): boolean {
  if (typeof props?.issuedAt !== "number") return false;
  return Math.floor(Date.now() / 1000) - props.issuedAt < NEW_GRANT_GRACE_SECONDS;
}

/**
 * RFC 6750 challenge for an MCP access token that is still valid at the OAuth
 * layer but whose upstream Knock session is gone. Mirrors the provider's own
 * `invalid_token` response so clients react to it the same way.
 */
export function unauthorizedSessionResponse(request: Request, description: string): Response {
  const url = new URL(request.url);
  const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="${description}"`,
    },
  });
}

type ApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
};

/**
 * Answers 401 before reaching the MCP Durable Object when an OAuth session's
 * upstream Knock tokens no longer exist. Without this the failure surfaces as
 * a tool error on a valid MCP token and the client never re-authorizes.
 */
export function withKnockSessionGuard(handler: ApiHandler): ApiHandler {
  return {
    async fetch(request, env, ctx) {
      const props = (ctx as { props?: Props }).props;
      const auth = sessionAuthFromProps(props);
      if (
        auth?.kind === "oauth" &&
        !isRecentGrant(props) &&
        !(await hasKnockTokens(env, auth.tokenId))
      ) {
        return unauthorizedSessionResponse(
          request,
          "Knock session expired; please re-authenticate.",
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

  try {
    await getOrRefreshKnockToken(options.env, auth.tokenId, { renewTtl: true });
  } catch (error) {
    if (!(error instanceof KnockSessionError)) throw error;

    const retryLater =
      error.kind === "transient" || (error.kind === "missing" && isRecentGrant(props));
    if (retryLater) {
      throw new OAuthError("temporarily_unavailable", {
        description: "Knock session is temporarily unavailable; retry shortly.",
        statusCode: 503,
        headers: { "Retry-After": "5" },
        internal: { category: "token-exchange-callback", reason: "upstream_unavailable" },
      });
    }

    throw new OAuthError("invalid_grant", {
      description: "Knock session expired; please re-authenticate.",
      internal: { category: "token-exchange-callback", reason: "upstream_session_dead" },
    });
  }
}
