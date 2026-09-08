import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/codemode", () => ({
  DynamicWorkerExecutor: class {
    execute = vi.fn();
  },
  resolveProvider: vi.fn((provider: unknown) => provider),
}));

import { registerCodeModeVariant } from "./core";

describe("code mode environment examples", () => {
  it("omits environment from read and write examples and documents explicit targeting", () => {
    const registerTool = vi.fn();

    registerCodeModeVariant(
      { registerTool } as unknown as McpServer,
      { LOADER: {} } as Env,
      { tokenId: "token-1", clientId: "client-1" },
      {
        variant: "mapi",
        namespace: "mapi",
        baseUrl: "https://control.knock.app",
        description: "Management API",
        accessMode: "read_write",
        resolveAuth: vi.fn(),
      },
    );

    const registrations = new Map(
      registerTool.mock.calls.map(([name, definition]) => [name, definition]),
    );
    const readDescription = registrations.get("execute_mapi_read").description as string;
    const writeDescription = registrations.get("execute_mapi_write").description as string;

    for (const description of [readDescription, writeDescription]) {
      expect(description).not.toContain('query: { environment: "development" }');
      expect(description).toContain("Omit `environment` to use the account's default environment");
      expect(description).toContain("explicitly target another environment");
    }
  });
});
