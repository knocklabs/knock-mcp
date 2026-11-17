import { afterEach, describe, expect, it, vi } from "vitest";

import { tokenData, upstreamError, upstreamOk } from "./test/token-fixtures";
import { requestUpstreamRefresh } from "./upstream-refresh";

afterEach(() => vi.restoreAllMocks());

const refresh = () => requestUpstreamRefresh(tokenData(), "refresh-old");

describe("requestUpstreamRefresh", () => {
  it("sends the refresh grant and returns the rotated record", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamOk());

    const result = await refresh();

    expect(result).toMatchObject({
      ok: true,
      data: { accessToken: "access-new", refreshToken: "refresh-new" },
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://signin.example.com/oauth2/token");
    expect(String(init.body)).toBe(
      "grant_type=refresh_token&refresh_token=refresh-old&client_id=client_upstream",
    );
  });

  it("keeps the old refresh token when the upstream does not rotate it", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ access_token: "a", expires_in: 60 })),
    );

    expect(await refresh()).toMatchObject({ ok: true, data: { refreshToken: "refresh-old" } });
  });

  it.each([
    [400, "invalid_grant", "terminal", false],
    [401, "invalid_grant", "terminal", false],
    [401, "invalid_client", "transient", true],
    [400, "unauthorized_client", "transient", true],
    [400, "invalid_request", "transient", false],
    [403, "invalid_grant", "transient", false],
    [429, undefined, "transient", false],
    [502, undefined, "transient", false],
  ] as const)("classifies %s %s as %s", async (status, error, kind, clientError) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => upstreamError(status, error));

    expect(await refresh()).toMatchObject({ ok: false, kind, clientError, status });
  });

  it("treats a network error as transient", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));

    expect(await refresh()).toMatchObject({ ok: false, kind: "transient" });
  });

  it("treats a malformed success body as transient", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("<html>maintenance</html>"),
    );
    expect(await refresh()).toMatchObject({ ok: false, kind: "transient" });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    expect(await refresh()).toMatchObject({ ok: false, kind: "transient" });
  });

  it("gives up on an upstream that never answers", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );

    expect(await requestUpstreamRefresh(tokenData(), "refresh-old", 20)).toMatchObject({
      ok: false,
      kind: "transient",
    });
  });
});
