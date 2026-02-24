import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import KnockMgmt from "@knocklabs/mgmt";
import { Knock } from "@knocklabs/node";

import { tools, allTools, type KnockToolType } from "@knocklabs/agent-toolkit/core";

import type { Env, Props } from "./types";
import { resolveGroupsToCategories } from "./tool-groups";
import { getOrRefreshKnockToken } from "./token-store";

function createKnockClient(config: { serviceToken: string; clientId?: string }) {
  const defaultHeaders: Record<string, string> = {};
  if (config.clientId) {
    defaultHeaders["x-knock-client-id"] = config.clientId;
  }

  const client = new KnockMgmt({
    serviceToken: config.serviceToken,
    defaultHeaders,
  });

  return Object.assign(client, {
    publicApi: async (environmentSlug?: string): Promise<Knock> => {
      const environment = environmentSlug ?? "development";
      const { api_key } = await client.apiKeys.exchange({ environment });
      return new Knock({ apiKey: api_key, defaultHeaders });
    },
  });
}

export class KnockMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "Knock", version: "1.0.0" });

  async init() {
    const getClient = async () => {
      const accessToken = await getOrRefreshKnockToken(this.env, this.props.tokenId);
      const config = { serviceToken: accessToken };
      return { knockClient: createKnockClient({ ...config, clientId: this.props.clientId }), config };
    };

    const enabledTools = this.props.selectedGroups
      ? resolveGroupsToCategories(this.props.selectedGroups).flatMap((cat) =>
          Object.values((tools as Record<string, Record<string, KnockToolType>>)[cat] ?? {}),
        )
      : Object.values(allTools as Record<string, KnockToolType>);

    enabledTools.forEach((tool) => {
      // Cast through unknown to handle potential zod instance mismatch between packages
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolParams = (tool.parameters ?? z.object({})) as unknown as z.ZodObject<any>;

      this.server.registerTool(
        tool.method,
        { description: tool.description, inputSchema: toolParams.shape },
        async (arg: unknown) => {
          const { knockClient, config } = await getClient();
          const res = await tool.bindExecute(knockClient, config)(arg);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(res) }],
          };
        },
      );
    });
  }
}
