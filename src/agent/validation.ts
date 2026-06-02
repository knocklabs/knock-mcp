import { Result } from "better-result";

import { AgentStreamError } from "./errors";

/** UUID v4 (matches crypto.randomUUID() output). */
const AGENT_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ENVIRONMENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export const MAX_AGENT_PROMPT_CHARS = 32_000;

export function validateAgentSessionId(
  sessionId: string,
  context: { sessionId: string; runId: string },
): Result<string, AgentStreamError> {
  const trimmed = sessionId.trim();
  if (!AGENT_SESSION_ID_PATTERN.test(trimmed)) {
    return Result.err(
      new AgentStreamError({
        message: "session_id must be a UUID",
        sessionId: context.sessionId,
        runId: context.runId,
      }),
    );
  }
  return Result.ok(trimmed);
}

export function validateAgentEnvironment(
  environment: string,
  context: { sessionId: string; runId: string },
): Result<string, AgentStreamError> {
  const trimmed = environment.trim();
  if (!ENVIRONMENT_SLUG_PATTERN.test(trimmed)) {
    return Result.err(
      new AgentStreamError({
        message: "environment must be a valid Knock environment slug",
        sessionId: context.sessionId,
        runId: context.runId,
      }),
    );
  }
  return Result.ok(trimmed);
}

export function validateAgentPrompt(
  prompt: string,
  context: { sessionId: string; runId: string },
): Result<string, AgentStreamError> {
  if (prompt.length > MAX_AGENT_PROMPT_CHARS) {
    return Result.err(
      new AgentStreamError({
        message: `prompt must be at most ${MAX_AGENT_PROMPT_CHARS.toLocaleString()} characters`,
        sessionId: context.sessionId,
        runId: context.runId,
      }),
    );
  }
  return Result.ok(prompt);
}
