import { describe, expect, it } from "vitest";

import { getKnockApiBaseUrl, getKnockApiOpenApiUrl } from "./knock-api-url";

describe("Knock API URL", () => {
  it("uses the configured base URL without a trailing slash", () => {
    expect(getKnockApiBaseUrl({ KNOCK_API_URL: "https://api.example.test/" })).toBe(
      "https://api.example.test",
    );
    expect(getKnockApiOpenApiUrl({ KNOCK_API_URL: "https://api.example.test/" })).toBe(
      "https://api.example.test/v1/openapi",
    );
  });

  it("falls back to the production API URL", () => {
    expect(getKnockApiBaseUrl({})).toBe("https://api.knock.app");
  });
});
