import { describe, expect, it } from "vitest";
import { trimmedText } from "@/lib/trimmed-text";

describe("trimmedText", () => {
  it.each([{}, [], true, false, null, undefined])(
    "returns empty string for non-string %j instead of throwing",
    (value) => {
      expect(trimmedText(value)).toBe("");
    },
  );

  it("keeps a JSON number so an existing account's stored phone still works", () => {
    expect(trimmedText(18559168031)).toBe("18559168031");
    expect(trimmedText(123)).toBe("123");
  });

  it("trims real strings", () => {
    expect(trimmedText("  +18559168031  ")).toBe("+18559168031");
    expect(trimmedText("")).toBe("");
  });
});
