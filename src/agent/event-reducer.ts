import {
  createAgentRunAccumulator,
  finalizeAgentRunAsRunning,
  finalizeAgentRunResult,
  parseAgentEventLine,
  reduceAgentEvent,
  type AgentRunAccumulator,
  type AgentRunResult,
} from "./events";
import { createThrottledProgressNotifier } from "./progress";

export interface AgentEventReducer {
  fetchSignal: AbortSignal;
  userSignal?: AbortSignal;
  releaseFetch: () => void;
  reduceLine: (rawLine: string) => Promise<void>;
  getAccumulator: () => AgentRunAccumulator;
  isTerminal: () => boolean;
}

export function createAgentEventReducer(options: {
  sessionId: string;
  runId: string;
  onProgress?: (state: AgentRunAccumulator) => void | Promise<void>;
  progressThrottleMs: number;
  userSignal?: AbortSignal;
}): AgentEventReducer {
  const streamAbort = new AbortController();
  let accumulator = createAgentRunAccumulator(options.sessionId, options.runId);
  const notifyProgress = createThrottledProgressNotifier(
    options.onProgress,
    options.progressThrottleMs,
  );

  const fetchSignal =
    options.userSignal !== undefined
      ? AbortSignal.any([options.userSignal, streamAbort.signal])
      : streamAbort.signal;

  return {
    fetchSignal,
    userSignal: options.userSignal,
    releaseFetch: () => {
      if (!streamAbort.signal.aborted) {
        streamAbort.abort();
      }
    },
    getAccumulator: () => accumulator,
    isTerminal: () => accumulator.isTerminal,
    reduceLine: async (rawLine) => {
      const parsed = parseAgentEventLine(rawLine);
      if (!parsed) return;

      accumulator = reduceAgentEvent(accumulator, parsed);
      if (accumulator.isTerminal) return;

      await notifyProgress(accumulator);
    },
  };
}

export function finalizeAgentRunOutcome(accumulator: AgentRunAccumulator): AgentRunResult {
  if (accumulator.isTerminal) {
    return finalizeAgentRunResult(accumulator);
  }

  return finalizeAgentRunResult({
    ...accumulator,
    status: "error",
    error: accumulator.error ?? "Agent run ended without a terminal event",
  });
}

/** After consuming a full session event log (GET poll) without a terminal event yet. */
export function finalizeAgentPollOutcome(accumulator: AgentRunAccumulator): AgentRunResult {
  if (accumulator.isTerminal) {
    return finalizeAgentRunResult(accumulator);
  }

  return finalizeAgentRunAsRunning(accumulator);
}
