import { describe, expect, it } from "vitest";

import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it("returns the hex digest of a UTF-8 string", async () => {
    // echo -n test | shasum -a 256
    await expect(sha256Hex("test")).resolves.toBe(
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    );
  });
});
