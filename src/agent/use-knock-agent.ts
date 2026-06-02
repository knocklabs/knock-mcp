import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import type { Props } from "../types";
import { formatAgentResult } from "./format";
import { DEFAULT_AGENT_RUN_TIMEOUT_MS, runAgentSession } from "./stream";

const USE_KNOCK_AGENT_DESCRIPTION = `Use Knock's hosted agent to create or update notification resources inside the connected Knock account.

Use this tool when the user wants to create or update a workflow, broadcast, partial, guide, or email layout. Prefer this over direct Management API writes for authoring tasks.

Pass the user's request verbatim in \`prompt\`. Do not reinterpret or shorten it.

For follow-up turns in the same agent conversation, pass the returned \`session_id\`.`;

export function registerUseKnockAgent(server: McpServer, env: Env, props: Props): void {
  server.registerTool(
    "use_knock_agent",
    {
      description: USE_KNOCK_AGENT_DESCRIPTION,
      inputSchema: {
        prompt: z
          .string()
          .describe("The user's full request, passed verbatim to the Knock agent"),
        session_id: z
          .string()
          .optional()
          .describe("Existing agent session ID for follow-up runs"),
        environment: z
          .string()
          .optional()
          .describe('Knock environment slug (defaults to "development")'),
      },
    },
    async (
      { prompt, session_id: sessionId, environment },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => {
      Sentry.setTag("knock.tool", "use_knock_agent");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_AGENT_RUN_TIMEOUT_MS);
      extra.signal.addEventListener("abort", () => controller.abort(), { once: true });

      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken
        ? async (state: { eventCount: number; toolCallCount: number }) => {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: state.eventCount,
                message: `Knock agent working… ${state.toolCallCount} tool call(s) so far`,
              },
            });
          }
        : undefined;

      try {
        const result = await runAgentSession({
          env,
          props,
          prompt,
          sessionId,
          environment,
          onProgress,
          signal: controller.signal,
        });

        return formatAgentResult(result);
      } finally {
        clearTimeout(timeout);
      }
    },
  );
}
