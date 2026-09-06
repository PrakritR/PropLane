import { describe, expect, it } from "vitest";
import { trimmedText } from "@/lib/trimmed-text";

describe("trimmedText", () => {
  it.each([123, {}, [], true, false, null, undefined])(
    "returns empty string for non-string %j instead of throwing",
    (value) => {
      expect(trimmedText(value)).toBe("");
    },
  );

  it("trims real strings", () => {
    expect(trimmedText("  +18559168031  ")).toBe("+18559168031");
    expect(trimmedText("")).toBe("");
  });
});
