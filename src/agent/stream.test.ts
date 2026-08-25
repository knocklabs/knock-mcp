import { Result } from "better-result";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KNOCK_MCP_SERVER_VERSION } from "../mcp-server-version";
import type { Props } from "../types";
import { AgentApiError } from "./errors";
import {
  buildCreateSessionBody,
  buildFollowUpRunBody,
  startAgentRun,
  streamAgentSessionOnce,
  stopAgentSession,
} from "./stream";

vi.mock("../token-store", () => ({
  getOrRefreshKnockToken: vi.fn().mockResolvedValue("test-token"),
  resolveKnockAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

const baseProps: Props = {
  tokenId: "token-1",
  clientId: "client-1",
};

const baseEnv = {
  KNOCK_CONTROL_URL: "https://control.knock.app",
} as Env;

function ndjsonResponse(lines: string[], init?: ResponseInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(`${line}\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
    ...init,
  });
}

describe("agent request bodies", () => {
  it("builds create session params with id, stream, and context value", () => {
    expect(buildCreateSessionBody("session-1", "run-1", "Create a workflow", "development")).toEqual({
      id: "session-1",
      run_id: "run-1",
      prompt: "Create a workflow",
      stream: true,
      source: "mcp",
      context: [{ type: "environment", value: "development" }],
    });
  });

  it("builds follow-up run params without session id in the body", () => {
    expect(buildFollowUpRunBody("run-2", "Add a delay step", "staging")).toEqual({
      run_id: "run-2",
      prompt: "Add a delay step",
      source: "mcp",
      context: [{ type: "environment", value: "staging" }],
    });
  });
});

describe("startAgentRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a new session and reduces NDJSON events to a final result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({ type: "runInitializing" }),
          JSON.stringify({
            type: "toolCall",
            value: { name: "upsert_workflow", arguments: '{"workflow_key":"welcome"}' },
          }),
          JSON.stringify({
            type: "textContent",
            value: { type: "complete", value: "Done." },
          }),
          JSON.stringify({ type: "runEnd" }),
        ]),
      ),
    );

    const onProgress = vi.fn();

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a welcome workflow",
      onProgress,
      progressThrottleMs: 0,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("complete");
    expect(result.value.text).toBe("Done.");
    expect(result.value.toolCalls).toEqual([
      { name: "upsert_workflow", input: '{"workflow_key":"welcome"}' },
    ]);
    expect(onProgress).toHaveBeenCalled();

    const [, requestInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(fetch).toHaveBeenCalledWith(
      "https://control.knock.app/agent/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "x-knock-client-id": "client-1",
          "User-Agent": `Knock/v1 MCPServer/${KNOCK_MCP_SERVER_VERSION}`,
        }),
      }),
    );
    expect(requestInit.headers).not.toHaveProperty("Accept");
    expect(requestBody).toMatchObject({
      prompt: "Create a welcome workflow",
      stream: true,
      source: "mcp",
      context: [{ type: "environment", value: "development" }],
    });
    expect(requestBody.id).toEqual(expect.any(String));
    expect(requestBody.run_id).toEqual(expect.any(String));
  });

  it("posts follow-up runs to the session runs endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([JSON.stringify({ type: "runEnd" })])));

    const existingSession = "550e8400-e29b-41d4-a716-446655440000";

    await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Add a delay step",
      sessionId: existingSession,
      environment: "staging",
    });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(fetch).toHaveBeenCalledWith(
      `https://control.knock.app/agent/sessions/${existingSession}/runs`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestBody).toEqual({
      run_id: expect.any(String),
      prompt: "Add a delay step",
      source: "mcp",
      context: [{ type: "environment", value: "staging" }],
    });
  });

  it("invokes onProgress as events are reduced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            type: "toolCall",
            value: { name: "read_file", arguments: '{"path":"/knock/foo"}' },
          }),
          JSON.stringify({ type: "runEnd" }),
        ]),
      ),
    );

    const onProgress = vi.fn();

    await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Inspect resources",
      onProgress,
      progressThrottleMs: 0,
    });

    expect(onProgress).toHaveBeenCalled();
  });

  it("returns an AgentApiError for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) return;
    expect(result.error).toBeInstanceOf(AgentApiError);
    expect(result.error.message).toContain("Unauthorized");
    expect(result.error.sessionId).toEqual(expect.any(String));
    expect(result.error.runId).toEqual(expect.any(String));
  });

  it("stops the session and returns a timeout result when aborted due to timeout", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/stop")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });

      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const resultPromise = startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      signal: controller.signal,
      getAbortReason: () => "timeout",
    });

    await Promise.resolve();
    controller.abort();

    const result = await resultPromise;
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/agent\/session\/.+\/stop$/),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns a cancelled result when aborted by the client", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/stop")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });

      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const resultPromise = startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      signal: controller.signal,
      getAbortReason: () => "client",
    });

    await Promise.resolve();
    controller.abort();

    const result = await resultPromise;
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("cancelled");
  });

  it("continues when onProgress throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            type: "textContent",
            value: { type: "complete", value: "Done." },
          }),
          JSON.stringify({ type: "runEnd" }),
        ]),
      ),
    );

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      onProgress: async () => {
        throw new Error("progress notification failed");
      },
      progressThrottleMs: 0,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("complete");
    expect(result.value.text).toBe("Done.");
  });

  it("cancels the NDJSON reader after a terminal event", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify({ type: "runEnd" })}\n`),
        );
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "textContent", value: { type: "complete", value: "late" } })}\n`));
      },
      cancel,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      ),
    );

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("complete");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects invalid session_id values before calling the API", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      sessionId: "../evil",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) return;
    expect(result.error.message).toContain("session_id must be a UUID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns running without stopping the session when the stream budget expires", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });

      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const resultPromise = startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      signal: controller.signal,
      getAbortReason: () => "budget",
    });

    await Promise.resolve();
    controller.abort();

    const result = await resultPromise;
    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("running");
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/stop$/),
      expect.anything(),
    );
  });

  it("sanitizes HTML error bodies from non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>Unauthorized</html>", { status: 401 })),
    );

    const result = await startAgentRun({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) return;
    expect(result.error.message).toBe("Agent API request failed with status 401");
  });
});

