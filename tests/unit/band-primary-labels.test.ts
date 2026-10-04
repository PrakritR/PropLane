import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The list band's round + must read "Add <noun>" (portal-list-control-stack's accessible-name guard). */
describe("record band primaries", () => {
  const dir = join(process.cwd(), "src/components/portal");
  const files = readdirSync(dir).filter((name) => name.endsWith(".tsx"));
  it("every literal `plus={{ label: ... }}` reads Add <noun>", () => {
    const bad: string[] = [];
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8");
      for (const match of source.matchAll(/plus=\{\{\s*label:\s*"([^"]+)"/g)) {
        if (!/^Add\s/.test(match[1]!)) bad.push(`${name}: ${match[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
