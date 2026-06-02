import { describe, expect, it } from "vitest";

import {
  createAgentRunAccumulator,
  finalizeAgentRunResult,
  parseAgentEventLine,
  reduceAgentEvent,
} from "./events";

function wireEvent(type: string, value?: Record<string, unknown>): string {
  return JSON.stringify(value ? { type, value } : { type });
}

describe("parseAgentEventLine", () => {
  it("parses Knock agent events with a top-level value object", () => {
    const parsed = parseAgentEventLine(
      wireEvent("toolCall", {
        name: "upsert_workflow",
        callId: "toolu_123",
        arguments: '{"workflow_key":"onboarding-email"}',
      }),
    );

    expect(parsed).toEqual({
      type: "toolCall",
      payload: {
        name: "upsert_workflow",
        callId: "toolu_123",
        arguments: '{"workflow_key":"onboarding-email"}',
      },
    });
  });

  it("parses text content nested under value.value", () => {
    const parsed = parseAgentEventLine(
      wireEvent("textContent", {
        type: "complete",
        value: "Hello from the agent",
      }),
    );

    expect(parsed?.type).toBe("textContent");
    expect(parsed?.payload.value).toBe("Hello from the agent");
  });

  it("returns null for invalid or empty lines", () => {
    expect(parseAgentEventLine("")).toBeNull();
    expect(parseAgentEventLine("not-json")).toBeNull();
    expect(parseAgentEventLine("{}")).toBeNull();
  });
});

describe("reduceAgentEvent", () => {
  it("accumulates a realistic Knock agent run sequence", () => {
    let state = createAgentRunAccumulator("session-1", "run-1");

    const events = [
      wireEvent("runInitializing"),
      wireEvent("toolCall", {
        name: "skill",
        callId: "toolu_skill",
        arguments: '{"skill_name":"workflows"}',
      }),
      wireEvent("toolCall", {
        name: "bash",
        callId: "toolu_bash",
        arguments: '{"command":"cat /knock/channels.json"}',
      }),
      wireEvent("textContent", {
        type: "complete",
        value: "I have everything I need. Let me create the onboarding workflow now.",
      }),
      wireEvent("toolCall", {
        name: "upsert_workflow",
        callId: "toolu_upsert",
        arguments: '{"workflow_key":"onboarding-email"}',
      }),
      wireEvent("signal", {
        action: "modified_resources_updated",
        resource_action: "created",
        resource_key: "onboarding-email",
        resource_type: "workflow",
        type: "knock:session",
      }),
      wireEvent("textContent", {
        type: "complete",
        value: "The onboarding workflow is created and ready.",
      }),
      wireEvent("runEnd"),
    ];

    for (const line of events) {
      const parsed = parseAgentEventLine(line);
      expect(parsed).not.toBeNull();
      state = reduceAgentEvent(state, parsed!);
    }

    const result = finalizeAgentRunResult(state);

    expect(result).toMatchObject({
      status: "complete",
      sessionId: "session-1",
      runId: "run-1",
      text: [
        "I have everything I need. Let me create the onboarding workflow now.",
        "The onboarding workflow is created and ready.",
      ].join("\n\n"),
      toolCalls: [
        { callId: "toolu_skill", name: "skill", input: '{"skill_name":"workflows"}' },
        { callId: "toolu_bash", name: "bash", input: '{"command":"cat /knock/channels.json"}' },
        {
          callId: "toolu_upsert",
          name: "upsert_workflow",
          input: '{"workflow_key":"onboarding-email"}',
        },
      ],
      modifiedResources: [
        { type: "workflow", key: "onboarding-email", action: "created" },
      ],
    });
  });

  it("concatenates streaming text deltas into one block", () => {
    let state = createAgentRunAccumulator("session-delta", "run-delta");

    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { is_delta: true, content: "Hello" },
    });
    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { is_delta: true, content: ", world" },
    });
    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { is_delta: false },
    });
    state = reduceAgentEvent(state, { type: "runEnd", payload: {} });

    expect(finalizeAgentRunResult(state).text).toBe("Hello, world");
  });

  it("dedupes repeated toolCall events for the same call id", () => {
    let state = createAgentRunAccumulator("session-tools", "run-tools");

    state = reduceAgentEvent(state, {
      type: "toolCall",
      payload: {
        name: "bash",
        callId: "toolu_same",
        arguments: '{"command":"cat /knock/channels.json"}',
      },
    });
    state = reduceAgentEvent(state, {
      type: "toolCall",
      payload: {
        name: "bash",
        callId: "toolu_same",
        arguments: '{"command":"cat /knock/channels.json", "description":"updated"}',
      },
    });

    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCallCount).toBe(1);
  });

  it("ignores reasoning events for final output", () => {
    let state = createAgentRunAccumulator("session-reasoning", "run-reasoning");

    state = reduceAgentEvent(state, {
      type: "reasoning",
      payload: { type: "complete", value: "Thinking about workflows..." },
    });
    state = reduceAgentEvent(state, {
      type: "textContent",
      payload: { type: "complete", value: "Done." },
    });
    state = reduceAgentEvent(state, { type: "runEnd", payload: {} });

    expect(finalizeAgentRunResult(state).text).toBe("Done.");
  });

  it("captures runError terminal events using error_message", () => {
    let state = createAgentRunAccumulator("session-2", "run-2");
    state = reduceAgentEvent(state, {
      type: "runError",
      payload: { error_message: "Something went wrong" },
    });

    const result = finalizeAgentRunResult(state);
    expect(result.status).toBe("error");
    expect(result.error).toBe("Something went wrong");
  });

  it("ignores runInitializing without changing terminal state", () => {
    const state = createAgentRunAccumulator("session-3", "run-3");
    const next = reduceAgentEvent(state, {
      type: "runInitializing",
      payload: {},
    });
    expect(next.eventCount).toBe(1);
    expect(next.status).toBe("running");
    expect(next.isTerminal).toBe(false);
  });

  it("parses modified resources using resource_type and resource_key on signals", () => {
    let state = createAgentRunAccumulator("session-4", "run-4");
    state = reduceAgentEvent(state, {
      type: "signal",
      payload: {
        action: "modified_resources_updated",
        resource_action: "created",
        resource_key: "onboarding-email",
        resource_type: "workflow",
        type: "knock:session",
      },
    });

    expect(state.modifiedResources).toEqual([
      { type: "workflow", key: "onboarding-email", name: undefined, action: "created" },
    ]);
  });

  it("ignores unknown event types without throwing", () => {
    const state = createAgentRunAccumulator("session-5", "run-5");
    const next = reduceAgentEvent(state, {
      type: "unknownEvent",
      payload: { foo: "bar" },
    });
    expect(next.eventCount).toBe(1);
    expect(next.status).toBe("running");
  });
});