describe("streamAgentSessionOnce", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GETs the session and reduces the full event log to a complete result", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            type: "textContent",
            value: { type: "complete", value: "Still working…" },
          }),
          JSON.stringify({ type: "runEnd" }),
        ]),
      ),
    );

    const result = await streamAgentSessionOnce({
      env: baseEnv,
      props: baseProps,
      sessionId,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("complete");
    expect(result.value.text).toBe("Still working…");
    expect(fetch).toHaveBeenCalledWith(
      `https://control.knock.app/agent/sessions/${sessionId}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("uses only the latest runStart/runEnd pair from a full session log", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440002";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            type: "textContent",
            value: { type: "complete", value: "First run." },
          }),
          JSON.stringify({ type: "runEnd" }),
          JSON.stringify({ type: "runStart", value: { run_id: "run-follow-up" } }),
          JSON.stringify({
            type: "textContent",
            value: { type: "complete", value: "Follow-up run." },
          }),
          JSON.stringify({ type: "runEnd" }),
        ]),
      ),
    );

    const result = await streamAgentSessionOnce({
      env: baseEnv,
      props: baseProps,
      sessionId,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("complete");
    expect(result.value.text).toBe("Follow-up run.");
    expect(result.value.runId).toBe("run-follow-up");
  });

  it("returns running when the event log has no terminal event yet", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        ndjsonResponse([
          JSON.stringify({
            type: "textContent",
            value: { type: "delta", value: "Partial" },
          }),
        ]),
      ),
    );

    const result = await streamAgentSessionOnce({
      env: baseEnv,
      props: baseProps,
      sessionId,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) return;
    expect(result.value.status).toBe("running");
  });
});

describe("stopAgentSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the stop endpoint without throwing on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      stopAgentSession("https://control.knock.app", "session-1", {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
    ).resolves.toBeUndefined();
  });
});
