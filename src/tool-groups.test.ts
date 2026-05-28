import { describe, expect, it } from "vitest";

import {
  defaultSelectedGroupKeys,
  resolveEffectiveSelectedGroups,
  resolveGroupsToCategories,
} from "./tool-groups";

describe("resolveEffectiveSelectedGroups", () => {
  it("uses default groups when selection is missing or empty", () => {
    const defaults = defaultSelectedGroupKeys();
    expect(defaults).toContain("code-mode-mapi");
    expect(resolveEffectiveSelectedGroups(undefined)).toEqual(defaults);
    expect(resolveEffectiveSelectedGroups(null)).toEqual(defaults);
    expect(resolveEffectiveSelectedGroups([])).toEqual(defaults);
  });

  it("drops unknown keys and falls back when none remain", () => {
    expect(resolveEffectiveSelectedGroups(["not-a-real-group"])).toEqual(
      defaultSelectedGroupKeys(),
    );
  });

  it("preserves valid explicit selections", () => {
    expect(resolveEffectiveSelectedGroups(["documentation"])).toEqual(["documentation"]);
    expect(resolveEffectiveSelectedGroups(["code-mode-mapi", "bogus"])).toEqual([
      "code-mode-mapi",
    ]);
  });
});

describe("resolveGroupsToCategories", () => {
  it("maps code-mode-mapi to the mapi sentinel category", () => {
    expect(resolveGroupsToCategories(["code-mode-mapi"])).toEqual(["__codeMode:mapi"]);
  });
});
