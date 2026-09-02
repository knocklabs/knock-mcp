import { describe, expect, it } from "vitest";

import { redactSentryEvent, shouldCaptureOAuthProviderError } from "./sentry";

describe("redactSentryEvent", () => {
  it("redacts Authorization and cookie request headers", () => {
    const event = redactSentryEvent({
      request: {
        headers: {
          Authorization: "Bearer knock_st_secret",
          Cookie: "oauth=abc",
          "X-Knock-Client-Id": "knock-mcp-service-token",
        },
      },
    });

    expect(event.request?.headers).toEqual({
      Authorization: "[Filtered]",
      Cookie: "[Filtered]",
      "X-Knock-Client-Id": "knock-mcp-service-token",
    });
  });

  it("redacts serviceToken extras without touching account identity", () => {
    const event = redactSentryEvent({
      extra: {
        serviceToken: "knock_st_secret",
        accountSlug: "acme",
      },
    });

    expect(event.extra).toEqual({
      serviceToken: "[Filtered]",
      accountSlug: "acme",
    });
  });
});

describe("shouldCaptureOAuthProviderError", () => {
  const headers = {} as Record<string, string>;

  it("drops 4xx client errors that have no internal diagnostic", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_grant",
        description: "Invalid refresh token",
        status: 400,
        headers,
      }),
    ).toBe(false);
  });

  it("reports server errors", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "server_error",
        description: "Internal error",
        status: 500,
        headers,
      }),
    ).toBe(true);
    expect(
      shouldCaptureOAuthProviderError({
        code: "temporarily_unavailable",
        description: "KV unavailable",
        status: 503,
        headers,
      }),
    ).toBe(true);
  });

  it("reports 4xx errors that carry provider-internal diagnostics", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_client",
        description: "Invalid client",
        status: 401,
        headers,
        internal: {
          category: "client-id-metadata-document",
          reason: "metadata_resolution_failed",
        },
      }),
    ).toBe(true);
  });
});
