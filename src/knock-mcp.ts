import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as Sentry from "@sentry/cloudflare";

import { tools, toolPermissions, type KnockToolType } from "@knocklabs/agent-toolkit/core";

import { registerMapiCodeMode } from "./code-mode/mapi";
import { registerKnockAgentTools } from "./agent/knock-agent-tools";
import { createKnockClient } from "./knock-client";
import { getKnockControlBaseUrl } from "./knock-control-url";
import {
  AGENT_CATEGORY,
  CODE_MODE_MAPI_CATEGORY,
  resolveEffectiveSelectedGroups,
  resolveGroupsToCategories,
} from "./tool-groups";
import { KNOCK_MCP_SERVER_VERSION } from "./mcp-server-version";
import type { BuildServerInput } from "./mcp-handler";
import { resolveKnockAccessToken } from "./session-auth";
import { instrumentPostHogMcp } from "./posthog";
import { answerUnknownTools } from "./unknown-tools";

type ToolkitPermissionTier = {
  read?: string[];
  manage?: string[];
  trigger?: string[];
};

/** Read-only only when the tool is in the read tier; manage/trigger/unlisted are side-effecting. */
function toolkitToolIsReadOnly(category: string, toolKey: string): boolean {
  const permissions = (toolPermissions as Record<string, ToolkitPermissionTier>)[category];
  return Boolean(permissions?.read?.includes(toolKey));
}

/** Builds the MCP server for one request: the tools its grant selected, with analytics around them. */
export function buildMcpServer({ env, props, waitUntil }: BuildServerInput): McpServer {
  const server = Sentry.wrapMcpServerWithSentry(
    new McpServer(
      { name: "Knock", version: KNOCK_MCP_SERVER_VERSION },
      // The tools can't change during a connection, so clients needn't listen for changes.
      { capabilities: { tools: { listChanged: false } } },
    ),
  );

  const getClient = async () => {
    const accessToken = await resolveKnockAccessToken(env, props);
    const config = { serviceToken: accessToken, clientId: props.clientId };
    return {
      knockClient: createKnockClient({
        ...config,
        baseURL: getKnockControlBaseUrl(env),
      }),
      config,
    };
  };

  const effectiveGroups = resolveEffectiveSelectedGroups(props.selectedGroups);
  const categories = resolveGroupsToCategories(effectiveGroups);

  if (categories.includes(CODE_MODE_MAPI_CATEGORY)) {
    registerMapiCodeMode(server, env, props);
  }

  if (categories.includes(AGENT_CATEGORY)) {
    registerKnockAgentTools(server, env, props);
  }

  const toolkitCategories = categories.filter((c) => !c.startsWith("__"));

  for (const cat of toolkitCategories) {
    const categoryTools = (tools as Record<string, Record<string, KnockToolType>>)[cat] ?? {};

    for (const [toolKey, tool] of Object.entries(categoryTools)) {
      // The toolkit's types come from its own zod; package.json pins one zod at runtime.
      const toolParams = (tool.parameters ?? z.object({})) as unknown as z.ZodObject<z.ZodRawShape>;
      const isReadOnly = toolkitToolIsReadOnly(cat, toolKey);

      server.registerTool(
        tool.method,
        {
          title: tool.name,
          description: tool.description,
          inputSchema: z.object(toolParams.shape),
          // Claude Connectors Directory checks annotations.title (not only top-level title).
          annotations: isReadOnly
            ? {
                title: tool.name,
                readOnlyHint: true,
                destructiveHint: false,
                openWorldHint: true,
              }
            : {
                title: tool.name,
                readOnlyHint: false,
                destructiveHint: true,
                openWorldHint: true,
              },
        },
        async (arg: unknown) => {
          Sentry.setTag("knock.tool", tool.method);
          const { knockClient, config } = await getClient();
          // Toolkit types may resolve @knocklabs/* from a different copy (e.g. npm link).
          const res = await tool.bindExecute(
            knockClient as unknown as Parameters<typeof tool.bindExecute>[0],
            config,
          )(arg);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(res) }],
          };
        },
      );
    }
  }

  answerUnknownTools(server);
  // Last, so analytics wraps the final handlers and sees calls to unknown tools too.
  instrumentPostHogMcp(server, env, props, waitUntil);
  return server;
}
