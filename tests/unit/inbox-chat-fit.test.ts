import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ui = readFileSync("src/components/portal/portal-inbox-ui.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

/**
 * "Chat size does not fit the screen" (captain, Nov 12). At 375x812 and 1440x900 nothing in a thread may be wider
 * than the thread, and the pane must size to the VISIBLE viewport (dvh), not the large one a phone browser reports.
 */
describe("chat fits the screen", () => {
  it("both thread bodies clip horizontal overflow and may shrink below their content", () => {
    const bodies = ui.match(/"portal-inbox-thread-body [^"]*"/g) ?? [];
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const cls of bodies) {
      expect(cls).toContain("min-w-0");
      expect(cls).toContain("max-w-full");
      expect(cls).toContain("overflow-x-hidden");
    }
  });

  it("every message body wraps unbroken strings", () => {
    for (const line of ui.split("\n").filter((l) => l.includes("whitespace-pre-wrap"))) {
      expect(line, line.trim()).toMatch(/break-words|overflow-wrap:anywhere/);
    }
  });

  it("the pane fallback height uses dvh, never vh", () => {
    expect(ui).toContain('"min(68dvh, 640px)"');
    expect(ui).not.toMatch(/"min\(68vh/);
  });

  it("media scales down and wide code/tables scroll inside their own box; the composer cannot widen the pane", () => {
    expect(css).toMatch(/\.portal-inbox-thread-body :where\(img, video, canvas, iframe\) \{\s*max-width: 100%;/);
    expect(css).toMatch(/\.portal-inbox-thread-body :where\(pre, table\) \{[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.portal-inbox-composer \{\s*min-width: 0;\s*max-width: 100%;/);
    expect(css).toMatch(/\.portal-inbox-thread-body \{\s*overflow-wrap: anywhere;/);
  });

  it("the composer stays pinned (shrink-0) under a scrolling body", () => {
    expect(ui).toMatch(/portal-inbox-composer shrink-0/);
    expect(ui).toMatch(/portal-inbox-thread-body flex min-h-0[^"]*flex-1[^"]*overflow-y-auto/);
  });
});
