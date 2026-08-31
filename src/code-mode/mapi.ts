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
      "This is the Management API: workflows, channels, templates, commits, and configuration.",
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
