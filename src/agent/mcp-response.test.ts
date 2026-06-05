import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import { AgentApiError } from "./errors";
import {
  createAgentRunAccumulator,
  finalizeAgentRunResult,
  reduceAgentEvent,
} from "./events";
import { runKnockAgentTool, toAgentMcpToolResponse } from "./mcp-response";

describe("toAgentMcpToolResponse", () => {
  it("formats successful run outcomes", () => {
    let state = createAgentRunAccumulator("session-1", "run-1");
    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { type: "complete", value: "Done." },
    });
    state = reduceAgentEvent(state, { type: "runEnd", payload: {} });

    const response = toAgentMcpToolResponse(Result.ok(finalizeAgentRunResult(state)));

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain("Session ID: session-1");
    expect(response.content[0].text).toContain("Done.");
  });

  it("returns isError for infrastructure failures with session context", () => {
    const response = toAgentMcpToolResponse(
      Result.err(
        new AgentApiError({
          message: "Unauthorized",
          status: 401,
          sessionId: "550e8400-e29b-41d4-a716-446655440000",
          runId: "run-1",
        }),
      ),
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Session ID: 550e8400-e29b-41d4-a716-446655440000");
    expect(response.content[0].text).toContain("Run ID: run-1");
    expect(response.content[0].text).toContain("Error: Unauthorized");
  });
});

describe("runKnockAgentTool", () => {
  it("maps successful session runs", async () => {
    const response = await runKnockAgentTool(async () =>
      Result.ok({
        status: "complete",
        text: "Done.",
        toolCalls: [],
        modifiedResources: [],
        sessionId: "session-1",
        runId: "run-1",
      }),
    );

    expect(response.content[0].text).toContain("Done.");
  });

  it("maps returned Result errors", async () => {
    const response = await runKnockAgentTool(async () =>
      Result.err(new AgentApiError({ message: "Unauthorized" })),
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Error: Unauthorized");
  });

  it("maps thrown errors from the tool fn", async () => {
    const response = await runKnockAgentTool(async () => {
      throw new Error("unexpected");
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("unexpected");
  });

  it("formats domain run errors from successful Result values", async () => {
    const response = await runKnockAgentTool(async () =>
      Result.ok({
        status: "error",
        text: "",
        toolCalls: [],
        modifiedResources: [],
        sessionId: "session-1",
        runId: "run-1",
        error: "Something went wrong",
      }),
    );

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Something went wrong");
  });
});
