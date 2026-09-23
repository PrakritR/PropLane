import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/**
 * Mobile Communication thread reading must fill the column under the status
 * bar / above the bottom nav. Growing every `.portal-main-inner` child with
 * `flex: 1` (including empty banner wrappers) left a blank band above the chat.
 */
describe("communication mobile thread-reading flex fill", () => {
  it("does not flex-grow every portal-main-inner child while reading a thread", () => {
    expect(GLOBALS_CSS).not.toMatch(
      /html\[data-communication-thread-reading\]\s+\.portal-main-inner\s*>\s*\*:not\(\.portal-mobile-nav-bar\)\s*\{[^}]*flex:\s*1/,
    );
  });

  it("grows the page shell (and wrappers that contain it) instead", () => {
    expect(GLOBALS_CSS).toContain(
      'html[data-communication-thread-reading] .portal-main-inner > [data-slot="portal-page-shell"]',
    );
    expect(GLOBALS_CSS).toContain(
      "html[data-communication-thread-reading] .portal-main-inner > *:has([data-viewport-fill-body])",
    );
  });

  it("collapses leaf siblings that do not contain the page shell", () => {
    expect(GLOBALS_CSS).toMatch(
      /html\[data-communication-thread-reading\][\s\S]{0,400}?:not\(:has\(\[data-viewport-fill-body\]\)\)[\s\S]{0,80}?display:\s*none/,
    );
  });
});
