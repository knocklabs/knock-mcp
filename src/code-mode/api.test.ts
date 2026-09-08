import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeKnockApiKey, registerCodeModeVariant, resolveKnockAccessToken } = vi.hoisted(
  () => ({
    exchangeKnockApiKey: vi.fn().mockResolvedValue("secret-api-key"),
    registerCodeModeVariant: vi.fn(),
    resolveKnockAccessToken: vi.fn().mockResolvedValue("management-token"),
  }),
);

vi.mock("../knock-client", () => ({ exchangeKnockApiKey }));
vi.mock("../session-auth", () => ({ resolveKnockAccessToken }));
vi.mock("./core", () => ({ registerCodeModeVariant }));

import { registerApiCodeMode } from "./api";

describe("registerApiCodeMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers a read-only public API variant by default with explicit API guidance", () => {
    registerApiCodeMode(
      {} as McpServer,
      {
        KNOCK_API_URL: "https://api.example.test/",
        KNOCK_CONTROL_URL: "https://control.example.test/",
      } as Env,
      { tokenId: "token-1", clientId: "client-1" },
    );

    expect(registerCodeModeVariant).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        variant: "api",
        namespace: "api",
        baseUrl: "https://api.example.test",
        accessMode: "read",
        environmentTargeting: "request",
        description: expect.stringContaining("Knock API (data plane)"),
      }),
    );
    const config = registerCodeModeVariant.mock.calls[0][3];
    expect(config.description).toContain("Management API code mode");
  });

  it("exchanges an environment-scoped key and returns host-owned auth headers", async () => {
    const env = {
      KNOCK_API_URL: "https://api.knock.app",
      KNOCK_CONTROL_URL: "https://control.knock.app/",
    } as Env;
    const props = {
      tokenId: "token-1",
      clientId: "client-1",
      apiAccessMode: "read_write" as const,
    };
    registerApiCodeMode({} as McpServer, env, props);

    const config = registerCodeModeVariant.mock.calls[0][3];
    await expect(
      config.resolveAuth(env, props, {
        method: "GET",
        path: "/v1/users",
        environment: "production",
      }),
    ).resolves.toEqual({
      headers: {
        Authorization: "Bearer secret-api-key",
        "x-knock-client-id": "client-1",
      },
    });
    expect(resolveKnockAccessToken).toHaveBeenCalledWith(env, props);
    expect(exchangeKnockApiKey).toHaveBeenCalledWith(
      {
        serviceToken: "management-token",
        clientId: "client-1",
        baseURL: "https://control.knock.app",
      },
      "production",
    );
    expect(config.accessMode).toBe("read_write");
  });
});
