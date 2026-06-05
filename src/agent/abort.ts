import {
  markAgentRunCancelled,
  markAgentRunTimedOut,
  type AgentRunAccumulator,
} from "./events";

export type AgentAbortReason = "timeout" | "client" | "budget";

export interface AgentRunAbortHandle {
  controller: AbortController;
  getAbortReason: () => AgentAbortReason | undefined;
  clear: () => void;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function abortedRunAccumulator(
  accumulator: AgentRunAccumulator,
  getAbortReason?: () => AgentAbortReason | undefined,
): AgentRunAccumulator {
  return getAbortReason?.() === "client"
    ? markAgentRunCancelled(accumulator)
    : markAgentRunTimedOut(accumulator);
}

/** Combines MCP client abort with a server-side timeout without clobbering cancel reason. */
export function createAgentRunAbortController(
  timeoutMs: number,
  externalSignal: AbortSignal,
): AgentRunAbortHandle {
  const controller = new AbortController();
  const state: { reason: AgentAbortReason | undefined } = { reason: undefined };

  const timeout = setTimeout(() => {
    if (!state.reason) {
      state.reason = "timeout";
    }
    controller.abort();
  }, timeoutMs);

  externalSignal.addEventListener(
    "abort",
    () => {
      if (!state.reason) {
        state.reason = "client";
      }
      controller.abort();
    },
    { once: true },
  );

  return {
    controller,
    getAbortReason: () => state.reason,
    clear: () => clearTimeout(timeout),
  };
}

/** 45s start stream budget; does not stop the remote run when the budget expires. */
export function createStartStreamBudgetController(
  budgetMs: number,
  externalSignal: AbortSignal,
): AgentRunAbortHandle {
  const controller = new AbortController();
  const state: { reason: AgentAbortReason | undefined } = { reason: undefined };

  const timeout = setTimeout(() => {
    if (!state.reason) {
      state.reason = "budget";
    }
    controller.abort();
  }, budgetMs);

  externalSignal.addEventListener(
    "abort",
    () => {
      if (!state.reason) {
        state.reason = "client";
      }
      controller.abort();
    },
    { once: true },
  );

  return {
    controller,
    getAbortReason: () => state.reason,
    clear: () => clearTimeout(timeout),
  };
}
