import { afterEach, describe, expect, it, vi } from "vitest";

import { logTokenEndpointFailure } from "./token-endpoint-log";

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
