// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeAll } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { QuickActionRow } from "@/components/ui/quick-action-row";
import { DestinationNav } from "@/components/ui/destination-nav";
import { DataList } from "@/components/ui/data-list";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { PortalTabs } from "@/components/ui/portal-tabs";

beforeAll(() => {
  class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

// This project runs vitest without `globals: true`, so Testing Library never
// installs its auto-cleanup hook — a rendered tree stays mounted for the rest of
// the file. `DestinationNav` and `QuickActionRow` render `next/link`, which keeps
// scheduling React work after `act()` returns; the commit that follows queues a
// passive-effect flush on the real Scheduler (a `setImmediate`) that reads
// `window.event`. Left mounted, that callback loses the race against jsdom
// teardown and fails the run with "ReferenceError: window is not defined".
// Unmounting after each test cancels the pending work instead.
afterEach(cleanup);

describe("DestinationNav", () => {
  it("marks active item by id", () => {
    render(
      <DestinationNav
        items={[
          { id: "pending", label: "Pending", href: "/portal/payments/incoming/pending", count: 5 },
          { id: "paid", label: "Paid", href: "/portal/payments/incoming/paid" },
        ]}
        activeId="pending"
      />,
    );
    expect(screen.getByRole("link", { name: /Pending/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Paid/ }).getAttribute("aria-current")).toBeNull();
  });

  it("uses horizontal scroll sizing on phones so long labels do not clip", () => {
    render(
      <DestinationNav
        items={[
          { id: "manager", label: "Manager review", shortLabel: "Mgr review", href: "/portal/leases/manager", count: 0 },
          { id: "resident", label: "Resident signature", shortLabel: "Resident", href: "/portal/leases/resident", count: 0 },
        ]}
        activeId="manager"
      />,
    );
    const link = screen.getByRole("link", { name: /Mgr review/ });
    expect(link.className).toContain("max-lg:flex-none");
    expect(link.className).toContain("max-lg:whitespace-nowrap");
  });

  it("renders compact queue counts in the command appearance", () => {
    render(
      <DestinationNav
        items={[
          { id: "pending", label: "Pending", href: "/portal/tours/pending", count: 5 },
          { id: "past", label: "Past", href: "/portal/tours/past", count: 0 },
        ]}
        activeId="pending"
        appearance="command"
      />,
    );
    const active = screen.getByRole("link", { name: /Pending/ });
    expect(active.className).toContain("border-primary");
    expect(screen.getByLabelText("5 items")).toBeTruthy();
  });
});

describe("PageHeader", () => {
  it("renders title without tab counts", () => {
    render(<PageHeader title="Payments" count={12} />);
    expect(screen.getByRole("heading", { name: /Payments/ })).toBeTruthy();
    expect(screen.queryByText("12")).toBeNull();
  });

  it("shows title on mobile by default", () => {
    const { container } = render(<PageHeader title="Residents" />);
    const header = container.querySelector("[data-slot=page-header]");
    expect(header?.className).not.toContain("sr-only");
  });
});

describe("FilterBar", () => {
  it("renders pills and removable chips", () => {
    const onRemove = vi.fn();
    render(
      <FilterBar
        pills={[
          { id: "all", label: "All", active: true, onClick: () => {} },
          { id: "pending", label: "Pending", onClick: () => {} },
        ]}
        chips={[{ id: "house", label: "House A", onRemove }]}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /House A/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /House A/ }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe("BulkActionBar", () => {
  it("renders nothing when count is zero", () => {
    const { container } = render(<BulkActionBar count={0}>Actions</BulkActionBar>);
    expect(container.firstChild).toBeNull();
  });

  it("shows selection count when active", () => {
    render(
      <BulkActionBar count={3}>
        <button type="button">Delete</button>
      </BulkActionBar>,
    );
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("hides selection count when hideCount is set", () => {
    render(
      <BulkActionBar count={2} hideCount>
        <button type="button">Message</button>
      </BulkActionBar>,
    );
    expect(screen.queryByText("2 selected")).toBeNull();
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
  });

  it("uses a custom count label when provided", () => {
    render(
      <BulkActionBar count={3} countLabel={(n) => `${n} tours selected`}>
        <button type="button">Confirm</button>
      </BulkActionBar>,
    );
    expect(screen.getByText("3 tours selected")).toBeTruthy();
  });
});

describe("PortalTabs", () => {
  it("switches tabs on click", () => {
    const onChange = vi.fn();
    render(
      <PortalTabs
        items={[
          { id: "pending", label: "Pending" },
          { id: "paid", label: "Paid" },
        ]}
        activeId="pending"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getAllByRole("tab", { name: "Paid" })[0]!);
    expect(onChange).toHaveBeenCalledWith("paid");
  });
});

describe("DataList", () => {
  it("renders mobile rows and empty state", () => {
    const { container, rerender } = render(
      <DataList
        rows={[
          {
            id: "1",
            data: { name: "Alice" },
            primary: "Alice",
            meta: "Unit 2A",
            trailing: "$500",
          },
        ]}
        columns={[
          { id: "name", header: "Name", cell: (r) => r.name },
        ]}
      />,
    );
    const mobileRow = container.querySelector("[data-slot=data-list-mobile-row]");
    expect(mobileRow?.textContent).toContain("Alice");
    expect(mobileRow?.textContent).toContain("Unit 2A");

    rerender(
      <DataList
        rows={[]}
        columns={[{ id: "name", header: "Name", cell: () => "" }]}
        emptyState={<EmptyState title="No records" />}
      />,
    );
    expect(screen.getByText("No records")).toBeTruthy();
  });

  it("keeps a selectable mobile row checkbox outside its record button", () => {
    const { container } = render(
      <DataList
        selectable
        rows={[
          {
            id: "1",
            data: { name: "Alice" },
            primary: "Alice",
            selected: false,
            onSelectedChange: () => {},
            onClick: () => {},
          },
        ]}
        columns={[{ id: "name", header: "Name", cell: (row) => row.name }]}
      />,
    );
    const mobileRow = container.querySelector("[data-slot=data-list-mobile-row]");
    // The invariant: the checkbox is never nested inside the record <button>
    // (invalid HTML, breaks keyboard use). It now sits in a sibling <label> that
    // widens the touch target to ~40px — see PORTAL_LIST_CHECKBOX_HIT_CLASS and
    // AXI-157, where a near-miss on the 16px box opened the record instead.
    expect(mobileRow?.querySelector("button input")).toBeNull();
    expect(mobileRow?.querySelector(":scope > label > input[type=checkbox]")).toBeTruthy();
    expect(mobileRow?.querySelector(":scope > button")).toBeTruthy();
  });
});

describe("EmptyState", () => {
  it("renders title and primary action", () => {
    const onAction = vi.fn();
    render(
      <EmptyState title="Nothing here" actionLabel="Add one" onAction={onAction} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add one" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});

describe("ListSkeleton", () => {
  it("renders shaped placeholder rows", () => {
    const { container } = render(<ListSkeleton rows={3} />);
    expect(container.querySelectorAll("[data-slot=list-skeleton] > div").length).toBe(3);
  });
});

describe("QuickActionRow", () => {
  it("renders link and button actions", () => {
    const onClick = vi.fn();
    render(
      <QuickActionRow
        actions={[
          { id: "a", label: "Review", href: "/portal/payments" },
          { id: "b", label: "Add", onClick, primary: true },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/portal/payments");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
