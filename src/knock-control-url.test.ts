import { describe, expect, it } from "vitest";

import { getKnockControlBaseUrl, getKnockControlOpenApiUrl } from "./knock-control-url";

describe("knock-control-url", () => {
  const env = { KNOCK_CONTROL_URL: "https://control.knock.app/" };

  it("strips trailing slash from base URL", () => {
    expect(getKnockControlBaseUrl(env)).toBe("https://control.knock.app");
  });

  it("builds OpenAPI URL from base", () => {
    expect(getKnockControlOpenApiUrl(env)).toBe("https://control.knock.app/v1/openapi");
  });
});
