import { afterEach, describe, expect, it, vi } from "vitest";

import { logTokenEndpointFailure, withTokenEndpointLogging } from "./token-endpoint-log";

function tokenRequest(form: Record<string, string>) {
  return new Request("https://mcp.knock.app/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Cursor/1.0.0",
    },
    body: new URLSearchParams(form),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("logTokenEndpointFailure", () => {
  it("logs the grant id and error without the refresh token secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }),
      { status: 400 },
    );

    await logTokenEndpointFailure(
      tokenRequest({
        grant_type: "refresh_token",
        client_id: "client-1",
        refresh_token: "user_1:grant_1:super-secret",
        resource: "https://mcp.knock.app/mcp",
      }),
      response,
    );

    expect(warn).toHaveBeenCalledOnce();
    const [message, payload] = warn.mock.calls[0] as [string, string];
    expect(message).toBe("token-endpoint-failure");
    expect(JSON.parse(payload)).toEqual({
      status: 400,
      error: "invalid_grant",
      errorDescription: "Invalid refresh token",
      grantType: "refresh_token",
      clientId: "client-1",
      grantId: "grant_1",
      resource: "https://mcp.knock.app/mcp",
      userAgent: "Cursor/1.0.0",
    });
    expect(payload).not.toContain("super-secret");
    expect(payload).not.toContain("user_1");
  });

  it("tolerates non-form requests and non-JSON responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await logTokenEndpointFailure(
      new Request("https://mcp.knock.app/token", { method: "POST", body: "{}" }),
      new Response("nope", { status: 500 }),
    );

    expect(JSON.parse((warn.mock.calls[0] as [string, string])[1])).toMatchObject({ status: 500 });
  });
});

describe("withTokenEndpointLogging", () => {
  const ctx = () => {
    const waiting: Promise<unknown>[] = [];
    return {
      waiting,
      ctx: { waitUntil: (p: Promise<unknown>) => waiting.push(p) } as unknown as ExecutionContext,
    };
  };

  const failure = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

  it("logs failed POSTs to the token path and returns the original response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { waiting, ctx: executionCtx } = ctx();
    const handler = withTokenEndpointLogging("/token", async () => failure());

    const response = await handler(tokenRequest({ grant_type: "refresh_token" }), {}, executionCtx);
    await Promise.all(waiting);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet for successes, other paths, and other methods", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { waiting, ctx: executionCtx } = ctx();

    await withTokenEndpointLogging("/token", async () => new Response("ok"))(
      tokenRequest({ grant_type: "refresh_token" }),
      {},
      executionCtx,
    );
    await withTokenEndpointLogging("/token", async () => failure())(
      new Request("https://mcp.knock.app/mcp", { method: "POST", body: "x" }),
      {},
      executionCtx,
    );
    await withTokenEndpointLogging("/token", async () => failure())(
      new Request("https://mcp.knock.app/token", { method: "GET" }),
      {},
      executionCtx,
    );
    await Promise.all(waiting);

    expect(warn).not.toHaveBeenCalled();
  });

  it("clips long attacker-controlled fields and records the colo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = tokenRequest({ grant_type: "refresh_token", client_id: "c".repeat(5000) });
    Object.defineProperty(request, "cf", { value: { colo: "SJC" } });

    await logTokenEndpointFailure(request, failure());

    const entry = JSON.parse((warn.mock.calls[0] as [string, string])[1]);
    expect(entry.clientId).toHaveLength(200);
    expect(entry.colo).toBe("SJC");
  });
});
