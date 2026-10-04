// @vitest-environment jsdom
//
// An empty list keeps the band's + and the dashed ADD footer — never a
// second labeled Add button inside the empty card itself (PLAN-0920-1058
// "1a · The list page"). The card still keeps its title.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/leases" }));

afterEach(cleanup);

describe("PortalRecordListSurface empty card", () => {
  it("shows the title but no Add button when only `add` is given", () => {
    render(
      <PortalRecordListSurface isEmpty add={{ ariaLabel: "Add lease", onClick: vi.fn() }}>
        <div />
      </PortalRecordListSurface>,
    );
    expect(screen.getByText(/no leases yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add lease/i })).toBeNull();
  });

  it("keeps a caller's own emptyCard title and drops the auto-added Add button", () => {
    render(
      <PortalRecordListSurface
        isEmpty
        add={{ ariaLabel: "Add vendor", onClick: vi.fn() }}
        emptyCard={{ title: "No vendors yet" }}
      >
        <div />
      </PortalRecordListSurface>,
    );
    expect(screen.getByText("No vendors yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add vendor/i })).toBeNull();
  });

  it("drops the Add button under a caller-supplied `empty` node too", () => {
    render(
      <PortalRecordListSurface isEmpty add={{ ariaLabel: "Add task", onClick: vi.fn() }} empty={<p>Nothing due</p>}>
        <div />
      </PortalRecordListSurface>,
    );
    expect(screen.getByText("Nothing due")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add task/i })).toBeNull();
  });

  it("still shows the dashed ADD footer for an inline (embedded) list", () => {
    render(
      <PortalRecordListSurface add={{ ariaLabel: "Add charge", onClick: vi.fn(), inline: true }}>
        <div />
      </PortalRecordListSurface>,
    );
    expect(screen.getByRole("button", { name: "Add charge" })).toBeInTheDocument();
  });
});

describe("services empty state is one surface", () => {
  it("renders exactly one bordered card for an empty list surface", () => {
    const { container } = render(
      <PortalRecordListSurface isEmpty emptyCard={{ title: "No assigned services", section: "services" }}>
        <div />
      </PortalRecordListSurface>,
    );
    const cards = container.querySelectorAll(".border-border.bg-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute("data-attr")).toBe("portal-list-empty-card");
  });

  it("the services panel drops its joined outer card when the tab is empty", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/portal/pro-all-services-panel.tsx", "utf8");
    // The outer joined-card chrome is gated on rows existing...
    expect(src).toMatch(/!servicesListIsEmpty && "overflow-hidden rounded-xl border border-border bg-card shadow-sm"/);
    // ...and never applied unconditionally around the empty card.
    expect(src).not.toMatch(/className="svc30 overflow-hidden rounded-xl border/);
    expect(src).toMatch(/!servicesListIsEmpty && "border-t border-border pb-0 lg:pb-0 max-lg:pb-0"/);
  });
});
