import { Result } from "better-result";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Props } from "../types";
import { HttpMethodError } from "./errors";
import {
  buildRequestBody,
  executeHostRequest,
  mergeHeaders,
  parseRequestOptions,
  parseResponseBody,
  type ExecuteHostRequestConfig,
} from "./request";

describe("parseRequestOptions", () => {
  it("accepts valid request options", () => {
    const result = parseRequestOptions({ method: "GET", path: "/v1/workflows" });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.path).toBe("/v1/workflows");
    }
  });

  it("rejects missing method or path", () => {
    const missingPath = parseRequestOptions({ method: "GET" });
    expect(Result.isError(missingPath)).toBe(true);

    const missingMethod = parseRequestOptions({ path: "/v1/workflows" });
    expect(Result.isError(missingMethod)).toBe(true);
  });

  it("rejects unsupported HTTP methods", () => {
    const result = parseRequestOptions({ method: "HEAD", path: "/v1/workflows" });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toMatch(/unsupported HTTP method/);
    }
  });
});

describe("mergeHeaders", () => {
  it("blocks client auth headers and applies host auth", () => {
    const headers = mergeHeaders(
      { Authorization: "Bearer evil", "X-Custom": "yes" },
      { Authorization: "Bearer good", "x-knock-client-id": "client-1" },
    );
    expect(headers.get("Authorization")).toBe("Bearer good");
    expect(headers.get("x-knock-client-id")).toBe("client-1");
    expect(headers.get("X-Custom")).toBe("yes");
  });
});

describe("buildRequestBody", () => {
  const baseOpts = {
    method: "POST" as const,
    path: "/v1/workflows",
    body: { key: "value" },
  };

  it("returns undefined for GET requests", () => {
    const headers = new Headers();
    const body = buildRequestBody({ method: "GET", path: "/v1/workflows" }, headers);
    expect(body).toBeUndefined();
  });

  it("sets content type on GET when provided", () => {
    const headers = new Headers();
    buildRequestBody(
      { method: "GET", path: "/v1/workflows", contentType: "text/plain" },
      headers,
    );
    expect(headers.get("Content-Type")).toBe("text/plain");
  });

  it("JSON-stringifies object bodies", () => {
    const headers = new Headers();
    const body = buildRequestBody(baseOpts, headers);
    expect(body).toBe('{"key":"value"}');
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("passes through raw string bodies", () => {
    const headers = new Headers();
    const body = buildRequestBody(
      { ...baseOpts, body: "raw-payload", rawBody: true },
      headers,
    );
    expect(body).toBe("raw-payload");
  });

  it("uses explicit content type for JSON bodies", () => {
    const headers = new Headers();
    buildRequestBody({ ...baseOpts, contentType: "application/vnd.api+json" }, headers);
    expect(headers.get("Content-Type")).toBe("application/vnd.api+json");
  });
});

describe("parseResponseBody", () => {
  it("parses JSON responses", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseResponseBody(response);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual({ ok: true });
    }
  });

  it("falls back to raw text when JSON is invalid", async () => {
    const response = new Response("not-json", {
      headers: { "Content-Type": "application/json" },
    });
    const result = await parseResponseBody(response);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("not-json");
    }
  });

  it("returns plain text for non-JSON content types", async () => {
    const response = new Response("plain", { headers: { "Content-Type": "text/plain" } });
    const result = await parseResponseBody(response);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toBe("plain");
    }
  });
});

describe("executeHostRequest", () => {
  const baseConfig: ExecuteHostRequestConfig = {
    baseUrl: "https://control.knock.app",
    accessMode: "read_write",
    resolveAuth: async () => ({ headers: { Authorization: "Bearer token" } }),
    env: {} as Env,
    props: {} as Props,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed API responses on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ entries: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await executeHostRequest({ method: "GET", path: "/v1/workflows" }, baseConfig);

    expect(result).toEqual({
      status: 200,
      ok: true,
      result: { entries: [] },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://control.knock.app/v1/workflows",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("surfaces auth failures with the original message", async () => {
    await expect(
      executeHostRequest(
        { method: "GET", path: "/v1/workflows" },
        {
          ...baseConfig,
          resolveAuth: async () => {
            throw new Error("Knock session not found. Please re-authenticate.");
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "Knock session not found. Please re-authenticate.",
    });
  });

  it("blocks write methods in read-only mode", async () => {
    await expect(
      executeHostRequest(
        { method: "POST", path: "/v1/workflows", body: {} },
        { ...baseConfig, accessMode: "read" },
      ),
    ).rejects.toBeInstanceOf(HttpMethodError);
  });

  it("surfaces network failures from fetch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    await expect(
      executeHostRequest({ method: "GET", path: "/v1/workflows" }, baseConfig),
    ).rejects.toMatchObject({ message: "connection refused" });
  });
});
