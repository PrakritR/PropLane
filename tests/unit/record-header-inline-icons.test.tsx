// @vitest-environment jsdom
/**
 * Captain rule (2026-10-16): a record's header actions are icons whenever they fit. The ⋯ appears only when
 * they do not fit (more than five, or a phone), never because a content-sized title slot made the row measure
 * itself as empty.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Copy, Pencil, Share2, Trash2, CircleOff, Eye } from "lucide-react";
import { PortalAdaptiveActionRow, type PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  PortalTitleActionsHost,
  PortalTitleActionsProvider,
  usePublishTitleActions,
} from "@/components/portal/portal-title-actions-slot";
import { RECORD_HEADER_INLINE_MAX, recordHeaderInlineLimit } from "@/lib/portal-adaptive-actions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubViewport(lgUp: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("1024") || query.includes("768") ? lgUp : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

const ICONS = [Pencil, Share2, CircleOff, Copy, Eye, Trash2];

function makeActions(count: number): PortalAdaptiveAction[] {
  return ICONS.slice(0, count).map((icon, index) => {
    const label = `Action ${index + 1}`;
    return {
      id: `a${index}`,
      tone: index === count - 1 && index === 3 ? ("danger" as const) : undefined,
      node: <PortalIconAction ring icon={icon} label={label} />,
      menuItem: <span>{label}</span>,
    };
  });
}

function Publisher({ count }: { count: number }) {
  usePublishTitleActions(<PortalAdaptiveActionRow actions={makeActions(count)} align="end" gapPx={6} />, true);
  return null;
}

function Header({ count, detail }: { count: number; detail: boolean }) {
  return (
    <PortalTitleActionsProvider>
      <PortalTitleActionsHost detail={detail} />
      <Publisher count={count} />
    </PortalTitleActionsProvider>
  );
}

describe("recordHeaderInlineLimit", () => {
  it("shows a short set inline only in a record header on desktop", () => {
    expect(recordHeaderInlineLimit(2, true, true)).toBe(2);
    expect(recordHeaderInlineLimit(RECORD_HEADER_INLINE_MAX, true, true)).toBe(RECORD_HEADER_INLINE_MAX);
    expect(recordHeaderInlineLimit(RECORD_HEADER_INLINE_MAX + 1, true, true)).toBeUndefined();
    expect(recordHeaderInlineLimit(3, true, false)).toBeUndefined();
    expect(recordHeaderInlineLimit(3, false, true)).toBeUndefined();
    expect(recordHeaderInlineLimit(0, true, true)).toBeUndefined();
  });
});

describe("a record header's actions", () => {
  it("renders all five as icons with a label each and no ⋯ on desktop", () => {
    stubViewport(true);
    render(<Header count={5} detail />);
    for (let n = 1; n <= 5; n++) expect(screen.getByRole("button", { name: `Action ${n}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("keeps a single destructive icon inline too", () => {
    stubViewport(true);
    render(<Header count={4} detail />);
    expect(screen.getAllByRole("button").length).toBe(4);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("falls back to the measured row (hidden measure strip + ⋯ slot) when there are more than five", () => {
    stubViewport(true);
    render(<Header count={6} detail />);
    expect(document.querySelector("[data-portal-adaptive-fit-more]")).not.toBeNull();
  });

  it("keeps the measured row on a phone width and outside a record header", () => {
    stubViewport(false);
    render(<Header count={3} detail />);
    expect(document.querySelector("[data-portal-adaptive-fit-more]")).not.toBeNull();
    cleanup();
    stubViewport(true);
    render(<Header count={3} detail={false} />);
    expect(document.querySelector("[data-portal-adaptive-fit-more]")).not.toBeNull();
  });

  it("measures nothing for a short set in a desktop record header", () => {
    stubViewport(true);
    render(<Header count={3} detail />);
    expect(document.querySelector("[data-portal-adaptive-fit-more]")).toBeNull();
  });
});

describe("the ⋯ of a header that cannot fit its icons", () => {
  it("draws a leading glyph on each plain-text item", async () => {
    stubViewport(true);
    const actions: PortalAdaptiveAction[] = [Pencil, Share2].map((icon, index) => ({
      id: `m${index}`,
      node: <PortalIconAction ring icon={icon} label={`Item ${index}`} />,
      menuItem: <DropdownMenuItem>{`Item ${index}`}</DropdownMenuItem>,
    }));
    // pinnedMenuItems forces the ⋯ to exist even though jsdom measures every width as 0.
    render(<PortalAdaptiveActionRow actions={actions} pinnedMenuItems={[<DropdownMenuItem key="p">Pinned</DropdownMenuItem>]} maxVisible={0} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), { key: "ArrowDown" });
    const items = await screen.findAllByRole("menuitem");
    const withGlyph = items.filter((item) => item.textContent?.startsWith("Item") && item.querySelector("svg"));
    expect(withGlyph).toHaveLength(2);
  });
});
