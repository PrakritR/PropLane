import { describe, expect, it } from "vitest";
import { partitionFieldSelectClasses } from "@/components/ui/field-select-styles";

/**
 * Toolbar Selects must not force `w-full` when the caller already set a width
 * (PRP-376 — SMS sort crushed the search field to 50px).
 */
function resolveFieldSelectWidthClass(wrapperClassName: string, pill = false): string {
  if (pill) return "w-auto shrink-0";
  if (/\bw-/.test(wrapperClassName)) return "";
  return "w-full";
}

describe("FieldSingleSelect toolbar width (PRP-376)", () => {
  it("honours an explicit w-auto from Select className", () => {
    const { wrapperClassName } = partitionFieldSelectClasses(
      "h-10 w-auto max-w-[11rem] shrink-0 rounded-full",
    );
    expect(wrapperClassName).toMatch(/\bw-auto\b/);
    expect(resolveFieldSelectWidthClass(wrapperClassName)).toBe("");
  });

  it("still defaults form fields to w-full", () => {
    const { wrapperClassName } = partitionFieldSelectClasses("h-10");
    expect(resolveFieldSelectWidthClass(wrapperClassName)).toBe("w-full");
  });
});
