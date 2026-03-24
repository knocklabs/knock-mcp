import OAuthProvider from "@cloudflare/workers-oauth-provider";

import { AuthHandler } from "./auth-handler";
import { KnockMCP } from "./knock-mcp";
export { KnockMCP };

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: KnockMCP.serve("/mcp") as any,
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

// Rewrite /.well-known/oauth-authorization-server to use the actual request
// origin instead of the production domain baked in by the OAuth provider.
// This is essential for local dev where the wrangler routes config causes the
// provider to embed mcp.knock.app into all endpoint URLs.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      // wrangler dev rewrites request.url and Host to the configured domain
      // (mcp.knock.app). DEV_ORIGIN overrides this so local clients get
      // endpoint URLs they can actually reach.
      const origin = env.DEV_ORIGIN || url.origin;
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
        code_challenge_methods_supported: ["plain", "S256"],
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
    const providerRequest =
      devOrigin && url.origin !== devOrigin
        ? new Request(request.url.replace(url.origin, devOrigin), request)
        : request;

    const response = await provider.fetch(providerRequest, env, ctx);

    // RFC 9728: add resource_metadata to WWW-Authenticate on 401s so MCP
    // clients know where to fetch /.well-known/oauth-protected-resource.
    // workers-oauth-provider may not include this yet on all versions.
    if (response.status === 401) {
      const origin = env.DEV_ORIGIN || url.origin;
      const existing = response.headers.get("WWW-Authenticate") ?? 'Bearer realm="OAuth"';
      const rewritten = new Response(response.body, response);
      rewritten.headers.set(
        "WWW-Authenticate",
        `${existing}, resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      return rewritten;
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
