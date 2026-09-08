import { describe, expect, it } from "vitest";

import {
  deriveCodeModeAccessMode,
  deriveMapiAccessMode,
  isMapiCodeModeEnabled,
  resolveApiAccessMode,
  resolveMapiAccessMode,
} from "./access";

describe("isMapiCodeModeEnabled", () => {
  it("is true when either toggle is on", () => {
    expect(isMapiCodeModeEnabled(true, true)).toBe(true);
    expect(isMapiCodeModeEnabled(true, false)).toBe(true);
    expect(isMapiCodeModeEnabled(false, true)).toBe(true);
    expect(isMapiCodeModeEnabled(false, false)).toBe(false);
  });
});

describe("deriveCodeModeAccessMode", () => {
  it("derives the same read/write model for either API", () => {
    expect(deriveCodeModeAccessMode(false, false)).toBeUndefined();
    expect(deriveCodeModeAccessMode(true, false)).toBe("read");
    expect(deriveCodeModeAccessMode(false, true)).toBe("read_write");
  });
});

describe("deriveMapiAccessMode", () => {
  it("returns undefined when both toggles are off", () => {
    expect(deriveMapiAccessMode(false, false)).toBeUndefined();
  });

  it("returns read when only read is enabled", () => {
    expect(deriveMapiAccessMode(true, false)).toBe("read");
  });

  it("returns read_write when manage is enabled", () => {
    expect(deriveMapiAccessMode(true, true)).toBe("read_write");
    expect(deriveMapiAccessMode(false, true)).toBe("read_write");
  });
});

describe("resolveApiAccessMode", () => {
  it("returns undefined when public API code mode is not selected", () => {
    expect(resolveApiAccessMode(["documentation"], "read")).toBeUndefined();
  });

  it("defaults missing and invalid public API modes to read", () => {
    expect(resolveApiAccessMode(["code-mode-api"], undefined)).toBe("read");
    expect(resolveApiAccessMode(["code-mode-api"], null)).toBe("read");
    expect(resolveApiAccessMode(["code-mode-api"], "admin")).toBe("read");
  });

  it("honours explicit read_write access", () => {
    expect(resolveApiAccessMode(["code-mode-api"], "read_write")).toBe("read_write");
  });
});

describe("resolveMapiAccessMode", () => {
  it("returns undefined when code mode is not selected", () => {
    expect(resolveMapiAccessMode(["documentation"], "read")).toBeUndefined();
  });

  it("defaults to read_write when code mode is selected", () => {
    expect(resolveMapiAccessMode(["code-mode-mapi"], undefined)).toBe("read_write");
    expect(resolveMapiAccessMode(["code-mode-mapi"], null)).toBe("read_write");
    expect(resolveMapiAccessMode(["code-mode-mapi"], "read_write")).toBe("read_write");
  });

  it("honours read when code mode is selected", () => {
    expect(resolveMapiAccessMode(["code-mode-mapi"], "read")).toBe("read");
  });

  it("treats unknown values as read_write", () => {
    expect(resolveMapiAccessMode(["code-mode-mapi"], "admin")).toBe("read_write");
  });
});
