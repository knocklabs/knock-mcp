import { describe, expect, it } from "vitest";

import { redactSentryEvent } from "./sentry";

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
