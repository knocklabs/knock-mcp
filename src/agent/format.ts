import type { AgentRunResult } from "./events";
import { truncateCodeModeResponse } from "../code-mode/utils";

export type AgentMcpToolResponse = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

const GET_KNOCK_AGENT_POLLING_HINT = [
  "The agent run is still in progress (Status: running).",
  "Call get_knock_agent with this session_id every few seconds.",
  "Stop polling when the tool result shows Status: complete (success) or Status: error (failure).",
].join(" ");

function formatModifiedResources(result: AgentRunResult): string {
  if (result.modifiedResources.length === 0) {
    return "Modified resources: none reported.";
  }

  const lines = result.modifiedResources.map((resource) => {
    const parts = [
      resource.action,
      resource.type,
      resource.key ?? resource.name,
    ].filter(Boolean);
    return `- ${parts.join(" ")}`.trim();
  });

  return ["Modified resources:", ...lines].join("\n");
}

function formatToolCalls(result: AgentRunResult): string {
  if (result.toolCalls.length === 0) {
    return "Tool calls: none.";
  }

  const lines = result.toolCalls.map((toolCall) => `- ${toolCall.name}`);
  return ["Tool calls:", ...lines].join("\n");
}

export function formatAgentResult(result: AgentRunResult): AgentMcpToolResponse {
  const sections = [
    `Session ID: ${result.sessionId}`,
    ...(result.runId ? [`Run ID: ${result.runId}`] : []),
    `Status: ${result.status}`,
  ];

  if (result.text) {
    sections.push("", "Agent response:", result.text);
  }

  sections.push("", formatToolCalls(result), "", formatModifiedResources(result));

  if (result.status === "running") {
    sections.push("", GET_KNOCK_AGENT_POLLING_HINT);
  }

  if (result.status === "timeout") {
    sections.push(
      "",
      "The agent run timed out before completion. Call get_knock_agent with the same session_id to check progress.",
    );
  }

  if (result.status === "cancelled") {
    sections.push(
      "",
      "The agent run was cancelled before completion. Start a new session or call get_knock_agent if the run may still be active.",
    );
  }

  if (result.error) {
    sections.push("", `Error: ${result.error}`);
  }

  const isError = result.status === "error" || result.status === "timeout";

  return {
    content: [{ type: "text", text: truncateCodeModeResponse(sections.join("\n")) }],
    ...(isError ? { isError: true } : {}),
  };
}
