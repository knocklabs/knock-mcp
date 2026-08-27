import { describe, expect, it } from "vitest";

import {
  OPENAI_APPS_CHALLENGE_PATH,
  openaiAppsChallengeResponse,
} from "./openai-apps-challenge";

describe("openaiAppsChallengeResponse", () => {
  it("returns the OpenAI Apps challenge token as plain text", async () => {
    const response = openaiAppsChallengeResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("zaIGjeN9W3XUVhH-6_a0Koqp7SwbP6UqqIQoaYrKQmA");
  });

  it("exposes the well-known path OpenAI checks", () => {
    expect(OPENAI_APPS_CHALLENGE_PATH).toBe("/.well-known/openai-apps-challenge");
  });
});
