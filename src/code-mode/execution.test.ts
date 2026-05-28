import { Result } from "better-result";
import { describe, expect, it, vi } from "vitest";

import { ExecutionError } from "./errors";
import { runCodeModeExecution } from "./execution";

describe("runCodeModeExecution", () => {
  it("formats successful executor results", async () => {
    const result = await runCodeModeExecution(async () => ({
      result: { items: [1] },
      logs: ["log line"],
    }));

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toContain('"items"');
      expect(result.value).toContain("log line");
    }
  });

  it("maps sandbox execution errors", async () => {
    const result = await runCodeModeExecution(async () => ({
      result: null,
      error: "SyntaxError: unexpected token",
    }));

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ExecutionError);
      expect((result.error as ExecutionError).message).toBe("SyntaxError: unexpected token");
    }
  });

  it("maps thrown executor failures", async () => {
    const result = await runCodeModeExecution(async () => {
      throw new Error("loader timeout");
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(ExecutionError);
      expect((result.error as ExecutionError).message).toBe("loader timeout");
    }
  });
});
