import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import {
  validateAgentEnvironment,
  validateAgentPrompt,
  validateAgentSessionId,
} from "./validation";

const context = { sessionId: "550e8400-e29b-41d4-a716-446655440000", runId: "run-1" };

describe("validateAgentSessionId", () => {
  it("accepts UUID session ids", () => {
    const result = validateAgentSessionId(context.sessionId, context);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value).toBe(context.sessionId);
  });

  it("rejects non-UUID session ids", () => {
    const result = validateAgentSessionId("../evil", context);
    expect(Result.isError(result)).toBe(true);
  });
});

describe("validateAgentEnvironment", () => {
  it("accepts valid environment slugs", () => {
    expect(Result.isOk(validateAgentEnvironment("development", context))).toBe(true);
    expect(Result.isOk(validateAgentEnvironment("staging", context))).toBe(true);
  });

  it("rejects invalid environment slugs", () => {
    expect(Result.isError(validateAgentEnvironment("../prod", context))).toBe(true);
  });
});

describe("validateAgentPrompt", () => {
  it("rejects prompts over the max length", () => {
    const result = validateAgentPrompt("x".repeat(32_001), context);
    expect(Result.isError(result)).toBe(true);
  });
});
