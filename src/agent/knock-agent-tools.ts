import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import type { Props } from "../types";
import { createStartStreamBudgetController } from "./abort";
import { runKnockAgentTool } from "./mcp-response";
import { knockAgentProgressHandler } from "./progress";
import {
  DEFAULT_START_STREAM_BUDGET_MS,
  startAgentRun,
  streamAgentSessionOnce,
} from "./stream";
import { MAX_AGENT_PROMPT_CHARS } from "./validation";

const START_KNOCK_AGENT_DESCRIPTION = `Use Knock's hosted agent to create and update workflows, broadcasts, guides, email layouts, partials, and translations.

Prefer this tool when creating or updating those resources in a Knock account — the hosted agent has full account context and usually needs fewer tokens than calling the Management API directly. Use Management API code mode (\`search_mapi\` / \`execute_mapi_read\` / \`execute_mapi_write\`) when you need a specific API call, or when the user asks to use the API.

For analytics questions, the Knock agent can return high-level message and engagement data. Those queries are not available through the Management API.

Pass the user's request verbatim in prompt. Do not reinterpret or shorten it.

This tool waits up to ~45 seconds, then returns a consolidated result. Read the Status line in the response:
- Status: complete — the run finished; use the agent response and modified resources.
- Status: error — the run failed; read the Error line.
- Status: running — the run is still going; save the Session ID and poll with get_knock_agent until Status is complete or error.

Agents can support follow-up runs by passing in the returned session_id. Use a follow-up run only for related edits or questions about a resource you just modified. Otherwise, use the Management API or start a new agent session.`;

const GET_KNOCK_AGENT_DESCRIPTION = `Poll an in-progress Knock agent session and return a consolidated result (agent text, tool calls, modified resources, and a Status line).

When to use:
- After start_knock_agent returns Status: running.
- When resuming after an MCP disconnect (you still have the session_id).

How to use:
1. Call with the session_id from start_knock_agent (or a prior get_knock_agent).
2. Read the Status line in the tool result — you do not parse raw events; the server consolidates them for you.
3. If Status is running, wait a few seconds and call get_knock_agent again with the same session_id.
4. If Status is complete, the run succeeded — use the agent response.
5. If Status is error, the run failed — read the Error line.

The Knock agent keeps running on the backend between your polls; each call is short-lived.`;

export function registerKnockAgentTools(server: McpServer, env: Env, props: Props): void {
  server.registerTool(
    "start_knock_agent",
    {
      title: "Start Knock agent",
      description: START_KNOCK_AGENT_DESCRIPTION,
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
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (
      { prompt, session_id: sessionId },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => {
      Sentry.setTag("knock.tool", "start_knock_agent");

      const { controller, getAbortReason, clear: clearBudget } = createStartStreamBudgetController(
        DEFAULT_START_STREAM_BUDGET_MS,
        extra.signal,
      );

      try {
        return await runKnockAgentTool(() =>
          startAgentRun({
            env,
            props,
            prompt,
            sessionId,
            onProgress: knockAgentProgressHandler(extra),
            signal: controller.signal,
            getAbortReason,
          }),
        );
      } finally {
        clearBudget();
      }
    },
  );

  server.registerTool(
    "get_knock_agent",
    {
      title: "Get Knock agent status",
      description: GET_KNOCK_AGENT_DESCRIPTION,
      inputSchema: {
        session_id: z
          .string()
          .uuid()
          .describe("Agent session ID from start_knock_agent"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id: sessionId }) => {
      Sentry.setTag("knock.tool", "get_knock_agent");

      return await runKnockAgentTool(() =>
        streamAgentSessionOnce({
          env,
          props,
          sessionId,
        }),
      );
    },
  );
}
