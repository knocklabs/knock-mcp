import { afterEach, describe, expect, it, vi } from "vitest";

import type { Props } from "../types";
import { formatAgentResult } from "./format";
import { finalizeAgentRunResult, createAgentRunAccumulator, reduceAgentEvent } from "./events";

describe("formatAgentResult", () => {
  it("formats successful runs with session id and modified resources", () => {
    let state = createAgentRunAccumulator("session-abc", "run-abc");
    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { text: "Created workflow welcome." },
    });
    state = reduceAgentEvent(state, {
      type: "signal",
      payload: {
        resources: [{ type: "workflow", key: "welcome", action: "created" }],
      },
    });
    state = reduceAgentEvent(state, { type: "runEnd", payload: {} });

    const formatted = formatAgentResult(finalizeAgentRunResult(state));

    expect(formatted.isError).toBeUndefined();
    expect(formatted.content[0].text).toContain("Session ID: session-abc");
    expect(formatted.content[0].text).toContain("Created workflow welcome.");
    expect(formatted.content[0].text).toContain("- created workflow welcome");
  });

  it("marks timeout and error results as MCP errors", () => {
    const timeout = formatAgentResult({
      status: "timeout",
      text: "Partial output",
      toolCalls: [],
      modifiedResources: [],
      sessionId: "session-timeout",
      runId: "run-timeout",
      error: "Agent run timed out before completion",
    });

    expect(timeout.isError).toBe(true);
    expect(timeout.content[0].text).toContain("Session ID: session-timeout");
    expect(timeout.content[0].text).toContain("timed out");

    const error = formatAgentResult({
      status: "error",
      text: "",
      toolCalls: [],
      modifiedResources: [],
      sessionId: "session-error",
      runId: "run-error",
      error: "Agent API request failed",
    });

    expect(error.isError).toBe(true);
    expect(error.content[0].text).toContain("Session ID: session-error");
    expect(error.content[0].text).toContain("Agent API request failed");
  });
});
