import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { tools, allTools, createKnockClient, type KnockToolType } from "@knocklabs/agent-toolkit/core";

import type { Env, Props } from "./types";
import { resolveGroupsToCategories } from "./tool-groups";

export class KnockMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "Knock", version: "1.0.0" });

  async init() {
    const config = { serviceToken: this.props.accessToken };
    const knockClient = createKnockClient(config);

    const enabledTools = this.props.selectedGroups
      ? resolveGroupsToCategories(this.props.selectedGroups)
          .flatMap((cat) => Object.values((tools as Record<string, Record<string, KnockToolType>>)[cat] ?? {}))
      : (Object.values(allTools as Record<string, KnockToolType>));

    enabledTools.forEach((tool) => {
      // Cast through unknown to handle potential zod instance mismatch between packages
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolParams = (tool.parameters ?? z.object({})) as unknown as z.ZodObject<any>;

      this.server.registerTool(
        tool.method,
        { description: tool.description, inputSchema: toolParams.shape },
        async (arg: unknown) => {
          const res = await tool.bindExecute(knockClient, config)(arg);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(res) }],
          };
        },
      );
    });
  }
}
