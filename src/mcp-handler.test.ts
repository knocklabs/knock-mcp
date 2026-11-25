import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as Sentry from "@sentry/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpServer } from "./knock-mcp";
import { createMcpApiHandler } from "./mcp-handler";
import type { Props } from "./types";

vi.mock("@sentry/cloudflare", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sentry/cloudflare")>()),
  captureException: vi.fn(),
}));

vi.mock("@cloudflare/codemode", () => ({
  DynamicWorkerExecutor: class {},
  resolveProvider: vi.fn(),
}));

const ENDPOINT = "https://mcp.knock.app/mcp";
const SESSION_ID = "3f0c8a52-5f0e-4a53-9d2c-6f0f8f7f2a11";

const env = {
  KNOCK_CONTROL_URL: "https://control.knock.test",
  LOADER: {},
} as unknown as Env;

const props = (extra: Partial<Props> = {}): Props => ({
  authKind: "service_token",
  serviceToken: "knock_st_test",
  clientId: "client-1",
  ...extra,
});

const handler = createMcpApiHandler(buildMcpServer);

function send(request: Request, requestProps: Props | undefined = props()): Promise<Response> {
  const ctx = { props: requestProps, waitUntil: () => {}, passThroughOnException: () => {} };
  return handler.fetch(request, env, ctx as unknown as ExecutionContext);
}

/** Every request gets its own server, the way requests reach different isolates. */
async function connect(era: "2025" | "2026", requestProps?: Props) {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    era === "2026" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      fetch: (url, init) => send(new Request(url, init), requestProps),
    }),
  );
  return client;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  });
const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

let upstream: { url: string; method: string }[];
let respond: (url: string) => Response;

beforeEach(() => {
  upstream = [];
  respond = () => Response.json({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      upstream.push({ url: String(input), method: init.method ?? "GET" });
      return respond(String(input));
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const text = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

describe.each([
  ["2025", "2025-11-25"],
  ["2026", "2026-07-28"],
] as const)("%s clients", (era, version) => {
  it("negotiate their protocol and list the same tools", async () => {
    const client = await connect(era);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_mapi", "execute_mapi_read", "start_knock_agent"]),
    );
  });

  it("get the tools their grant selected", async () => {
    const readOnly = await connect(
      era,
      props({ selectedGroups: ["code-mode-mapi"], mapiAccessMode: "read" }),
    );
    expect((await readOnly.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "execute_mapi_read",
      "search_mapi",
    ]);
  });

  it("aren't offered tool-list notifications, which the server never sends", async () => {
    const client = await connect(era);
    expect(client.getServerCapabilities()?.tools?.listChanged).not.toBe(true);
  });

  it("stop an agent run", async () => {
    const client = await connect(era);
    const stopped = await client.callTool({
      name: "stop_knock_agent",
      arguments: { session_id: SESSION_ID },
    });
    expect(stopped.isError).toBeFalsy();
    expect(text(stopped)).toContain("Stop requested");
    expect(upstream).toEqual([
      { url: `https://control.knock.test/agent/session/${SESSION_ID}/stop`, method: "POST" },
    ]);
  });

  it("hear when a run couldn't be stopped", async () => {
    respond = () => Response.json({ error: "session not found" }, { status: 400 });
    const client = await connect(era);
    const stopped = await client.callTool({
      name: "stop_knock_agent",
      arguments: { session_id: SESSION_ID },
    });
    expect(stopped.isError).toBe(true);
    expect(text(stopped)).toContain("session not found");
  });
});

describe("cancelling start_knock_agent", () => {
  async function cancelled(era: "2025" | "2026") {
    let startedRun = () => {};
    const started = new Promise<void>((resolve) => (startedRun = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init: RequestInit = {}) => {
        upstream.push({ url: String(input), method: init.method ?? "GET" });
        if (String(input).endsWith("/stop")) return Promise.resolve(Response.json({ ok: true }));
        // A run that streams until its connection is aborted.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"type":"runStart","value":{}}\n'));
            init.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        });
        setTimeout(startedRun, 10);
        return Promise.resolve(new Response(body, { status: 200 }));
      }),
    );
    const client = await connect(era);
    const abort = new AbortController();
    const call = client
      .callTool(
        { name: "start_knock_agent", arguments: { prompt: "Make a workflow" } },
        { signal: abort.signal },
      )
      .catch(() => undefined);
    await started;
    abort.abort();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return upstream.filter((r) => r.url.endsWith("/stop")).length;
  }

  it("stops the run on 2026-07-28, where a disconnect is a cancellation", async () => {
    expect(await cancelled("2026")).toBe(1);
  });

  it("leaves the run going on 2025-era protocols, where it isn't", async () => {
    expect(await cancelled("2025")).toBe(0);
  });
});

describe("requests", () => {
  it("accept a session ID from before, and refuse GET and DELETE", async () => {
    const response = await send(post(listTools, { "Mcp-Session-Id": "old-session" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("search_mapi");
    for (const method of ["GET", "DELETE"]) {
      const request = new Request(ENDPOINT, { method, headers: { Accept: "text/event-stream" } });
      expect((await send(request)).status).toBe(405);
    }
  });

  it("accept any Origin, logging the ones that aren't local", async () => {
    for (const origin of ["https://claude.ai", "http://localhost:6274"]) {
      expect((await send(post(listTools, { Origin: origin }))).status).toBe(200);
    }
    expect(vi.mocked(console.log).mock.calls).toEqual([
      [JSON.stringify({ event: "mcp_browser_origin", hostname: "claude.ai", method: "POST" })],
    ]);
  });

  it("fail when the grant has no credentials or client ID, and report why", async () => {
    const capture = vi.mocked(Sentry.captureException).mockClear();
    for (const bad of [{ clientId: "c" }, { serviceToken: "knock_st_test" }]) {
      const response = await send(post(listTools), bad as unknown as Props);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("re-authenticate");
    }
    expect(capture.mock.calls.map(([e]) => (e as Error).message)).toEqual([
      expect.stringContaining("missing Knock credentials"),
      expect.stringContaining("missing clientId"),
    ]);
  });

  it("never share credentials between two callers at once", async () => {
    const tokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_: string, init: RequestInit = {}) => {
        tokens.push(new Headers(init.headers).get("Authorization") ?? "");
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({ ok: true });
      }),
    );
    const callers = ["knock_st_a", "knock_st_b"];
    const clients = await Promise.all(
      callers.map((serviceToken) => connect("2026", props({ serviceToken }))),
    );
    await Promise.all(
      clients.map((client) =>
        client.callTool({ name: "stop_knock_agent", arguments: { session_id: SESSION_ID } }),
      ),
    );
    expect(tokens.sort()).toEqual(callers.map((t) => `Bearer ${t}`));
  });
});
