import { Result } from "better-result";

import type { Props } from "../types";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { getOrRefreshKnockToken } from "../token-store";
import type { AgentAbortReason } from "./abort";
import {
  AgentApiError,
  AgentStreamError,
  formatAgentError,
  toAgentNetworkError,
  withAgentErrorContext,
  type AgentError,
} from "./errors";
import {
  createAgentRunAccumulator,
  finalizeAgentRunResult,
  markAgentRunCancelled,
  markAgentRunTimedOut,
  parseAgentEventLine,
  reduceAgentEvent,
  type AgentRunAccumulator,
  type AgentRunResult,
} from "./events";
import {
  validateAgentEnvironment,
  validateAgentPrompt,
  validateAgentSessionId,
} from "./validation";

export type { AgentAbortReason };

export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 240_000;
export const DEFAULT_PROGRESS_THROTTLE_MS = 5_000;

export interface AgentContextEntry {
  type: string;
  value: unknown;
}

export interface RunAgentSessionOptions {
  env: Env;
  props: Props;
  prompt: string;
  sessionId?: string;
  environment?: string;
  onProgress?: (state: AgentRunAccumulator) => void | Promise<void>;
  signal?: AbortSignal;
  progressThrottleMs?: number;
  /** Why the run was aborted — used to distinguish client cancel from server timeout. */
  getAbortReason?: () => AgentAbortReason | undefined;
}

async function resolveAgentAuthHeaders(env: Env, props: Props): Promise<Record<string, string>> {
  const token = await getOrRefreshKnockToken(env, props.tokenId);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (props.clientId) {
    headers["x-knock-client-id"] = props.clientId;
  }

  return headers;
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
    source: "api",
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
    source: "api",
    context: buildAgentContext(environment),
  };
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

async function consumeNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onParsedLine: (rawLine: string) => void | Promise<void>,
  signal?: AbortSignal,
  shouldStop?: () => boolean,
  onStop?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const stopReading = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup after a terminal event.
    }
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Agent run aborted", "AbortError");
      }
      if (shouldStop?.()) {
        onStop?.();
        await stopReading();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await onParsedLine(line);
        if (shouldStop?.()) {
          onStop?.();
          await stopReading();
          return;
        }
      }
    }

    if (buffer.trim()) {
      await onParsedLine(buffer);
      if (shouldStop?.()) {
        onStop?.();
        await stopReading();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const MAX_ERROR_MESSAGE_CHARS = 500;

function sanitizeAgentApiError(status: number, body: string): string {
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

function createProgressNotifier(
  onProgress: RunAgentSessionOptions["onProgress"],
  throttleMs: number,
): (state: AgentRunAccumulator) => Promise<void> {
  if (!onProgress) {
    return async () => {};
  }

  let lastProgressAt = 0;
  return async (state) => {
    const now = Date.now();
    if (now - lastProgressAt < throttleMs) return;
    lastProgressAt = now;
    try {
      await onProgress(state);
    } catch {
      // Progress notifications are best-effort and must not fail the run.
    }
  };
}

export async function runAgentSession(
  options: RunAgentSessionOptions,
): Promise<Result<AgentRunResult, AgentError>> {
  const {
    env,
    props,
    prompt,
    sessionId: existingSessionId,
    environment = "development",
    onProgress,
    signal,
    progressThrottleMs = DEFAULT_PROGRESS_THROTTLE_MS,
    getAbortReason,
  } = options;

  const baseUrl = getKnockControlBaseUrl(env);
  const runId = crypto.randomUUID();
  let sessionId = crypto.randomUUID();

  if (existingSessionId) {
    const provisionalContext = { sessionId: existingSessionId.trim(), runId };
    const sessionResult = validateAgentSessionId(existingSessionId, provisionalContext);
    if (Result.isError(sessionResult)) {
      return Result.err(sessionResult.error);
    }
    sessionId = sessionResult.value;
  }

  const errorContext = { sessionId, runId };

  const promptResult = validateAgentPrompt(prompt, errorContext);
  if (Result.isError(promptResult)) {
    return Result.err(promptResult.error);
  }

  const environmentResult = validateAgentEnvironment(environment, errorContext);
  if (Result.isError(environmentResult)) {
    return Result.err(environmentResult.error);
  }
  const resolvedEnvironment = environmentResult.value;

  const isFollowUp = Boolean(existingSessionId);
  const url = isFollowUp
    ? `${baseUrl}/agent/sessions/${sessionId}/runs`
    : `${baseUrl}/agent/sessions`;
  const body = isFollowUp
    ? buildFollowUpRunBody(runId, promptResult.value, resolvedEnvironment)
    : buildCreateSessionBody(sessionId, runId, promptResult.value, resolvedEnvironment);

  let headers: Record<string, string> = {};
  let accumulator = createAgentRunAccumulator(sessionId, runId);
  const notifyProgress = createProgressNotifier(onProgress, progressThrottleMs);
  const streamAbort = new AbortController();
  const fetchSignal =
    signal !== undefined ? AbortSignal.any([signal, streamAbort.signal]) : streamAbort.signal;
  const releaseFetch = (): void => {
    if (!streamAbort.signal.aborted) {
      streamAbort.abort();
    }
  };

  const reduceLine = async (rawLine: string) => {
    const parsed = parseAgentEventLine(rawLine);
    if (!parsed) return;
    accumulator = reduceAgentEvent(accumulator, parsed);
    if (accumulator.isTerminal) {
      return;
    }
    await notifyProgress(accumulator);
  };

  try {
    const headersResult = await Result.tryPromise({
      try: () => resolveAgentAuthHeaders(env, props),
      catch: toAgentNetworkError,
    });
    if (Result.isError(headersResult)) {
      return Result.err(withAgentErrorContext(headersResult.error, errorContext));
    }
    headers = headersResult.value;

    const responseResult = await Result.tryPromise({
      try: () =>
        fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: fetchSignal,
        }),
      catch: toAgentNetworkError,
    });
    if (Result.isError(responseResult)) {
      return Result.err(withAgentErrorContext(responseResult.error, errorContext));
    }
    const response = responseResult.value;

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return Result.err(
        withAgentErrorContext(
          new AgentApiError({
            message: sanitizeAgentApiError(response.status, errorText),
            status: response.status,
          }),
          errorContext,
        ),
      );
    }

    if (!response.body) {
      return Result.err(
        withAgentErrorContext(
          new AgentStreamError({ message: "Agent API returned an empty response body" }),
          errorContext,
        ),
      );
    }

    await consumeNdjsonStream(
      response.body,
      async (line) => {
        await reduceLine(line);
      },
      signal,
      () => accumulator.isTerminal,
      releaseFetch,
    );

    if (accumulator.isTerminal) {
      return Result.ok(finalizeAgentRunResult(accumulator));
    }

    return Result.ok(
      finalizeAgentRunResult({
        ...accumulator,
        status: "error",
        error: accumulator.error ?? "Agent run ended without a terminal event",
      }),
    );
  } catch (error) {
    if (accumulator.isTerminal) {
      return Result.ok(finalizeAgentRunResult(accumulator));
    }

    const aborted =
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");

    if (aborted) {
      await stopAgentSession(baseUrl, sessionId, headers);
      const reason = getAbortReason?.();
      if (reason === "client") {
        return Result.ok(finalizeAgentRunResult(markAgentRunCancelled(accumulator)));
      }
      return Result.ok(finalizeAgentRunResult(markAgentRunTimedOut(accumulator)));
    }

    return Result.ok(
      finalizeAgentRunResult({
        ...accumulator,
        status: "error",
        error: formatAgentError(error),
      }),
    );
  }
}
