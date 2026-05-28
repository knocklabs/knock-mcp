import { describe, expect, it } from "vitest";

import { buildVariantApiUrl, truncateCodeModeResponse, assertHttpMethodAllowed } from "./utils";

describe("buildVariantApiUrl", () => {
  const base = "https://control.knock.app";

  it("builds paths on the configured host", () => {
    const url = buildVariantApiUrl(base, "/v1/workflows");
    expect(url.origin).toBe("https://control.knock.app");
    expect(url.pathname).toBe("/v1/workflows");
  });

  it("accepts paths without a leading slash", () => {
    const url = buildVariantApiUrl(base, "v1/workflows");
    expect(url.pathname).toBe("/v1/workflows");
  });

  it("rejects absolute URLs and protocol-relative paths", () => {
    expect(() => buildVariantApiUrl(base, "https://evil.com/x")).toThrow(/relative API path/);
    expect(() => buildVariantApiUrl(base, "//evil.com/x")).toThrow(/relative API path/);
  });

  it("rejects path traversal", () => {
    expect(() => buildVariantApiUrl(base, "/v1/../admin")).toThrow(/\.\./);
  });
});

describe("truncateCodeModeResponse", () => {
  it("passes through small payloads", () => {
    expect(truncateCodeModeResponse({ ok: true })).toContain('"ok": true');
  });
});

describe("assertHttpMethodAllowed", () => {
  it("allows writes in read_write mode", () => {
    expect(() => assertHttpMethodAllowed("read_write", "POST")).not.toThrow();
  });

  it("blocks writes in read mode", () => {
    expect(() => assertHttpMethodAllowed("read", "POST")).toThrow(/read-only/);
    expect(() => assertHttpMethodAllowed("read", "GET")).not.toThrow();
  });
});
