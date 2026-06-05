import { Result } from "better-result";

import { formatAgentErrorForMcp, toAgentNetworkError, type AgentError } from "./errors";
import type { AgentRunResult } from "./events";
import { formatAgentResult, type AgentMcpToolResponse } from "./format";

export type { AgentMcpToolResponse };

export function toAgentMcpToolResponse(
  result: Result<AgentRunResult, AgentError>,
): AgentMcpToolResponse {
  if (Result.isError(result)) {
    return {
      content: [{ type: "text", text: formatAgentErrorForMcp(result.error) }],
      isError: true,
    };
  }
  return formatAgentResult(result.value);
}

export async function runKnockAgentTool(
  fn: () => Promise<Result<AgentRunResult, AgentError>>,
): Promise<AgentMcpToolResponse> {
  const result = await Result.tryPromise(fn);
  if (Result.isError(result)) {
    return toAgentMcpToolResponse(Result.err(toAgentNetworkError(result.error)));
  }
  return toAgentMcpToolResponse(result.value);
}
