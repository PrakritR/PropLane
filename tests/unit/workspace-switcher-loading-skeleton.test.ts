import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/components/portal/workspace-switcher.tsx"),
  "utf8",
);

/**
 * Night UX sweep — the workspace switcher's visible label showed the literal
 * word "Loading..." across nearly every manager screenshot in the main
 * sweep, in the app's own brand slot on every navigation. Replace the
 * visible text with a skeleton bar while `ctx.loading`; the computed `name`
 * string may still say "Loading…" for the accessible name/title (a screen
 * reader announcing "loading" is fine), it just must never paint as text.
 */
describe("workspace switcher never paints the word Loading", () => {
  it("renders a pulse skeleton bar in both the mobile and header/compact trigger labels while loading", () => {
    const occurrences = (source.match(/ctx\.loading \? \(/g) ?? []).length;
    // One ternary for the mobile trigger's label, one for the header/compact trigger's label.
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/animate-pulse rounded-full bg-accent\/60/);
  });

  it("keeps the accessible name/title informative without painting it as visible text", () => {
    // aria-label / title still derive from `name` ("Loading…") — that's fine,
    // it's non-visual. The visible <span>{name}</span> must be gated so the
    // literal word never paints.
    expect(source).toMatch(/aria-label=\{`Switch workspace: \$\{name\}`\}/);
    expect(source).toMatch(/\{ctx\.loading \? \(\s*<span[\s\S]*?animate-pulse/);
  });
});
