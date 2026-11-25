import type { McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/cloudflare";
import { createMcpHandler } from "agents/mcp/server";

import { withKeepAlive } from "./keep-alive";
import { applySessionSentryContext, requireSessionAuth } from "./session-auth";
import type { Props } from "./types";

export const MCP_ROUTE = "/mcp";

export interface BuildServerInput {
  env: Env;
  props: Props;
  /** Keeps the Worker alive for work that outlasts the response, such as analytics. */
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Serves MCP requests, each with a server built for it alone: nothing is kept
 * between requests, so two requests from one client can reach different
 * isolates. Speaks 2026-07-28 and the 2025-era protocols on one endpoint.
 * The OAuth provider calls it with the grant's props on `ctx.props`.
 */
export function createMcpApiHandler(buildServer: (input: BuildServerInput) => McpServer) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      logBrowserOrigin(request);

      const { props: grantProps } = ctx as ExecutionContext & { props?: Props };
      const problem = credentialProblem(grantProps);
      if (problem) return signInAgain(request, problem);
      const props = grantProps as Props;
      applySessionSentryContext(props);
      const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

      const handler = createMcpHandler(
        ({ era }) => {
          Sentry.setTag("mcp.era", era);
          const version = request.headers.get("mcp-protocol-version");
          if (version) Sentry.setTag("mcp.protocol_version", version);
          try {
            return buildServer({ env, props, waitUntil });
          } catch (error) {
            // The handler answers with a generic 500, so this is the only place the cause shows up.
            Sentry.captureException(error);
            throw error;
          }
        },
        {
          route: MCP_ROUTE,
          allowedHostnames: localHostnames(request),
          // Streams every response, so long calls get keepalives from the start and a dropped
          // connection is noticed. By default a call that sends no progress is silent until it ends.
          responseMode: "sse",
          // Every request needs a bearer token and none uses cookies, so another site can't act
          // with a user's credentials. Any Origin is accepted until we know which ones clients send.
          allowedOriginHostnames: "*",
          onerror: (error) => console.warn(`mcp handler error: ${error.message}`),
        },
      );
      return withKeepAlive(waitUntil, () => handler(request, env, ctx));
    },
  };
}

/** Why a grant can't be used, or undefined when it can. */
function credentialProblem(props: Props | undefined): string | undefined {
  try {
    requireSessionAuth(props);
  } catch (error) {
    return (error as Error).message;
  }
  // Grants from before clientId was added to Props (2026-03-24) land here.
  // Their requests to mAPI would 401 because we wouldn't send x-knock-client-id.
  return props?.clientId ? undefined : "MCP session missing clientId; please re-authenticate.";
}

/** Answers a request whose grant can't be used, so the client asks its user to sign in. */
function signInAgain(request: Request, problem: string): Response {
  console.warn(`mcp request refused: ${problem}`);
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource${MCP_ROUTE}`;
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: problem }, id: null },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${metadata}", error="invalid_token"`,
      },
    },
  );
}

/**
 * Hostnames to accept in `Host` on a localhost endpoint; other endpoints keep
 * the handler's defaults. `wrangler dev` sets Host to the deployed domain while
 * DEV_ORIGIN moves the URL to localhost, so the request's own Host is accepted.
 */
function localHostnames(request: Request): string[] | undefined {
  const { hostname } = new URL(request.url);
  if (!isLocal(hostname)) return undefined;
  const host = request.headers.get("Host");
  const own = host && URL.canParse(`http://${host}`) ? [new URL(`http://${host}`).hostname] : [];
  return [hostname, ...own];
}

const isLocal = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

/** Logs the Origin browser clients send, to find out which ones to allow. */
function logBrowserOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    hostname = "unparseable";
  }
  if (isLocal(hostname)) return;
  console.log(JSON.stringify({ event: "mcp_browser_origin", hostname, method: request.method }));
}
