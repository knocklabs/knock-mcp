import { afterEach, describe, expect, it, vi } from "vitest";

import type { Props } from "../types";
import {
  buildCreateSessionBody,
  buildFollowUpRunBody,
  runAgentSession,
  stopAgentSession,
} from "./stream";

vi.mock("../token-store", () => ({
  getOrRefreshKnockToken: vi.fn().mockResolvedValue("test-token"),
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
      source: "api",
      context: [{ type: "environment", value: "development" }],
    });
  });

  it("builds follow-up run params without session id in the body", () => {
    expect(buildFollowUpRunBody("run-2", "Add a delay step", "staging")).toEqual({
      run_id: "run-2",
      prompt: "Add a delay step",
      source: "api",
      context: [{ type: "environment", value: "staging" }],
    });
  });
});

describe("runAgentSession", () => {
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

    const result = await runAgentSession({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a welcome workflow",
      onProgress,
      progressThrottleMs: 0,
    });

    expect(result.status).toBe("complete");
    expect(result.text).toBe("Done.");
    expect(result.toolCalls).toEqual([
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
        }),
      }),
    );
    expect(requestInit.headers).not.toHaveProperty("Accept");
    expect(requestBody).toMatchObject({
      prompt: "Create a welcome workflow",
      stream: true,
      source: "api",
      context: [{ type: "environment", value: "development" }],
    });
    expect(requestBody.id).toEqual(expect.any(String));
    expect(requestBody.run_id).toEqual(expect.any(String));
  });

  it("posts follow-up runs to the session runs endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ndjsonResponse([JSON.stringify({ type: "runEnd" })])));

    await runAgentSession({
      env: baseEnv,
      props: baseProps,
      prompt: "Add a delay step",
      sessionId: "existing-session",
      environment: "staging",
    });

    const [, requestInit] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(fetch).toHaveBeenCalledWith(
      "https://control.knock.app/agent/sessions/existing-session/runs",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestBody).toEqual({
      run_id: expect.any(String),
      prompt: "Add a delay step",
      source: "api",
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

    await runAgentSession({
      env: baseEnv,
      props: baseProps,
      prompt: "Inspect resources",
      onProgress,
      progressThrottleMs: 0,
    });

    expect(onProgress).toHaveBeenCalled();
  });

  it("returns an error result for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    const result = await runAgentSession({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Unauthorized");
  });

  it("stops the session and returns a timeout result when aborted", async () => {
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
    const resultPromise = runAgentSession({
      env: baseEnv,
      props: baseProps,
      prompt: "Create a workflow",
      signal: controller.signal,
    });

    await Promise.resolve();
    controller.abort();

    const result = await resultPromise;
    expect(result.status).toBe("timeout");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/agent\/session\/.+\/stop$/),
      expect.objectContaining({ method: "POST" }),
    );
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
