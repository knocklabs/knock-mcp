import { describe, expect, it } from "vitest";

import {
  OPENAI_APPS_CHALLENGE_PATH,
  openaiAppsChallengeResponse,
} from "./openai-apps-challenge";

describe("openaiAppsChallengeResponse", () => {
  it("returns the token as plain text", async () => {
    const token = "zaIGjeN9W3XUVhH-6_a0Koqp7SwbP6UqqIQoaYrKQmA";
    const response = openaiAppsChallengeResponse(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(token);
  });

  it("returns 404 when the token is missing", async () => {
    const response = openaiAppsChallengeResponse(undefined);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("exposes the well-known path OpenAI checks", () => {
    expect(OPENAI_APPS_CHALLENGE_PATH).toBe("/.well-known/openai-apps-challenge");
  });
});
