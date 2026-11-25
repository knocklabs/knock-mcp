import type { McpServer } from "@modelcontextprotocol/server";
import * as Sentry from "@sentry/cloudflare";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";

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

      const handler = createMcpHandler(
        ({ era }) => {
          Sentry.setTag("mcp.era", era);
          const version = request.headers.get("mcp-protocol-version");
          if (version) Sentry.setTag("mcp.protocol_version", version);
          try {
            return buildServer({
              env,
              props: requireSessionProps(getMcpAuthContext()?.props as Props | undefined),
              waitUntil: (promise) => ctx.waitUntil(promise),
            });
          } catch (error) {
            // The handler answers with a generic 500, so this is the only place the cause shows up.
            Sentry.captureException(error);
            throw error;
          }
        },
        {
          route: MCP_ROUTE,
          // Every request needs a bearer token and none uses cookies, so another site can't act
          // with a user's credentials. Any Origin is accepted until we know which ones clients send.
          allowedOriginHostnames: "*",
          onerror: (error) => console.warn(`mcp handler error: ${error.message}`),
        },
      );
      return handler(request, env, ctx);
    },
  };
}

/** Checks the request's credentials and tags the request's Sentry scope with them. */
function requireSessionProps(props: Props | undefined): Props {
  requireSessionAuth(props);
  if (!props?.clientId) {
    // Grants from before clientId was added to Props (2026-03-24) land here.
    // Their requests to mAPI would 401 because we wouldn't send x-knock-client-id,
    // so fail with a message that says to sign in again.
    throw new Error("MCP session missing clientId; please re-authenticate.");
  }
  applySessionSentryContext(props);
  return props;
}

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
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return;
  console.log(JSON.stringify({ event: "mcp_browser_origin", hostname, method: request.method }));
}
