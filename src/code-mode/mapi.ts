import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Props } from "../types";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { resolveKnockAccessToken } from "../session-auth";
import { registerCodeModeVariant } from "./core";

/**
 * Code Mode for the Knock Management API (`KNOCK_CONTROL_URL`).
 * Registers \`search_mapi\`, \`execute_mapi_read\` (GET), and \`execute_mapi_write\` when write access is enabled.
 */
export function registerMapiCodeMode(server: McpServer, env: Env, props: Props): void {
  const accessMode = props.mapiAccessMode ?? "read_write";

  registerCodeModeVariant(server, env, props, {
    variant: "mapi",
    namespace: "mapi",
    baseUrl: getKnockControlBaseUrl(env),
    accessMode,
    description:
      "This is the Knock Management API (control plane). Use it to define and configure workflows, channels, templates, broadcasts, guides, layouts, partials, commits, environments, and other account resources. Do not use it to trigger workflows or manage environment-scoped runtime data such as users, tenants, objects, preferences, schedules, subscriptions, or messages; use API code mode (`search_api`, `execute_api_read`, `execute_api_write`) for those operations.",
    resolveAuth: async (env, props) => {
      const token = await resolveKnockAccessToken(env, props);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (props.clientId) {
        headers["x-knock-client-id"] = props.clientId;
      }
      return { headers };
    },
  });
}
