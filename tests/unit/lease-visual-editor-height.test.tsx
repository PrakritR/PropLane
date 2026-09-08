// @vitest-environment jsdom
//
// Reported: "Generated Lease Cannot Be Viewed in Visual Mode" — Generate lease → the HTML tab
// shows the whole document, the Visual tab is completely blank.
//
// Nothing was wrong with the document or the write: the iframe held the full lease. It rendered
// at ZERO pixels tall. The Visual pane is an `absolute inset-0` iframe, so it contributes no
// intrinsic height; its box was `min-h-0 flex-1` inside a modal panel that only ever had a
// max-height CAP, never a height. With every ancestor content-sized, `flex-1` had nothing to
// distribute and the box resolved to 0. The HTML tab kept working because a `<textarea>` has an
// intrinsic rows height, which grew the same track — which is exactly why the failure reads as
// "the visual preview is broken" rather than "the modal has no height".
//
// jsdom has no layout, so this cannot assert pixels. It asserts the invariant that makes the
// collapse impossible: the box holding the iframe carries a height FLOOR and never `min-h-0`.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { LeaseHtmlDirectEditor } from "@/components/portal/lease-html-direct-editor";

afterEach(cleanup);

const LEASE = "<!DOCTYPE html><html><body><h1>Lease</h1><h2>1. Parties</h2><p>Body</p></body></html>";

describe("lease visual editor height", () => {
  it("gives the visual pane a height floor so it cannot render blank", () => {
    const { container } = render(
      <LeaseHtmlDirectEditor html={LEASE} baselineHtml={LEASE} onChange={() => {}} showPersistBar={false} />,
    );

    const root = container.querySelector('[data-attr="lease-html-direct-editor"]');
    expect(root).not.toBeNull();

    const classes = (root!.className || "").split(/\s+/);
    // `min-h-0` as the DEFAULT is the defect: it authorizes the collapse to zero in a
    // host that never sizes the editor. A host that does size it overrides this floor
    // through tailwind-merge, so the floor costs those hosts nothing.
    expect(classes).not.toContain("min-h-0");
    expect(classes.some((c) => /^min-h-/.test(c))).toBe(true);
  });

  it("lets a host that sizes the editor keep its own height", () => {
    const { container } = render(
      <LeaseHtmlDirectEditor
        html={LEASE}
        baselineHtml={LEASE}
        onChange={() => {}}
        showPersistBar={false}
        className="min-h-[min(380px,50vh)] flex-1"
      />,
    );

    const classes = (container.querySelector('[data-attr="lease-html-direct-editor"]')!.className || "").split(/\s+/);
    expect(classes).toContain("min-h-[min(380px,50vh)]");
    expect(classes).not.toContain("min-h-64");
  });
});
