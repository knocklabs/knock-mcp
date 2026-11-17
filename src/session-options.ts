import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";

import { protectedResourceMetadataUrl } from "./mcp-resource";
import { withKnockSessionGuard, type ApiHandler } from "./session-guard";
import { MCP_ACCESS_TOKEN_TTL_SECONDS, MCP_GRANT_TTL_SECONDS } from "./session-lifetimes";
import { ensureUpstreamSession } from "./token-exchange-callback";

/**
 * The OAuth provider options that define how MCP sessions live and die:
 * lifetimes, the upstream health check on refresh, and the 401 guard in front
 * of the MCP handler. Shared by the Worker entry point and the tests that drive
 * the real provider, so the two cannot drift apart.
 */
export function sessionProviderOptions(deps: {
  mcpHandler: ApiHandler;
  mcpResource: string;
}): Pick<
  OAuthProviderOptions<Env>,
  | "apiHandler"
  | "accessTokenTTL"
  | "refreshTokenTTL"
  | "refreshTokenIdleTTL"
  | "tokenExchangeCallback"
  | "resourceMetadata"
> {
  return {
    apiHandler: withKnockSessionGuard(deps.mcpHandler, {
      resourceMetadataUrl: protectedResourceMetadataUrl(deps.mcpResource),
    }) as never,
    accessTokenTTL: MCP_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: MCP_GRANT_TTL_SECONDS,
    refreshTokenIdleTTL: MCP_GRANT_TTL_SECONDS,
    tokenExchangeCallback: ensureUpstreamSession,
    // RFC 9728: pins grants and access-token audiences to this exact
    // resource, and controls /.well-known/oauth-protected-resource.
    resourceMetadata: { resource: deps.mcpResource },
  };
}
