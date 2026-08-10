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

You should ALWAYS default to this tool when you're asked to create or update workflows, templates, broadcasts, guides, partials, translations, and email layouts in a Knock account. You will have a much better success rate with a much lower token usage in using this approach.

This tool will launch a hosted agent that will better understand the full Knock account context in order to perform the operation. You should prefer this tool over calling the management API directly, unless you have been explicitly asked to do so.

If you are being asked an analytics query, you can call the Knock agent to receive some results back. You should be aware that the analytics capabilities are limited right now to high-level message and engagement data. This type of query also cannot be answered with the management API, however.

Pass the user's request verbatim in prompt. Do not reinterpret or shorten it.

This tool waits up to ~45 seconds, then returns a consolidated result. Read the Status line in the response:
- Status: complete — the run finished; use the agent response and modified resources.
- Status: error — the run failed; read the Error line.
- Status: running — the run is still going; save the Session ID and poll with get_knock_agent until Status is complete or error.

Agents can support follow-up runs by passing in the returned session_id. You should only use a follow-up run for related edits or questions about a resource you just modified. Otherwise, use the management API or start a new agent session.`;

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
      description: GET_KNOCK_AGENT_DESCRIPTION,
      inputSchema: {
        session_id: z
          .string()
          .uuid()
          .describe("Agent session ID from start_knock_agent"),
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
