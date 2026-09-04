import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * AGENTS.md: "Floating bulk bar — `BulkActionBar variant="payments" hideCount`,
 * present only while something is selected."
 *
 * Every bulk bar in the product follows that except when one drifts, and the
 * drift is invisible to a build: the panel still compiles, its tests still
 * pass, and the only symptom is one tab whose actions float centred behind an
 * "N selected" label while every other tab's sit on the left gutter. The
 * Move-in tab shipped that way. This scan is the guard.
 *
 * The count label is dropped on purpose rather than kept for information: the
 * selection is already visible in the rows themselves, and the label pushes the
 * actions off the gutter every other list aligns to.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

/** The component's own definition, which necessarily names the props. */
const DEFINITION = join("src", "components", "ui", "bulk-action-bar.tsx");

describe("BulkActionBar call sites", () => {
  it("always pass hideCount, and never the default variant", () => {
    const offenders: string[] = [];
    for (const file of walk(join("src", "components"))) {
      if (file === DEFINITION) continue;
      const source = readFileSync(file, "utf8");
      for (const tag of source.match(/<BulkActionBar[\s\S]*?>/g) ?? []) {
        // A wrapper that FORWARDS `variant={…}` is fine — it is passing a
        // caller's choice through, not choosing the centred default itself.
        const literalVariant = /variant="([^"]*)"/.exec(tag)?.[1];
        const forwardsVariant = tag.includes("variant={");
        const ok =
          tag.includes("hideCount") &&
          (literalVariant === "payments" || (forwardsVariant && literalVariant === undefined));
        if (!ok) offenders.push(`${file}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
