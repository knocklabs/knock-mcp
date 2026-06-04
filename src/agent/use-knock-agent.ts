import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import type { Props } from "../types";
import { createAgentRunAbortController } from "./abort";
import { runKnockAgentTool } from "./mcp-response";
import { knockAgentProgressHandler } from "./progress";
import { DEFAULT_AGENT_RUN_TIMEOUT_MS, runAgentSession } from "./stream";
import { MAX_AGENT_PROMPT_CHARS } from "./validation";

const USE_KNOCK_AGENT_DESCRIPTION = `Use Knock's hosted agent to create and update workflows, broadcasts, guides, email layouts, partials, and translations.

You should ALWAYS default to this tool when you're asked to create or update workflows, templates, broadcasts, guides, partials, translations, and email layouts in a Knock account. You will have a much better success rate with a much lower token usage in using this approach.

This tool will launch a hosted agent that will better understand the full Knock account context in order to perform the operation. You should prefer this tool over calling the management API directly, unless you have been explicitly asked to do so.

If you are being asked an analytics query, you can call the Knock agent to receive some results back. You should be aware that the analytics capabilities are limited right now to high-level message and engagement data. This type of query also cannot be answered with the management API, however.

Pass the user's request verbatim in prompt. Do not reinterpret or shorten it.

Agents can support follow up runs by passing in the returned \`session_id\`. You should only use a follow-up run for related edits or questions about a resource you just modified. Otherwise, you can use the management API to answer additional queries or you should start a new agent session.`;

export function registerUseKnockAgent(server: McpServer, env: Env, props: Props): void {
  server.registerTool(
    "use_knock_agent",
    {
      description: USE_KNOCK_AGENT_DESCRIPTION,
      inputSchema: {
        prompt: z
          .string()
          .max(MAX_AGENT_PROMPT_CHARS)
          .describe("The user's full request, passed verbatim to the Knock agent"),
        session_id: z
          .string()
          .uuid()
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

      const { controller, getAbortReason, clear: clearAbort } = createAgentRunAbortController(
        DEFAULT_AGENT_RUN_TIMEOUT_MS,
        extra.signal,
      );

      try {
        return await runKnockAgentTool(() =>
          runAgentSession({
            env,
            props,
            prompt,
            sessionId,
            environment,
            onProgress: knockAgentProgressHandler(extra),
            signal: controller.signal,
            getAbortReason,
          }),
        );
      } finally {
        clearAbort();
      }
    },
  );
}
