import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { exchangeKnockApiKey } from "../knock-client";
import { getKnockApiBaseUrl } from "../knock-api-url";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { resolveKnockAccessToken } from "../session-auth";
import type { Props } from "../types";
import { registerCodeModeVariant } from "./core";

const API_DESCRIPTION = `This is the Knock API (data plane). Use it to trigger workflows and manage environment-scoped runtime data: users, tenants, objects, preferences, schedules, subscriptions, messages, feeds, channel data, and provider interactions.

Do not use it to define or configure workflows, channels, templates, broadcasts, guides, layouts, partials, commits, or environments. For account configuration, use Management API code mode (\`search_mapi\`, \`execute_mapi_read\`, \`execute_mapi_write\`) or the hosted Knock agent.`;

/**
 * Code Mode for the Knock public API (`KNOCK_API_URL`).
 * Registers `search_api`, `execute_api_read`, and `execute_api_write` when write access is enabled.
 */
export function registerApiCodeMode(server: McpServer, env: Env, props: Props): void {
  const accessMode = props.apiAccessMode ?? "read";

  registerCodeModeVariant(server, env, props, {
    variant: "api",
    namespace: "api",
    baseUrl: getKnockApiBaseUrl(env),
    accessMode,
    environmentTargeting: "request",
    description: API_DESCRIPTION,
    readExample: `async () => {
  const res = await api.request({
    method: "GET",
    path: "/v1/users",
  });
  return { status: res.status, items: res.result.items, page_info: res.result.page_info };
}`,
    writeExample: `async () => {
  const res = await api.request({
    method: "PUT",
    path: "/v1/users/user_123",
    environment: "development",
    body: { name: "Ada Lovelace", email: "ada@example.com" },
  });
  return { status: res.status, result: res.result };
}`,
    resolveAuth: async (env, props, request) => {
      const token = await resolveKnockAccessToken(env, props);
      const apiKey = await exchangeKnockApiKey(
        {
          serviceToken: token,
          clientId: props.clientId,
          baseURL: getKnockControlBaseUrl(env),
        },
        request.environment,
      );
      return {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-knock-client-id": props.clientId,
        },
      };
    },
  });
}
