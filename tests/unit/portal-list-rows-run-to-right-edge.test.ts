import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Record rows and their hairlines run to the same right inset as the header
 * band. The page shell bleeds the list surface into <main>'s gutter with a
 * negative inline margin, but the surface is `w-full` (width: 100%) and a width
 * that is not `auto` never grows into a negative margin, so without an explicit
 * width the rows stopped one gutter short on the right (an empty strip after
 * every row's ⋯). The bleed rule must therefore widen the surface by both
 * gutters, and the shared row/list sources must not reserve a right-side gap.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const GLOBALS_CSS = read("src/app/globals.css");

function surfaceBleedBlocks(): string[] {
  const blocks: string[] = [];
  const re = /\.portal-list-page-scroll > \[data-slot="portal-record-list-surface"\] \{([^}]*)\}/g;
  for (const m of GLOBALS_CSS.matchAll(re)) blocks.push(m[1]!);
  return blocks;
}

describe("portal list rows reach the header band's right edge", () => {
  it("widens the bled surface by both gutters on desktop and phone", () => {
    const blocks = surfaceBleedBlocks();
    expect(blocks).toHaveLength(2);
    const [desktop, phone] = blocks;
    expect(desktop).toContain("margin-inline: -2rem");
    expect(desktop).toContain("width: calc(100% + 4rem)");
    expect(phone).toContain("margin-inline: -1rem");
    expect(phone).toContain("width: calc(100% + 2rem)");
  });

  it("the shared list surface and row sources reserve no right-side gap", () => {
    const surface = read("src/components/portal/portal-record-list-surface.tsx");
    const rows = read("src/components/portal/portal-record-row.tsx");
    const surfaceBody = read("src/components/portal/portal-inbox-ui.tsx").match(
      /export const PORTAL_LIST_PAGE_BODY =\s*"([^"]*)"/,
    )?.[1];
    expect(surfaceBody).toBeTruthy();
    // No max-width cap, right padding or right margin on the list body.
    expect(surfaceBody).not.toMatch(/(^|\s)(max-w-|pr-|mr-|me-|pe-|px-|mx-)/);
    // The surface wrapper adds no right inset of its own.
    expect(surface).not.toMatch(/data-slot="portal-record-list-surface"[^>]*className=\{[^}]*\b(pr|mr|pe|me)-/);
    // A row's own right padding stays the 14px (8px phone) action gutter, never a reserved column.
    const rowRightPads = [...rows.matchAll(/(?<![-\w])(?:max-lg:)?(pr|mr|pe|me)-(\[[^\]]+\]|\d+(?:\.\d+)?)/g)].map((m) => m[0]);
    for (const pad of rowRightPads) {
      expect(["pr-3.5", "max-lg:pr-2", "mr-0", "mr-1", "mr-2", "mr-3"]).toContain(pad);
    }
  });
});
