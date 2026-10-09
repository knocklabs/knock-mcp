import { sessionAuthFromProps } from "./session-auth";
import { grantPhase } from "./session-lifetimes";
import { nowSeconds } from "./time";
import { hasKnockTokens } from "./token-store";
import type { Props } from "./types";

/** Shared with the refresh callback so both ends report the same condition identically. */
export const DEAD_SESSION_DESCRIPTION = "Knock session expired; please re-authenticate.";

export type ApiHandler = {
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
        grantPhase(ctx.props, nowSeconds()) !== "new" &&
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
