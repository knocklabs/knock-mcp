export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

const OPENAI_APPS_CHALLENGE_TOKEN = "zaIGjeN9W3XUVhH-6_a0Koqp7SwbP6UqqIQoaYrKQmA";

/** Serves the OpenAI Apps domain-verification token as origin-root plain text. */
export function openaiAppsChallengeResponse(): Response {
  return new Response(OPENAI_APPS_CHALLENGE_TOKEN, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
