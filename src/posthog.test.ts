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

  it("does not instrument the server without a project token", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });

    const result = instrumentPostHogMcp(
      server,
      { POSTHOG_PROJECT_TOKEN: undefined, POSTHOG_HOST: "https://us.i.posthog.com" },
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
      { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" },
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
        captureModel: true,
        enableConversationId: true,
        enableExceptionAutocapture: false,
        reportMissing: true,
        identify: {
          distinctId: "user_1",
          properties: { authKind: "oauth", email: "user@example.com" },
        },
      }),
    );
  });

  it("groups service-token analytics by Knock account", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });

    const client = instrumentPostHogMcp(
      server,
      { POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: undefined },
      {
        authKind: "service_token",
        accountSlug: "acme",
        accountName: "Acme, Inc.",
      },
      vi.fn(),
    );

    expect(instrument).toHaveBeenCalledWith(
      server,
      client,
      expect.objectContaining({
        reportMissing: true,
        identify: {
          distinctId: "account:acme",
          properties: {
            authKind: "service_token",
            accountSlug: "acme",
            accountName: "Acme, Inc.",
          },
          groups: { account: "acme" },
        },
      }),
    );
  });
});
