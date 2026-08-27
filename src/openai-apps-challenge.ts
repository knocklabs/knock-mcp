export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/** Serves the OpenAI Apps domain-verification token as origin-root plain text. */
export function openaiAppsChallengeResponse(token: string | undefined): Response {
  if (!token) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(token, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
