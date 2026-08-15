import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const RESIDENTS = read("src/components/portal/manager-residents.tsx");
const DETAIL_PAGE = read("src/components/portal/portal-record-detail-page.tsx");
const GLOBALS_CSS = read("src/app/globals.css");

/**
 * Residents → detail → Communication is a fill-height chat inside
 * `PortalRecordDetailPage`. The surface's ONLY way out on a phone is that
 * component's own back button plus the resident profile tab strip, and
 * `data-communication-surface` clips `#portal-main-content` — so if the chat is
 * not given a bounded height it overflows a page that cannot scroll and pushes
 * both of them off-screen. Two independent things shipped that: claiming
 * thread-reading chrome (which additionally hides the portal's mobile nav bar),
 * and the block body wrapper that severs the fill chain.
 */
describe("resident detail Communication keeps a way back on a phone", () => {
  it("does not claim thread-reading chrome (it has no inbox back header)", () => {
    const call = RESIDENTS.slice(RESIDENTS.indexOf("useCommunicationSurfaceChrome({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("threadReading: false");
  });

  it("hiding the mobile nav bar is what thread-reading chrome would cost", () => {
    // The justification for that rule is "thread view uses the inbox back
    // header" — a premise this surface does not satisfy.
    expect(GLOBALS_CSS).toContain(
      "html[data-communication-thread-reading] .portal-mobile-nav-bar,",
    );
  });

  it("opts the detail body into a flex fill so the chat has a bounded height", () => {
    // The contract is that COMMUNICATION opts into the flex fill — not the exact shape of the
    // expression. `fillBody` has since been widened to cover the lease and application tabs too
    // (they scroll a document inside a bounded preview frame and otherwise overflow a clipped
    // portal surface), so pinning the old single-tab literal failed a legitimate widening while
    // the behaviour it guards was intact.
    expect(RESIDENTS).toMatch(/fillBody=\{[\s\S]{0,400}?resolvedDetailTab === "communication"/);
    // The rule (AGENTS.md, portal-ui-system) is an UNBROKEN flex-1 + min-h-0
    // chain — one `display: block` link pushes the page header off-screen. The
    // ternary that used to express it was refactored into a derived `bodyFill`,
    // which also covers the pinned-scroll case, so assert the chain the way the
    // component builds it now.
    expect(DETAIL_PAGE).toContain("const bodyFill = fillBody || pinScrollBody");
    expect(DETAIL_PAGE).toContain('cn(bodyFill && "flex min-h-0 flex-1 flex-col")');
  });

  it("leaves every other detail page on block layout", () => {
    expect(DETAIL_PAGE).toContain("fillBody = false");
  });
});
