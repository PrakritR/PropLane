import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * STD-3: value picks use the portaled field dropdown (`FieldSingleSelect`), not
 * native `<select>`. `Select` from input.tsx is a compatibility shim over
 * `FieldSingleSelect` for option children; callers may use either API.
 */
describe("Select shim — portaled field dropdown", () => {
  it("input.tsx Select renders through FieldSingleSelect", () => {
    const source = readFileSync(join(process.cwd(), "src/components/ui/input.tsx"), "utf8");
    expect(source).toContain("FieldSingleSelect");
    expect(source).not.toMatch(/<select[\s>]/);
  });
});
