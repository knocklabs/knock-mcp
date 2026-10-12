import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { dropHandshakeEvents, instrumentPostHogMcp } from "./posthog";

type Captured = { event: string; distinctId: string; properties?: Record<string, unknown> };

async function runSession(callTool: boolean) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  server.registerTool("ping", { inputSchema: { value: z.string().optional() } }, async () => ({
    content: [{ type: "text" as const, text: "pong" }],
  }));

  const posthog = instrumentPostHogMcp(
    server,
    { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" },
    { userId: "user_1", email: "user@example.com" },
    vi.fn(),
  ) as PostHog;
  const captured: Captured[] = [];
  vi.spyOn(posthog, "capture").mockImplementation((message) => {
    captured.push(message as Captured);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await client.listTools();
  if (callTool) {
    await client.callTool({ name: "ping", arguments: { value: "hi" } });
  }
  await vi.waitFor(() => expect(captured.some((e) => e.event === "$mcp_tools_list")).toBe(true));
  await client.close();
  return captured;
}

describe("PostHog event filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends tool calls and drops the initialize and identify handshake events", async () => {
    const events = await runSession(true);
    await vi.waitFor(() => expect(events.some((e) => e.event === "$mcp_tool_call")).toBe(true));

    const names = events.map((e) => e.event);
    expect(names).not.toContain("$mcp_initialize");
    expect(names).not.toContain("$identify");
    expect(names).toContain("$mcp_tools_list");

    const toolCall = events.find((e) => e.event === "$mcp_tool_call");
    expect(toolCall).toMatchObject({
      distinctId: "user_1",
      properties: {
        $mcp_tool_name: "ping",
        $mcp_client_name: "claude-code",
        $set: { authKind: "oauth", email: "user@example.com" },
      },
    });
  });

  it("sends only tools/list for a session that never calls a tool", async () => {
    const events = await runSession(false);

    expect(events.map((e) => e.event)).toEqual(["$mcp_tools_list"]);
  });
});

describe("dropHandshakeEvents", () => {
  const payload = (event: string) => ({
    event,
    distinct_id: "user_1",
    properties: {},
    timestamp: new Date().toISOString(),
    type: "capture" as const,
  });

  it.each(["$mcp_initialize", "$identify"])("drops %s", (event) => {
    expect(dropHandshakeEvents(payload(event))).toBeNull();
  });

  it.each([
    "$mcp_tool_call",
    "$mcp_missing_capability",
    "$mcp_feedback",
    "$mcp_tools_list",
    "$exception",
  ])("keeps %s", (event) => {
    const event_ = payload(event);
    expect(dropHandshakeEvents(event_)).toBe(event_);
  });
});
