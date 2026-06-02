import type { Props } from "../types";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { getOrRefreshKnockToken } from "../token-store";
import {
  createAgentRunAccumulator,
  finalizeAgentRunResult,
  markAgentRunTimedOut,
  parseAgentEventLine,
  reduceAgentEvent,
  type AgentRunAccumulator,
  type AgentRunResult,
} from "./events";

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
}

export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AgentSessionError";
  }
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
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Agent run aborted", "AbortError");
      }
      if (shouldStop?.()) {
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
          return;
        }
      }
    }

    if (buffer.trim()) {
      await onParsedLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
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
    await onProgress(state);
  };
}

export async function runAgentSession(options: RunAgentSessionOptions): Promise<AgentRunResult> {
  const {
    env,
    props,
    prompt,
    sessionId: existingSessionId,
    environment = "development",
    onProgress,
    signal,
    progressThrottleMs = DEFAULT_PROGRESS_THROTTLE_MS,
  } = options;

  const baseUrl = getKnockControlBaseUrl(env);
  const sessionId = existingSessionId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const isFollowUp = Boolean(existingSessionId);
  const url = isFollowUp
    ? `${baseUrl}/agent/sessions/${sessionId}/runs`
    : `${baseUrl}/agent/sessions`;
  const body = isFollowUp
    ? buildFollowUpRunBody(runId, prompt, environment)
    : buildCreateSessionBody(sessionId, runId, prompt, environment);

  let headers: Record<string, string> = {};
  let accumulator = createAgentRunAccumulator(sessionId, runId);
  const notifyProgress = createProgressNotifier(onProgress, progressThrottleMs);

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
    headers = await resolveAgentAuthHeaders(env, props);
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new AgentSessionError(
        errorText || `Agent API request failed with status ${response.status}`,
        response.status,
      );
    }

    if (!response.body) {
      throw new AgentSessionError("Agent API returned an empty response body");
    }

    await consumeNdjsonStream(
      response.body,
      async (line) => {
        await reduceLine(line);
      },
      signal,
      () => accumulator.isTerminal,
    );

    if (accumulator.isTerminal) {
      return finalizeAgentRunResult(accumulator);
    }

    return finalizeAgentRunResult({
      ...accumulator,
      status: "error",
      error: accumulator.error ?? "Agent run ended without a terminal event",
    });
  } catch (error) {
    if (accumulator.isTerminal) {
      return finalizeAgentRunResult(accumulator);
    }

    const aborted =
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError");

    if (aborted) {
      await stopAgentSession(baseUrl, sessionId, headers);
      return finalizeAgentRunResult(markAgentRunTimedOut(accumulator));
    }

    if (error instanceof AgentSessionError) {
      return finalizeAgentRunResult({
        ...accumulator,
        status: "error",
        error: error.message,
      });
    }

    const message = error instanceof Error ? error.message : "Unknown agent error";
    return finalizeAgentRunResult({
      ...accumulator,
      status: "error",
      error: message,
    });
  }
}
