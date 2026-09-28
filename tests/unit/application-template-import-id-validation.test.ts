import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F004 lets the import route stage against a not-yet-created template id, and that id
// becomes a storage path segment — it must be validated as a plain id, never a path.
describe("application-template-import route id validation", () => {
  const source = readFileSync("src/app/api/portal/application-template-import/route.ts", "utf8");
  it("rejects anything but a plain id before building the storage path", () => {
    const match = source.match(/const TEMPLATE_ID_PATTERN = (\/.+\/);/);
    expect(match).toBeTruthy();
    const pattern = new RegExp(match![1].slice(1, -1));
    expect(pattern.test("app-tpl-1a2b3c")).toBe(true);
    expect(pattern.test("../other-user")).toBe(false);
    expect(pattern.test("a/b")).toBe(false);
    expect(pattern.test("")).toBe(false);
    expect(source.indexOf("TEMPLATE_ID_PATTERN.test(templateId)")).toBeLessThan(source.indexOf("sourcePath(auth.userId, templateId)"));
  });
});
