export type AgentAbortReason = "timeout" | "client";

export interface AgentRunAbortHandle {
  controller: AbortController;
  getAbortReason: () => AgentAbortReason | undefined;
  clear: () => void;
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
