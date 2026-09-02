import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";

import { AuthHandler } from "./auth-handler";
import { KnockMCP as KnockMCPBase } from "./knock-mcp";
import { OPENAI_APPS_CHALLENGE_PATH, openaiAppsChallengeResponse } from "./openai-apps-challenge";
import { canonicalMcpResource, withCanonicalMcpResource } from "./mcp-resource";
import { sentryConfig, shouldCaptureOAuthProviderError } from "./sentry";
import { resolveKnockServiceToken } from "./service-token";

export const KnockMCP = Sentry.instrumentDurableObjectWithSentry(
  sentryConfig,
  KnockMCPBase as unknown as new (state: DurableObjectState, env: Env) => KnockMCPBase,
) as unknown as typeof KnockMCPBase;

// The cloudflare:workers env export is typed Cloudflare.Env, which CI's
// `wrangler types` generates without .dev.vars-only bindings like DEV_ORIGIN.
// Cast to our global Env, which src/env.d.ts patches with those bindings.
const origin = (env as Env).DEV_ORIGIN || "https://mcp.knock.app";

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: KnockMCP.serve("/mcp") as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  // RFC 9728: pins grants and access-token audiences to this exact
  // resource, and controls /.well-known/oauth-protected-resource.
  resourceMetadata: { resource: canonicalMcpResource(origin) },
  resolveExternalToken: async ({ token, env }) => {
    const resolved = await resolveKnockServiceToken(token, env);
    // 0.10+ rejects external bearers unless audience matches resourceMetadata.resource.
    return resolved ? { ...resolved, audience: canonicalMcpResource(origin) } : null;
  },
  // Surface errors the provider keeps generic on the wire, e.g. CIMD
  // metadata fetch failures at the token endpoint (internal.category
  // "client-id-metadata-document"). Expected client 4xxs (invalid_grant,
  // invalid_token, invalid_target) stay in Cloudflare logs only.
  onError({ code, description, status, internal }) {
    const log = status >= 500 ? console.error : console.warn;
    log(`oauth-provider error: ${status} ${code} - ${description}`);

    if (!shouldCaptureOAuthProviderError({ code, description, status, internal })) {
      return;
    }

    Sentry.captureMessage(`oauth-provider error: ${code}`, {
      level: status >= 500 ? "error" : "warning",
      tags: { code, status, category: internal?.category },
      extra: { description, internal },
    });
  },
});

const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === OPENAI_APPS_CHALLENGE_PATH) {
      return openaiAppsChallengeResponse();
    }

    // Local dev only: wrangler dev rewrites request.url and Host to the
    // configured domain (mcp.knock.app), so the provider would embed
    // mcp.knock.app into all endpoint URLs. Serve authorization server
    // metadata with DEV_ORIGIN endpoints local clients can actually reach.
    // Production serves the provider's own metadata.
    if (env.DEV_ORIGIN && url.pathname === "/.well-known/oauth-authorization-server") {
      const metadata = {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        revocation_endpoint: `${origin}/token`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      };

      return new Response(JSON.stringify(metadata), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // wrangler dev rewrites every request URL to the configured domain
    // (mcp.knock.app). Rewrite it back to DEV_ORIGIN so the OAuth provider
    // uses the correct origin for audience validation, token issuance, etc.
    const devOrigin = env.DEV_ORIGIN || undefined;
    const rewritten =
      devOrigin && url.origin !== devOrigin
        ? new Request(request.url.replace(url.origin, devOrigin), request)
        : request;

    // MCP clients often send the issuer origin (or a trailing slash) as
    // `resource`. 0.10 exact-matches resourceMetadata.resource, so rewrite
    // those aliases onto https://mcp.knock.app/mcp before the provider.
    const providerRequest = await withCanonicalMcpResource(rewritten, canonicalMcpResource(origin));

    return provider.fetch(providerRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(sentryConfig, handler);
