import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AgentRunAccumulator } from "./events";

export function knockAgentProgressHandler(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ((state: AgentRunAccumulator) => Promise<void>) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken == null) return undefined;

  return async (state) => {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: state.eventCount,
        message: `Knock agent working… ${state.toolCallCount} tool call(s) so far`,
      },
    });
  };
}

export function createThrottledProgressNotifier(
  onProgress: ((state: AgentRunAccumulator) => void | Promise<void>) | undefined,
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
