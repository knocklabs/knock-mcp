import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import { ExecutionError } from "./errors";
import { runCodeModeTool, toMcpToolResponse } from "./mcp-response";

describe("toMcpToolResponse", () => {
  it("returns text content on success", () => {
    const response = toMcpToolResponse(Result.ok("hello"));
    expect(response).toEqual({ content: [{ type: "text", text: "hello" }] });
    expect(response.isError).toBeUndefined();
  });

  it("returns isError with formatted message on failure", () => {
    const response = toMcpToolResponse(
      Result.err(new ExecutionError({ message: "sandbox failed" })),
    );
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("Error: sandbox failed");
  });
});

describe("runCodeModeTool", () => {
  it("maps successful tool execution", async () => {
    const response = await runCodeModeTool(async () => Result.ok("done"));
    expect(response.content[0].text).toBe("done");
  });

  it("maps returned Result errors", async () => {
    const response = await runCodeModeTool(async () =>
      Result.err(new ExecutionError({ message: "bad code" })),
    );
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("Error: bad code");
  });

  it("maps thrown errors from the tool fn", async () => {
    const response = await runCodeModeTool(async () => {
      throw new Error("unexpected");
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("unexpected");
  });
});
