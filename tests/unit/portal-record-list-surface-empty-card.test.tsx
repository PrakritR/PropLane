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
