import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { PostHog } from "posthog-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { dropLowSignalEvents, instrumentPostHogMcp, prepareEvents } from "./posthog";

type Captured = { event: string; distinctId: string; properties?: Record<string, unknown> };

async function runSession(callTool: boolean) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  server.registerTool(
    "ping",
    { inputSchema: z.object({ value: z.string().optional() }) },
    async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }),
  );

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
  // Capture runs after the response; let it settle so dropped events would have shown up.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await client.close();
  return captured;
}

describe("PostHog event filtering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends tool calls and drops initialize, identify and tools/list events", async () => {
    const events = await runSession(true);

    expect(events.map((e) => e.event)).toEqual(["$mcp_tool_call"]);

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

  it("sends nothing for a session that never calls a tool", async () => {
    const events = await runSession(false);

    expect(events).toEqual([]);
  });
});

describe("prepareEvents", () => {
  const toolCall = (properties: Record<string, unknown>) => ({
    event: "$mcp_tool_call",
    distinct_id: "user_1",
    properties,
    timestamp: new Date().toISOString(),
    type: "capture" as const,
  });

  it("names the client from its registration when the request doesn't", () => {
    expect(prepareEvents("Cursor")(toolCall({ a: 1 }))).toMatchObject({
      properties: { a: 1, $mcp_client_name: "Cursor" },
    });
  });

  it("keeps the name the request gave, and adds nothing without a registration", () => {
    const named = toolCall({ $mcp_client_name: "claude-code" });
    expect(prepareEvents("Cursor")(named)).toBe(named);
    const unnamed = toolCall({});
    expect(prepareEvents(undefined)(unnamed)).toBe(unnamed);
  });

  it("drops low-signal events either way", () => {
    expect(prepareEvents("Cursor")({ ...toolCall({}), event: "$mcp_tools_list" })).toBeNull();
  });
});

describe("dropLowSignalEvents", () => {
  const payload = (event: string) => ({
    event,
    distinct_id: "user_1",
    properties: {},
    timestamp: new Date().toISOString(),
    type: "capture" as const,
  });

  it.each(["$mcp_initialize", "$identify", "$mcp_tools_list"])("drops %s", (event) => {
    expect(dropLowSignalEvents(payload(event))).toBeNull();
  });

  it.each(["$mcp_tool_call", "$mcp_missing_capability", "$mcp_feedback", "$exception"])(
    "keeps %s",
    (event) => {
      const event_ = payload(event);
      expect(dropLowSignalEvents(event_)).toBe(event_);
    },
  );
});
