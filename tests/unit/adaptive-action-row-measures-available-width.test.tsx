// @vitest-environment jsdom
//
// The "…" overflow menu must appear only when buttons genuinely do not fit.
//
// Reported on a wide desktop: the lease footer showed Send / Generate lease / Upload PDF and then
// a "…", with obvious empty space beside it. The cause was not the fit arithmetic — it was what
// the arithmetic measured.
//
// `LeasePrimaryHeaderActions` (and the shared adaptive rows) size themselves from
// `container.clientWidth`. Their wrapper, `ResidentDocumentsDetailFooter`, was a flex item with
// no `w-full` / `flex-1`, so `flex-basis: auto` made it shrink to fit its own content. The
// measurement became circular — "how much room do I have?" answered "exactly what you already
// use" — so buttons fell into the overflow menu and could never come back out.
//
// jsdom computes no layout, so this asserts the CLASS CONTRACT that makes the measurement
// meaningful rather than pixel widths. That is the part a refactor silently drops.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResidentDocumentsDetailFooter } from "@/components/portal/portal-data-table";

describe("detail footer measures available width, not its own content", () => {
  it("spans the footer so clientWidth is the space actually available", () => {
    const { container } = render(
      <ResidentDocumentsDetailFooter>
        <button type="button">Send</button>
      </ResidentDocumentsDetailFooter>,
    );
    const row = container.firstElementChild as HTMLElement;
    const cls = row.className;

    // Any ONE of these missing puts the wrapper back on shrink-to-fit.
    expect(cls).toContain("w-full");
    expect(cls).toContain("flex-1");
    expect(cls).toContain("basis-0");
    // `min-w-0` keeps it able to shrink below content on a genuinely narrow screen, which is
    // when the overflow menu SHOULD appear.
    expect(cls).toContain("min-w-0");
  });
});

describe("lease footer fit calculation", () => {
  // The fit calculation moved out of `lease-primary-header-actions.tsx` into the
  // shared `portal-footer-fit-action-row.tsx`, which every adaptive footer now
  // uses. The rules below are unchanged; only the file that owns them moved.
  const SRC = readFileSync(
    join(process.cwd(), "src/components/portal/portal-footer-fit-action-row.tsx"),
    "utf8",
  );

  it("measures the container rather than assuming a breakpoint", () => {
    // The rule the captain asked for: collapse on FIT, never on "is this mobile".
    expect(SRC).toContain("container.clientWidth");
    expect(SRC).not.toMatch(/max-lg:hidden[^"]*data-lease-fit/);
  });

  it("only reserves room for the More button when something would actually overflow", () => {
    // `fitCount(false)` first: if everything fits, no space is reserved for a menu that will not
    // be rendered. Reserving unconditionally is what pushes the last button out on a row that
    // was one button-width from fitting.
    expect(SRC).toContain("fitCount(false)");
    expect(SRC).toMatch(/if \(count < widths\.length\)[\s\S]{0,40}fitCount\(true\)/);
  });
});
