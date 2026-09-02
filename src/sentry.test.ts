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
  it("drops expected client protocol errors", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_grant",
        description: "Invalid refresh token",
        status: 400,
      }),
    ).toBe(false);
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_token",
        description: "Invalid access token",
        status: 401,
      }),
    ).toBe(false);
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_target",
        description: "The resource parameter must exactly match https://mcp.knock.app/mcp",
        status: 400,
      }),
    ).toBe(false);
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_request",
        description: "Method not allowed",
        status: 405,
      }),
    ).toBe(false);
    expect(
      shouldCaptureOAuthProviderError({
        code: "temporarily_unavailable",
        description: "Token issuance is temporarily unavailable; retry shortly",
        status: 429,
      }),
    ).toBe(false);
  });

  it("reports server errors", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "server_error",
        description: "Internal error",
        status: 500,
      }),
    ).toBe(true);
    expect(
      shouldCaptureOAuthProviderError({
        code: "temporarily_unavailable",
        description: "KV unavailable",
        status: 503,
      }),
    ).toBe(true);
  });

  it("reports provider-internal diagnostics such as CIMD fetch failures", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_client",
        description: "Invalid client",
        status: 401,
        internal: {
          category: "client-id-metadata-document",
          reason: "metadata_resolution_failed",
        },
      }),
    ).toBe(true);
  });
});
