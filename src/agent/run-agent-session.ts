import { Result } from "better-result";

import type { Props } from "../types";
import { abortedRunAccumulator, isAbortError, type AgentAbortReason } from "./abort";
import {
  agentResultErr,
  formatAgentError,
  toAgentNetworkError,
  type AgentError,
} from "./errors";
import {
  createAgentEventReducer,
  finalizeAgentRunOutcome,
  type AgentEventReducer,
} from "./event-reducer";
import type { AgentRunAccumulator, AgentRunResult } from "./events";
import { finalizeAgentRunResult } from "./events";
import { consumeNdjsonStream } from "./ndjson";
import {
  agentEmptyBodyError,
  agentResponseError,
  postAgentRun,
  prepareAgentRun,
  resolveAgentAuthHeaders,
  stopAgentSession,
  type PreparedAgentRun,
} from "./session-api";

export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 240_000;
export const DEFAULT_PROGRESS_THROTTLE_MS = 5_000;

export interface RunAgentSessionOptions {
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

async function consumeAgentNdjson(
  response: Response,
  reducer: AgentEventReducer,
): Promise<void> {
  await consumeNdjsonStream(response.body!, reducer.reduceLine, {
    signal: reducer.userSignal,
    shouldStop: reducer.isTerminal,
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

export async function runAgentSession(
  options: RunAgentSessionOptions,
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
    const accumulator = reducer.getAccumulator();

    if (accumulator.isTerminal) {
      return Result.ok(finalizeAgentRunResult(accumulator));
    }

    const userAborted = signal?.aborted || isAbortError(error);
    if (userAborted) {
      await stopAgentSession(run.baseUrl, run.sessionId, headers);
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
}
