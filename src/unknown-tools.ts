import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";

type CallHandler = (request: { params: { name: string } }, ctx: unknown) => Promise<CallToolResult>;

/**
 * Answers calls to tools this server doesn't have with an error result the
 * model can read, for example a write tool its grant leaves out. The SDK
 * throws a protocol error instead, which clients don't always show the model.
 * Call after every tool is registered.
 */
export function answerUnknownTools(server: McpServer): void {
  // The SDK keeps both private.
  const { _registeredTools: tools } = server as unknown as {
    _registeredTools: Record<string, unknown>;
  };
  const inner = (
    server.server as unknown as { _requestHandlers: Map<string, CallHandler> }
  )._requestHandlers.get("tools/call");
  if (!inner) throw new Error("answerUnknownTools: no tools/call handler; register tools first");

  server.server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name } = request.params;
    if (Object.hasOwn(tools, name)) return inner(request, ctx);
    return { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true };
  });
}
