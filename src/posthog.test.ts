import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrument } from "@posthog/mcp";
import { PostHog } from "posthog-node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentPostHogMcp } from "./posthog";

vi.mock("@posthog/mcp", () => ({
  instrument: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return { capture: vi.fn() };
  }),
}));

describe("instrumentPostHogMcp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not instrument the server without a project API key", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });

    const result = instrumentPostHogMcp(
      server,
      { POSTHOG_PROJECT_API_KEY: undefined, POSTHOG_HOST: "https://us.i.posthog.com" },
      { userId: "user_1", email: "user@example.com" },
      vi.fn(),
    );

    expect(result).toBeUndefined();
    expect(PostHog).not.toHaveBeenCalled();
    expect(instrument).not.toHaveBeenCalled();
  });

  it("configures analytics and identifies the authenticated user", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const waitUntil = vi.fn();

    const client = instrumentPostHogMcp(
      server,
      { POSTHOG_PROJECT_API_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" },
      { userId: "user_1", email: "user@example.com" },
      waitUntil,
    );

    expect(PostHog).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      waitUntil,
    });
    expect(instrument).toHaveBeenCalledWith(
      server,
      client,
      expect.objectContaining({
        identify: {
          distinctId: "user_1",
          properties: { email: "user@example.com" },
        },
      }),
    );
  });
});
