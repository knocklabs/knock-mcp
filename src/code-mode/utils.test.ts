import { Result } from "better-result";
import { describe, expect, it } from "vitest";

import { resolveVariantApiUrl, truncateCodeModeResponse, validateHttpMethod } from "./utils";

describe("resolveVariantApiUrl", () => {
  const base = "https://control.knock.app";

  it("builds paths on the configured host", () => {
    const result = resolveVariantApiUrl(base, "/v1/workflows");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.origin).toBe("https://control.knock.app");
      expect(result.value.pathname).toBe("/v1/workflows");
    }
  });

  it("accepts paths without a leading slash", () => {
    const result = resolveVariantApiUrl(base, "v1/workflows");
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.pathname).toBe("/v1/workflows");
    }
  });

  it("rejects absolute URLs and protocol-relative paths", () => {
    const absolute = resolveVariantApiUrl(base, "https://evil.com/x");
    expect(Result.isError(absolute)).toBe(true);
    if (Result.isError(absolute)) {
      expect(absolute.error.message).toMatch(/relative API path/);
    }

    const protocolRelative = resolveVariantApiUrl(base, "//evil.com/x");
    expect(Result.isError(protocolRelative)).toBe(true);
    if (Result.isError(protocolRelative)) {
      expect(protocolRelative.error.message).toMatch(/relative API path/);
    }
  });

  it("rejects path traversal", () => {
    const result = resolveVariantApiUrl(base, "/v1/../admin");
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.message).toMatch(/\.\./);
    }
  });
});

describe("truncateCodeModeResponse", () => {
  it("passes through small payloads", () => {
    expect(truncateCodeModeResponse({ ok: true })).toContain('"ok": true');
  });
});

describe("validateHttpMethod", () => {
  it("allows writes in read_write mode", () => {
    const result = validateHttpMethod("read_write", "POST");
    expect(Result.isOk(result)).toBe(true);
  });

  it("blocks writes in read mode", () => {
    const post = validateHttpMethod("read", "POST");
    expect(Result.isError(post)).toBe(true);
    if (Result.isError(post)) {
      expect(post.error.message).toMatch(/read-only/);
    }

    const get = validateHttpMethod("read", "GET");
    expect(Result.isOk(get)).toBe(true);
  });

  it("allows only write methods in write mode", () => {
    const post = validateHttpMethod("write", "POST");
    expect(Result.isOk(post)).toBe(true);

    const get = validateHttpMethod("write", "GET");
    expect(Result.isError(get)).toBe(true);
    if (Result.isError(get)) {
      expect(get.error.message).toMatch(/write-only/);
    }
  });
});
