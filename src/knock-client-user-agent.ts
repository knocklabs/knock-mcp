import { KNOCK_MCP_SERVER_VERSION } from "./mcp-server-version";

export const KNOCK_MCP_CALLER_HEADER = "x-knock-mcp-caller";

export interface KnockClientApplicationInfo {
  name: string;
  url?: string;
}

const USER_AGENT_BASE = `Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`;
const CLIENT_JSON_BASE = JSON.stringify({
  binding: "mcp",
  version: KNOCK_MCP_SERVER_VERSION,
});

const DEFAULT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": USER_AGENT_BASE,
  "x-knock-client-user-agent": CLIENT_JSON_BASE,
});

export function buildKnockMcpClientHeaders(
  application?: KnockClientApplicationInfo,
): Record<string, string> {
  if (!application) {
    return { ...DEFAULT_HEADERS };
  }

  return {
    ...DEFAULT_HEADERS,
    [KNOCK_MCP_CALLER_HEADER]: application.name,
  };
}
