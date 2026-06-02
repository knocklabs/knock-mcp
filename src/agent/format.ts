import type { AgentRunResult } from "./events";
import { truncateCodeModeResponse } from "../code-mode/utils";

export type AgentMcpToolResponse = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

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
    `Run ID: ${result.runId}`,
    `Status: ${result.status}`,
  ];

  if (result.text) {
    sections.push("", "Agent response:", result.text);
  }

  sections.push("", formatToolCalls(result), "", formatModifiedResources(result));

  if (result.status === "timeout") {
    sections.push(
      "",
      "The agent run timed out before completion. Re-run use_knock_agent with the same session_id to continue.",
    );
  }

  if (result.status === "cancelled") {
    sections.push(
      "",
      "The agent run was cancelled before completion. Re-run use_knock_agent with the same session_id to continue if needed.",
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
