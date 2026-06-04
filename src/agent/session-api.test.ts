import { describe, expect, it, vi } from "vitest";

import { KNOCK_MCP_SERVER_VERSION } from "../mcp-server-version";
import type { Props } from "../types";
import {
  AGENT_SESSION_SOURCE,
  buildCreateSessionBody,
  buildFollowUpRunBody,
  resolveAgentAuthHeaders,
} from "./session-api";

vi.mock("../token-store", () => ({
  getOrRefreshKnockToken: vi.fn().mockResolvedValue("test-token"),
}));

const baseProps: Props = {
  tokenId: "token-1",
  clientId: "client-1",
};

const baseEnv = { KNOCK_CONTROL_URL: "https://control.knock.app" } as Env;

describe("agent session bodies", () => {
  it("uses mcp as the agent session source", () => {
    expect(buildCreateSessionBody("session-1", "run-1", "prompt", "development").source).toBe(
      AGENT_SESSION_SOURCE,
    );
    expect(buildFollowUpRunBody("run-2", "prompt", "staging").source).toBe(AGENT_SESSION_SOURCE);
  });
});

describe("resolveAgentAuthHeaders", () => {
  it("includes client identification headers alongside auth", async () => {
    const headers = await resolveAgentAuthHeaders(baseEnv, baseProps);

    expect(headers).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "x-knock-client-id": "client-1",
      "User-Agent": `Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`,
    });
    expect(JSON.parse(headers["x-knock-client-user-agent"])).toEqual({
      binding: "mcp",
      version: KNOCK_MCP_SERVER_VERSION,
    });
  });

  it("sends x-knock-mcp-caller when OAuth client attribution is on props", async () => {
    const headers = await resolveAgentAuthHeaders(baseEnv, {
      ...baseProps,
      clientApplication: { name: "Cursor", url: "https://cursor.com" },
    });

    expect(headers["x-knock-mcp-caller"]).toBe("Cursor");
    expect(headers["User-Agent"]).toBe(`Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`);
  });
});
