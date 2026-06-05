import { describe, expect, it } from "vitest";

import { KNOCK_MCP_SERVER_VERSION } from "./mcp-server-version";
import {
  KNOCK_MCP_CALLER_HEADER,
  buildKnockMcpClientHeaders,
} from "./knock-client-user-agent";

describe("buildKnockMcpClientHeaders", () => {
  it("sends a stable User-Agent and minimal JSON metadata", () => {
    const headers = buildKnockMcpClientHeaders();

    expect(headers["User-Agent"]).toBe(`Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`);
    expect(JSON.parse(headers["x-knock-client-user-agent"])).toEqual({
      binding: "mcp",
      version: KNOCK_MCP_SERVER_VERSION,
    });
    expect(headers[KNOCK_MCP_CALLER_HEADER]).toBeUndefined();
  });

  it("sends the MCP host name on x-knock-mcp-caller when provided", () => {
    const headers = buildKnockMcpClientHeaders({ name: "Cursor", url: "https://cursor.com" });

    expect(headers[KNOCK_MCP_CALLER_HEADER]).toBe("Cursor");
    expect(headers["User-Agent"]).toBe(`Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`);
    expect(JSON.parse(headers["x-knock-client-user-agent"])).toEqual({
      binding: "mcp",
      version: KNOCK_MCP_SERVER_VERSION,
    });
  });
});
