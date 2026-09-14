// Every dropdown in the portal is the PropLane dropdown (`Select` /
// `FieldSingleSelect`), never the OS picker. A raw <select> draws Chrome's
// own grey menu over the row — the bug the captain screenshotted on the
// Bathrooms step — so this guard fails the build the moment one comes back.
// The only <select> allowed is inside the primitives that implement the
// dropdown itself.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCANNED = ["src/components/portal", "src/components/ui"];
/** Files that may render a real <select>: none today. Add here only with a reason in the file. */
const ALLOW = new Set<string>([]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no native <select> in portal UI", () => {
  const files = SCANNED.flatMap((dir) => walk(join(ROOT, dir))).map((f) => relative(ROOT, f));

  it("scans the portal and ui component trees", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("renders no raw <select> element", () => {
    const offenders = files.filter((file) => {
      if (ALLOW.has(file)) return false;
      const source = readFileSync(join(ROOT, file), "utf8");
      // Strip comments so prose that *mentions* <select> does not count.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      return /<select[\s>]/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it("has no NativeSelect left to reach for", () => {
    const offenders = files.filter((file) => /\bNativeSelect\b/.test(readFileSync(join(ROOT, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
