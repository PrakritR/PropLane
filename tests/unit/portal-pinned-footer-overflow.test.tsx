// @vitest-environment jsdom
/**
 * The pinned footer dock is `position: fixed`, so its action row cannot rely on
 * the page to scroll. The `header` variant packs buttons that neither wrap nor
 * shrink, which on a narrow phone pushes the trailing action off the side of the
 * screen with nothing to scroll — the "clipped surfaces make overflow
 * unreachable" failure. The row scrolls horizontally instead.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { PortalPageFooterActions } from "@/components/portal/portal-section-action-row";
import { HORIZONTAL_SCROLL_ATTR } from "@/lib/horizontal-scroll";

function footerRow(container: HTMLElement): HTMLElement | null {
  const dock = container.querySelector<HTMLElement>("[data-slot='portal-page-footer-actions']")!;
  return dock.querySelector<HTMLElement>(`[${HORIZONTAL_SCROLL_ATTR}]`);
}

describe("pinned footer action row", () => {
  it("keeps header-variant actions in a single nowrap row (adaptive footer, no clip)", () => {
    const { container, getByText } = render(
      <PortalPageFooterActions pinned rowVariant="header">
        <button type="button">Reminders</button>
        <button type="button">Payment setup</button>
        <button type="button">Add payment</button>
      </PortalPageFooterActions>,
    );

    const dock = container.querySelector<HTMLElement>("[data-slot='portal-page-footer-actions']");
    expect(dock).toBeTruthy();
    expect(dock!.dataset.rowVariant).toBe("header");
    const row = dock!.querySelector<HTMLElement>("[data-row-variant='header'] > div > div");
    expect(row).toBeTruthy();
    expect(row!.className).toContain("flex-nowrap");
    expect(row!.className).toContain("overflow-hidden");
    expect(getByText("Add payment")).toBeTruthy();
  });

  it("still marks the toolbar variant for wheel forwarding", () => {
    const { container } = render(
      <PortalPageFooterActions>
        <button type="button">Create</button>
      </PortalPageFooterActions>,
    );

    expect(footerRow(container)).toBeTruthy();
  });
});
