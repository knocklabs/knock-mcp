import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import * as Sentry from "@sentry/cloudflare";

import { AuthHandler } from "./auth-handler";
import { KnockMCP as KnockMCPBase } from "./knock-mcp";
import { sentryConfig } from "./sentry";

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
  resourceMetadata: { resource: `${origin}/mcp` },
  // Surface errors the provider keeps generic on the wire, e.g. CIMD
  // metadata fetch failures at the token endpoint (internal.category
  // "client-id-metadata-document").
  onError({ code, description, status, internal }) {
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

    // Local dev only: wrangler dev rewrites request.url and Host to the
    // configured domain (mcp.knock.app), so the provider would embed
    // mcp.knock.app into all endpoint URLs. Serve authorization server
    // metadata with DEV_ORIGIN endpoints local clients can actually reach.
    // Production serves the provider's own metadata.
    if (env.DEV_ORIGIN && url.pathname === "/.well-known/oauth-authorization-server") {
      const devOrigin = env.DEV_ORIGIN;
      const metadata = {
        issuer: devOrigin,
        authorization_endpoint: `${devOrigin}/authorize`,
        token_endpoint: `${devOrigin}/token`,
        registration_endpoint: `${devOrigin}/register`,
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "client_secret_post",
          "none",
        ],
        revocation_endpoint: `${devOrigin}/token`,
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
    const providerRequest =
      env.DEV_ORIGIN && url.origin !== env.DEV_ORIGIN
        ? new Request(request.url.replace(url.origin, env.DEV_ORIGIN), request)
        : request;

    return provider.fetch(providerRequest, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export default Sentry.withSentry(sentryConfig, handler);
