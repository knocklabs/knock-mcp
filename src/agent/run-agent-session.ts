import { Result } from "better-result";

import type { Props } from "../types";
import { getKnockControlBaseUrl } from "../knock-control-url";
import { abortedRunAccumulator, isAbortError, type AgentAbortReason } from "./abort";
import {
  agentResultErr,
  formatAgentError,
  toAgentNetworkError,
  type AgentError,
} from "./errors";
import {
  createAgentEventReducer,
  finalizeAgentPollOutcome,
  finalizeAgentRunOutcome,
  type AgentEventReducer,
} from "./event-reducer";
import type { AgentRunAccumulator, AgentRunResult } from "./events";
import { finalizeAgentRunAsRunning, finalizeAgentRunResult } from "./events";
import { consumeNdjsonStream } from "./ndjson";
import {
  agentEmptyBodyError,
  agentResponseError,
  getAgentSessionStream,
  postAgentRun,
  prepareAgentRun,
  resolveAgentAuthHeaders,
  stopAgentSession,
  type PreparedAgentRun,
} from "./session-api";
import { validateAgentSessionId } from "./validation";

export const DEFAULT_START_STREAM_BUDGET_MS = 45_000;
export const DEFAULT_PROGRESS_THROTTLE_MS = 5_000;

export interface StartAgentRunOptions {
  env: Env;
  props: Props;
  prompt: string;
  sessionId?: string;
  environment?: string;
  onProgress?: (state: AgentRunAccumulator) => void | Promise<void>;
  signal?: AbortSignal;
  progressThrottleMs?: number;
  getAbortReason?: () => AgentAbortReason | undefined;
}

export interface StreamAgentSessionOptions {
  env: Env;
  props: Props;
  sessionId: string;
}

async function consumeAgentNdjson(
  response: Response,
  reducer: AgentEventReducer,
  options?: { stopOnTerminal?: boolean },
): Promise<void> {
  const stopOnTerminal = options?.stopOnTerminal ?? true;

  await consumeNdjsonStream(response.body!, reducer.reduceLine, {
    signal: reducer.fetchSignal,
    shouldStop: stopOnTerminal ? reducer.isTerminal : () => false,
    onStop: reducer.releaseFetch,
  });
}

async function runPreparedAgentSession(
  prepared: PreparedAgentRun,
  reducer: AgentEventReducer,
  headers: Record<string, string>,
): Promise<Result<AgentRunResult, AgentError>> {
  const postResult = await postAgentRun(prepared, headers, reducer.fetchSignal);
  if (Result.isError(postResult)) {
    return Result.err(postResult.error);
  }

  const response = postResult.value;
  if (!response.ok) {
    return agentResponseError(response, prepared.errorContext);
  }
  if (!response.body) {
    return agentEmptyBodyError(prepared.errorContext);
  }

  await consumeAgentNdjson(response, reducer);
  return Result.ok(finalizeAgentRunOutcome(reducer.getAccumulator()));
}

function handleStartStreamError(
  error: unknown,
  run: PreparedAgentRun,
  reducer: AgentEventReducer,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  getAbortReason?: () => AgentAbortReason | undefined,
): Result<AgentRunResult, AgentError> {
  const accumulator = reducer.getAccumulator();

  if (accumulator.isTerminal) {
    return Result.ok(finalizeAgentRunResult(accumulator));
  }

  const aborted = signal?.aborted || isAbortError(error);
  if (aborted && getAbortReason?.() === "budget") {
    reducer.releaseFetch();
    return Result.ok(finalizeAgentRunAsRunning(accumulator));
  }

  if (aborted) {
    void stopAgentSession(run.baseUrl, run.sessionId, headers);
    return Result.ok(
      finalizeAgentRunResult(abortedRunAccumulator(accumulator, getAbortReason)),
    );
  }

  return Result.ok(
    finalizeAgentRunResult({
      ...accumulator,
      status: "error",
      error: formatAgentError(error),
    }),
  );
}

export async function startAgentRun(
  options: StartAgentRunOptions,
): Promise<Result<AgentRunResult, AgentError>> {
  const {
    env,
    props,
    prompt,
    sessionId: existingSessionId,
    environment,
    onProgress,
    signal,
    progressThrottleMs = DEFAULT_PROGRESS_THROTTLE_MS,
    getAbortReason,
  } = options;

  const prepared = prepareAgentRun(env, {
    prompt,
    sessionId: existingSessionId,
    environment,
  });
  if (Result.isError(prepared)) {
    return Result.err(prepared.error);
  }

  const run = prepared.value;
  const reducer = createAgentEventReducer({
    sessionId: run.sessionId,
    runId: run.runId,
    onProgress,
    progressThrottleMs,
    userSignal: signal,
  });

  let headers: Record<string, string> = {};

  try {
    const headersResult = await Result.tryPromise({
      try: () => resolveAgentAuthHeaders(env, props),
      catch: toAgentNetworkError,
    });
    if (Result.isError(headersResult)) {
      return agentResultErr(headersResult.error, run.errorContext);
    }
    headers = headersResult.value;

    return await runPreparedAgentSession(run, reducer, headers);
  } catch (error) {
    return handleStartStreamError(error, run, reducer, headers, signal, getAbortReason);
  }
}

export async function streamAgentSessionOnce(
  options: StreamAgentSessionOptions,
): Promise<Result<AgentRunResult, AgentError>> {
  const { env, props, sessionId: rawSessionId } = options;
  const baseUrl = getKnockControlBaseUrl(env);
  const provisionalContext = { sessionId: rawSessionId.trim(), runId: "" };

  const sessionResult = validateAgentSessionId(rawSessionId, provisionalContext);
  if (Result.isError(sessionResult)) {
    return Result.err(sessionResult.error);
  }

  const sessionId = sessionResult.value;
  const errorContext = { sessionId, runId: "" };

  const headersResult = await Result.tryPromise({
    try: () => resolveAgentAuthHeaders(env, props),
    catch: toAgentNetworkError,
  });
  if (Result.isError(headersResult)) {
    return agentResultErr(headersResult.error, errorContext);
  }

  const headers = headersResult.value;
  const reducer = createAgentEventReducer({
    sessionId,
    runId: "",
    progressThrottleMs: DEFAULT_PROGRESS_THROTTLE_MS,
  });

  try {
    const getResult = await getAgentSessionStream(
      baseUrl,
      sessionId,
      headers,
      reducer.fetchSignal,
    );
    if (Result.isError(getResult)) {
      return Result.err(getResult.error);
    }

    const response = getResult.value;
    if (!response.ok) {
      return agentResponseError(response, errorContext);
    }
    if (!response.body) {
      return agentEmptyBodyError(errorContext);
    }

    await consumeAgentNdjson(response, reducer, { stopOnTerminal: false });
    return Result.ok(finalizeAgentPollOutcome(reducer.getAccumulator()));
  } catch (error) {
    const accumulator = reducer.getAccumulator();
    if (accumulator.isTerminal) {
      return Result.ok(finalizeAgentRunResult(accumulator));
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
