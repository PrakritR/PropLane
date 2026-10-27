// Communication picks its columns from the width of its own surface, never the viewport.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INBOX_DETAILS_PANEL_PX, INBOX_FULL_SCREEN_THREAD_MAX_PX, pickInboxColumns } from "@/lib/inbox-columns";

describe("pickInboxColumns", () => {
  it("draws two columns (list + conversation) from 760px up, at any width above", () => {
    expect(pickInboxColumns(760)).toBe(2);
    expect(pickInboxColumns(1039)).toBe(2);
    expect(pickInboxColumns(1040)).toBe(2);
    expect(pickInboxColumns(1512)).toBe(2);
    expect(pickInboxColumns(2560)).toBe(2);
  });
  it("shows the thread alone under 760px", () => {
    expect(pickInboxColumns(759)).toBe(1);
    expect(pickInboxColumns(390)).toBe(1);
  });
});

describe("InboxTwoPane source guard", () => {
  const src = readFileSync(join(process.cwd(), "src/components/portal/portal-inbox-ui.tsx"), "utf8");
  const start = src.indexOf("export function InboxTwoPane(");
  const body = src.slice(start);

  it("no longer reads the viewport width for its columns", () => {
    expect(src).not.toMatch(/useMinWidth\(/);
    expect(body).not.toMatch(/xl:grid-cols-\[320px/);
    expect(body).not.toMatch(/matchMedia/);
  });
  it("has no third details column: the details are the on-demand panel", () => {
    expect(body).not.toContain("showDetails");
    expect(body).not.toMatch(/inbox-details-pane(?!l)/);
    expect(body).not.toMatch(/grid-cols-\[320px_minmax\(440px,1fr\)_280px\]/);
    expect(body).toContain("inbox-details-panel");
    // Tailwind cannot interpolate the constant, so the class is held to it here instead.
    expect(body).toContain(`w-[${INBOX_DETAILS_PANEL_PX}px]`);
  });
  it("full screen drops the sidebar-bleed margin and centres the thread at the shared width", () => {
    expect(body).toMatch(/fullScreenDrawn\s*\? "lg:border-t lg:border-border"/);
    expect(src).toContain(`max-w-[${INBOX_FULL_SCREEN_THREAD_MAX_PX}px]`);
  });
  it("measures its own width and picks the columns from it", () => {
    expect(body).toContain("pickInboxColumns(");
    expect(body).toContain("new ResizeObserver(");
  });

  // The panel is drawn OVER the conversation now that the details are not a third column, and
  // `bg-card` is rebound translucent under [data-theme] (rgba .7 / .1) — the message text read
  // straight through the rows. Same opaque-surface rule every other floating panel carries.
  it("gives the details panel an opaque surface in both themes", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const light = css.match(/^\.portal-inbox-details-panel \{[^}]*\}/m)?.[0] ?? "";
    const dark = css.match(/^\[data-theme="dark"\] \.portal-inbox-details-panel \{[^}]*\}/m)?.[0] ?? "";
    expect(light).toMatch(/background-color: #ffffff !important/);
    expect(dark).toMatch(/background-color: #111827 !important/);
    // After the `[data-theme] .bg-card` rebind, or the rebind wins on source order.
    expect(css.indexOf(".portal-inbox-details-panel {")).toBeGreaterThan(css.indexOf('[data-theme="light"] .bg-card {'));
  });
});
