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

/** The result of asking for a run to stop. */
export function stopAgentMcpToolResponse(
  result: Result<{ sessionId: string }, AgentError>,
  pollTool: string,
): AgentMcpToolResponse {
  if (Result.isError(result)) {
    return {
      content: [{ type: "text", text: formatAgentErrorForMcp(result.error) }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: [
          `Session ID: ${result.value.sessionId}`,
          `Stop requested. The run ends within a moment, and changes it already made are kept. Call ${pollTool} with this session_id to see what it did.`,
        ].join("\n"),
      },
    ],
  };
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
