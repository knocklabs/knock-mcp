import { Result } from "better-result";

import { formatCodeModeError } from "./errors";

export type McpToolResponse = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

export function toMcpToolResponse(result: Result<string, unknown>): McpToolResponse {
  if (Result.isError(result)) {
    return {
      content: [{ type: "text", text: `Error: ${formatCodeModeError(result.error)}` }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: result.value }] };
}

export async function runCodeModeTool(
  fn: () => Promise<Result<string, unknown>>,
): Promise<McpToolResponse> {
  const result = await Result.tryPromise(fn);
  if (Result.isError(result)) {
    return toMcpToolResponse(Result.err(result.error));
  }
  return toMcpToolResponse(result.value);
}
