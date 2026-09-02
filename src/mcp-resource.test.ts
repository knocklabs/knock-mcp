import { describe, expect, it } from "vitest";

import {
  canonicalMcpResource,
  canonicalizeMcpResource,
  withCanonicalMcpResource,
} from "./mcp-resource";

const canonical = "https://mcp.knock.app/mcp";

describe("canonicalMcpResource", () => {
  it("appends /mcp and strips a trailing slash on the origin", () => {
    expect(canonicalMcpResource("https://mcp.knock.app")).toBe(canonical);
    expect(canonicalMcpResource("https://mcp.knock.app/")).toBe(canonical);
  });
});

describe("canonicalizeMcpResource", () => {
  it("leaves the canonical URI unchanged", () => {
    expect(canonicalizeMcpResource(canonical, canonical)).toBe(canonical);
  });

  it("maps origin-only and trailing-slash aliases to /mcp", () => {
    expect(canonicalizeMcpResource("https://mcp.knock.app", canonical)).toBe(canonical);
    expect(canonicalizeMcpResource("https://mcp.knock.app/", canonical)).toBe(canonical);
    expect(canonicalizeMcpResource("https://mcp.knock.app/mcp/", canonical)).toBe(canonical);
  });

  it("treats scheme and host as case-insensitive", () => {
    expect(canonicalizeMcpResource("HTTPS://MCP.KNOCK.APP/mcp", canonical)).toBe(canonical);
    expect(canonicalizeMcpResource("https://MCP.knock.app", canonical)).toBe(canonical);
  });

  it("leaves unrelated resources alone so the provider can reject them", () => {
    expect(canonicalizeMcpResource("https://mcp.knock.app/token", canonical)).toBe(
      "https://mcp.knock.app/token",
    );
    expect(canonicalizeMcpResource("https://evil.example/mcp", canonical)).toBe(
      "https://evil.example/mcp",
    );
    expect(canonicalizeMcpResource("not-a-url", canonical)).toBe("not-a-url");
  });

  it("does not treat query strings as aliases", () => {
    expect(canonicalizeMcpResource("https://mcp.knock.app?foo=1", canonical)).toBe(
      "https://mcp.knock.app?foo=1",
    );
    expect(canonicalizeMcpResource("https://mcp.knock.app/mcp?audience=other", canonical)).toBe(
      "https://mcp.knock.app/mcp?audience=other",
    );
  });
});

describe("withCanonicalMcpResource", () => {
  it("rewrites resource on /authorize query strings", async () => {
    const request = await withCanonicalMcpResource(
      new Request("https://mcp.knock.app/authorize?resource=https://mcp.knock.app"),
      canonical,
    );
    expect(new URL(request.url).searchParams.get("resource")).toBe(canonical);
  });

  it("rewrites GET /authorize even when a form Content-Type is present", async () => {
    const request = await withCanonicalMcpResource(
      new Request("https://mcp.knock.app/authorize?resource=https://mcp.knock.app", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      canonical,
    );
    expect(new URL(request.url).searchParams.get("resource")).toBe(canonical);
  });

  it("leaves /authorize without resource as the same request", async () => {
    const original = new Request("https://mcp.knock.app/authorize?client_id=abc");
    const request = await withCanonicalMcpResource(original, canonical);
    expect(request).toBe(original);
  });

  it("rewrites resource on /token form bodies and drops stale Content-Length", async () => {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "user:grant:secret",
      resource: "https://mcp.knock.app/",
    }).toString();
    const request = await withCanonicalMcpResource(
      new Request("https://mcp.knock.app/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(form.length),
          Authorization: "Basic abc",
        },
        body: form,
      }),
      canonical,
    );

    const body = new URLSearchParams(await request.text());
    expect(body.get("resource")).toBe(canonical);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(request.headers.get("Authorization")).toBe("Basic abc");
    // Dropped so a rewritten body cannot keep a stale Content-Length.
    expect(request.headers.get("Content-Length")).toBeNull();
  });

  it("keeps /token form bodies readable when resource is omitted", async () => {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "abc",
      code_verifier: "xyz",
    }).toString();
    const request = await withCanonicalMcpResource(
      new Request("https://mcp.knock.app/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      }),
      canonical,
    );

    expect(await request.text()).toBe(form);
  });

  it("does not consume unrelated routes", async () => {
    const original = new Request("https://mcp.knock.app/mcp", { method: "POST", body: "ping" });
    const request = await withCanonicalMcpResource(original, canonical);
    expect(request).toBe(original);
  });
});
