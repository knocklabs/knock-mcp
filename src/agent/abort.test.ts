import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentRunAbortController } from "./abort";

describe("createAgentRunAbortController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves client cancel reason when timeout fires afterward", () => {
    vi.useFakeTimers();

    const external = new AbortController();
    const { controller, getAbortReason, clear } = createAgentRunAbortController(240_000, external.signal);

    external.abort();
    expect(getAbortReason()).toBe("client");
    expect(controller.signal.aborted).toBe(true);

    vi.advanceTimersByTime(240_000);
    expect(getAbortReason()).toBe("client");

    clear();
  });

  it("records timeout reason when the timer fires first", () => {
    vi.useFakeTimers();

    const external = new AbortController();
    const { getAbortReason, clear } = createAgentRunAbortController(240_000, external.signal);

    vi.advanceTimersByTime(240_000);
    expect(getAbortReason()).toBe("timeout");

    clear();
  });
});
