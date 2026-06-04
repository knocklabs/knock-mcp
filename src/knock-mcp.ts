import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import KnockMgmt from "@knocklabs/mgmt";
import { Knock } from "@knocklabs/node";
import * as Sentry from "@sentry/cloudflare";

import { tools, type KnockToolType } from "@knocklabs/agent-toolkit/core";

import { registerMapiCodeMode } from "./code-mode/mapi";
import { registerUseKnockAgent } from "./agent/use-knock-agent";
import { getKnockControlBaseUrl } from "./knock-control-url";
import type { Props } from "./types";
import {
  AGENT_CATEGORY,
  CODE_MODE_MAPI_CATEGORY,
  resolveEffectiveSelectedGroups,
  resolveGroupsToCategories,
} from "./tool-groups";
import { KNOCK_MCP_SERVER_VERSION } from "./mcp-server-version";
import { getOrRefreshKnockToken } from "./token-store";

function createKnockClient(config: {
  serviceToken: string;
  clientId: string;
  baseURL: string;
}) {
  const defaultHeaders: Record<string, string> = {
    "x-knock-client-id": config.clientId,
  };

  const client = new KnockMgmt({
    serviceToken: config.serviceToken,
    baseURL: config.baseURL,
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
  server = Sentry.wrapMcpServerWithSentry(
    new McpServer({ name: "Knock", version: KNOCK_MCP_SERVER_VERSION }),
  );

  async init() {
    const props = this.props;
    if (!props?.tokenId) {
      throw new Error("MCP session missing tokenId; please re-authenticate.");
    }
    if (!props.clientId) {
      // Sessions created before clientId was added to Props (pre-2026-03-24) land here.
      // Their requests to mAPI would silently 401 because we wouldn't send x-knock-client-id;
      // fail loudly instead so the MCP client surfaces the need to re-auth.
      throw new Error("MCP session missing clientId; please re-authenticate.");
    }

    Sentry.setUser({ id: props.userId, email: props.email });
    Sentry.setTag("knock.client_id", props.clientId);

    const getClient = async () => {
      const accessToken = await getOrRefreshKnockToken(this.env, props.tokenId);
      const config = { serviceToken: accessToken, clientId: props.clientId };
      return {
        knockClient: createKnockClient({
          ...config,
          baseURL: getKnockControlBaseUrl(this.env),
        }),
        config,
      };
    };

    const effectiveGroups = resolveEffectiveSelectedGroups(props.selectedGroups);
    const categories = resolveGroupsToCategories(effectiveGroups);

    if (categories.includes(CODE_MODE_MAPI_CATEGORY)) {
      registerMapiCodeMode(this.server, this.env, props);
    }

    if (categories.includes(AGENT_CATEGORY)) {
      registerUseKnockAgent(this.server, this.env, props);
    }

    const toolkitCategories = categories.filter((c) => !c.startsWith("__"));

    const enabledTools = toolkitCategories.flatMap((cat) =>
      Object.values((tools as Record<string, Record<string, KnockToolType>>)[cat] ?? {}),
    );

    enabledTools.forEach((tool) => {
      // Agent-toolkit may ship zod v3 schemas; root uses zod v4 — normalize via unknown.
      const toolParams = (tool.parameters ?? z.object({})) as unknown as z.ZodObject<z.ZodRawShape>;

      this.server.registerTool(
        tool.method,
        { description: tool.description, inputSchema: toolParams.shape },
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
    });
  }
}
