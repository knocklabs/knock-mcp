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

  it("drops expected 4xx client errors even though they carry internal diagnostics", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_grant",
        description: "Invalid refresh token",
        status: 400,
        headers,
        internal: { category: "refresh-token-grant", reason: "refresh_token_mismatch" },
      }),
    ).toBe(false);
    expect(
      shouldCaptureOAuthProviderError({
        code: "invalid_token",
        description: "Access token expired",
        status: 401,
        headers,
        internal: { category: "protected-resource", reason: "token_expired" },
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
        internal: { category: "token-issuance", reason: "unexpected" },
      }),
    ).toBe(true);
    expect(
      shouldCaptureOAuthProviderError({
        code: "temporarily_unavailable",
        description: "KV unavailable",
        status: 503,
        headers,
        internal: { category: "token-issuance", reason: "kv_rate_limited" },
      }),
    ).toBe(true);
  });

  it("reports client metadata document failures that surface as 4xx", () => {
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

  it("drops 503s from the token exchange callback because token-store already reports them", () => {
    expect(
      shouldCaptureOAuthProviderError({
        code: "temporarily_unavailable",
        description: "Knock session is temporarily unavailable; retry shortly.",
        status: 503,
        headers,
        internal: { category: "token-exchange-callback", reason: "upstream_unavailable" },
      }),
    ).toBe(false);
  });
});
