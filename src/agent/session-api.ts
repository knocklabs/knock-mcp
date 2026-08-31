import { Result } from "better-result";

import type { Props } from "../types";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { resolveKnockAccessToken } from "../session-auth";
import {
  AgentApiError,
  AgentStreamError,
  agentResultErr,
  toAgentNetworkError,
  type AgentError,
  type AgentErrorContext,
} from "./errors";
import {
  buildKnockMcpClientHeaders,
  type KnockClientApplicationInfo,
} from "../knock-client-user-agent";
import {
  validateAgentEnvironment,
  validateAgentPrompt,
  validateAgentSessionId,
} from "./validation";

/** Body `source` for agent session create and follow-up runs. */
export const AGENT_SESSION_SOURCE = "mcp";

export type { KnockClientApplicationInfo };
export { buildKnockMcpClientHeaders };

export interface AgentContextEntry {
  type: string;
  value: unknown;
}

export interface PreparedAgentRun {
  baseUrl: string;
  sessionId: string;
  runId: string;
  errorContext: AgentErrorContext;
  url: string;
  body: Record<string, unknown>;
}

export function buildAgentContext(environment: string): AgentContextEntry[] {
  return [{ type: "environment", value: environment }];
}

export function buildCreateSessionBody(
  sessionId: string,
  runId: string,
  prompt: string,
  environment: string,
): Record<string, unknown> {
  return {
    id: sessionId,
    run_id: runId,
    prompt,
    stream: true,
    source: AGENT_SESSION_SOURCE,
    context: buildAgentContext(environment),
  };
}

export function buildFollowUpRunBody(
  runId: string,
  prompt: string,
  environment: string,
): Record<string, unknown> {
  return {
    run_id: runId,
    prompt,
    source: AGENT_SESSION_SOURCE,
    context: buildAgentContext(environment),
  };
}

export async function resolveAgentAuthHeaders(
  env: Env,
  props: Props,
): Promise<Record<string, string>> {
  const token = await resolveKnockAccessToken(env, props);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (props.clientId) {
    headers["x-knock-client-id"] = props.clientId;
  }

  return { ...headers, ...buildKnockMcpClientHeaders(props.clientApplication) };
}

export async function stopAgentSession(
  baseUrl: string,
  sessionId: string,
  headers: Record<string, string>,
): Promise<void> {
  const { "Content-Type": _contentType, ...stopHeaders } = headers;

  try {
    await fetch(`${baseUrl}/agent/session/${sessionId}/stop`, {
      method: "POST",
      headers: stopHeaders,
    });
  } catch {
    // Best-effort stop when the MCP client aborts or we hit our timeout.
  }
}

const MAX_ERROR_MESSAGE_CHARS = 500;

export function sanitizeAgentApiError(status: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `Agent API request failed with status ${status}`;
  }

  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    return `Agent API request failed with status ${status}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message =
      parsed.message ??
      parsed.error ??
      (typeof parsed.errors === "string" ? parsed.errors : undefined);
    if (typeof message === "string" && message.trim()) {
      return message.trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
    }
  } catch {
    // Fall through to raw text truncation.
  }

  return trimmed.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

export function prepareAgentRun(
  env: Env,
  input: {
    prompt: string;
    sessionId?: string;
    environment?: string;
  },
): Result<PreparedAgentRun, AgentError> {
  const baseUrl = getKnockControlBaseUrl(env);
  const runId = crypto.randomUUID();
  let sessionId = crypto.randomUUID();

  if (input.sessionId) {
    const provisionalContext = { sessionId: input.sessionId.trim(), runId };
    const sessionResult = validateAgentSessionId(input.sessionId, provisionalContext);
    if (Result.isError(sessionResult)) {
      return Result.err(sessionResult.error);
    }
    sessionId = sessionResult.value;
  }

  const errorContext = { sessionId, runId };

  const promptResult = validateAgentPrompt(input.prompt, errorContext);
  if (Result.isError(promptResult)) {
    return Result.err(promptResult.error);
  }

  const environmentResult = validateAgentEnvironment(
    input.environment ?? "development",
    errorContext,
  );
  if (Result.isError(environmentResult)) {
    return Result.err(environmentResult.error);
  }

  const isFollowUp = Boolean(input.sessionId);
  const url = isFollowUp
    ? `${baseUrl}/agent/sessions/${sessionId}/runs`
    : `${baseUrl}/agent/sessions`;
  const body = isFollowUp
    ? buildFollowUpRunBody(runId, promptResult.value, environmentResult.value)
    : buildCreateSessionBody(sessionId, runId, promptResult.value, environmentResult.value);

  return Result.ok({
    baseUrl,
    sessionId,
    runId,
    errorContext,
    url,
    body,
  });
}

export async function getAgentSessionStream(
  baseUrl: string,
  sessionId: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Result<Response, AgentError>> {
  const errorContext: AgentErrorContext = { sessionId, runId: "" };
  const { "Content-Type": _contentType, ...getHeaders } = headers;

  const responseResult = await Result.tryPromise({
    try: () =>
      fetch(`${baseUrl}/agent/sessions/${sessionId}`, {
        method: "GET",
        headers: getHeaders,
        signal,
      }),
    catch: toAgentNetworkError,
  });

  if (Result.isError(responseResult)) {
    return agentResultErr(responseResult.error, errorContext);
  }

  return responseResult;
}

export async function postAgentRun(
  prepared: PreparedAgentRun,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Result<Response, AgentError>> {
  const responseResult = await Result.tryPromise({
    try: () =>
      fetch(prepared.url, {
        method: "POST",
        headers,
        body: JSON.stringify(prepared.body),
        signal,
      }),
    catch: toAgentNetworkError,
  });

  if (Result.isError(responseResult)) {
    return agentResultErr(responseResult.error, prepared.errorContext);
  }

  return responseResult;
}

export async function agentResponseError(
  response: Response,
  ctx: AgentErrorContext,
): Promise<Result<never, AgentError>> {
  const errorText = await response.text().catch(() => "");
  return agentResultErr(
    new AgentApiError({
      message: sanitizeAgentApiError(response.status, errorText),
      status: response.status,
    }),
    ctx,
  );
}

export function agentEmptyBodyError(ctx: AgentErrorContext): Result<never, AgentError> {
  return agentResultErr(
    new AgentStreamError({ message: "Agent API returned an empty response body" }),
    ctx,
  );
}
