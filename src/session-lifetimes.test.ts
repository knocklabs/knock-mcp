import { describe, expect, it } from "vitest";

import { MCP_GRANT_MAX_AGE_SECONDS, grantPhase } from "./session-lifetimes";

describe("grantPhase", () => {
  const now = 1_700_000_000;

  it.each([
    ["has no issuedAt", undefined, "legacy"],
    ["was issued seconds ago", now - 5, "new"],
    ["was issued an hour ago", now - 3600, "established"],
    ["is just inside the maximum age", now - MCP_GRANT_MAX_AGE_SECONDS, "established"],
    ["is past the maximum age", now - MCP_GRANT_MAX_AGE_SECONDS - 1, "expired"],
  ] as const)("a grant that %s is %s", (_name, issuedAt, phase) => {
    expect(grantPhase({ issuedAt }, now)).toBe(phase);
  });

  it("treats missing props as a legacy grant", () => {
    expect(grantPhase(undefined, now)).toBe("legacy");
  });
});
