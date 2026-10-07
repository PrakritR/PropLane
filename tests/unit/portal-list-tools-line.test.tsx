// @vitest-environment jsdom
//
// The list header band's tools line (approved list anatomy, dashboard-redesign-1007):
// one search line with a right-aligned "N records" figure DERIVED from the rows on
// screen (never a number a list has to remember to pass), and a row that opens the
// record in place - there is no peek panel.
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Settings } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { Wrench } from "lucide-react";
import { PortalTitleActionsHost, PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/all",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(cleanup);

const ROWS = [
  { id: "a", title: "14 Cedar Lane", place: "Fremont, Seattle" },
  { id: "b", title: "2208 Pine St", place: "Ballard, Seattle" },
  { id: "c", title: "9 Alder Row", place: "Capitol Hill, Seattle" },
];

function Harness({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState("");
  const shown = ROWS.filter((r) => r.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div data-slot="portal-page-shell">
      <PortalListControlStack
        variant="command"
        stickyDestinations={false}
        destinations={[{ id: "all", label: "All", href: "/portal/properties/all", count: ROWS.length }]}
        activeDestinationId="all"
        search={{ value: q, onChange: setQ, placeholder: "Search properties" }}
        actions={<PortalIconAction icon={Settings} label="Settings" />}
        primary={<PortalPrimaryIconAction label="Add property" />}
      />
      <div>
        {shown.map((r) => (
          <PortalPropertyRecordRow
            key={r.id}
            title={r.title}
            address={r.place}
            facts={<PortalRowFact icon={Wrench}>1 open</PortalRowFact>}
            amount="$3,600"
            amountSubLabel="per month"
            onOpen={() => onOpen(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

describe("list tools line", () => {
  it("shows the count of the rows on screen, singular at one, and follows the search", async () => {
    render(<Harness onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText("3 records")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("searchbox", { name: "Search properties" }), { target: { value: "pine" } });
    await waitFor(() => expect(screen.getByText("1 record")).toBeInTheDocument());
    expect(screen.queryByText("3 records")).toBeNull();
  });

  it("an explicit recordCount wins over the derived figure", async () => {
    render(
      <div data-slot="portal-page-shell">
        <PortalListControlStack
          variant="command"
          stickyDestinations={false}
          destinations={[{ id: "all", label: "All", href: "/portal/properties/all" }]}
          search={{ value: "", onChange: () => {}, placeholder: "Search" }}
          recordCount={12}
        />
      </div>,
    );
    expect(screen.getByText("12 records")).toBeInTheDocument();
  });

  it("draws no count when no row is on screen", async () => {
    render(
      <div data-slot="portal-page-shell">
        <PortalListControlStack
          variant="command"
          stickyDestinations={false}
          destinations={[{ id: "all", label: "All", href: "/portal/properties/all" }]}
          search={{ value: "", onChange: () => {}, placeholder: "Search" }}
        />
      </div>,
    );
    await act(async () => {});
    expect(document.querySelector('[data-slot="portal-list-count"]')).toBeNull();
  });
});

describe("list row", () => {
  it("opens the record itself on click - no peek panel in between", () => {
    const onOpen = vi.fn();
    const { container } = render(<Harness onOpen={onOpen} />);

    // Clicking anywhere on the row (not just the title button) opens the record.
    const row = container.querySelector("[data-record-row]") as HTMLElement;
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("a");

    // Nothing else opens: no dialog, no complementary peek pane.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(container.querySelector('[data-slot="portal-record-peek"]')).toBeNull();
  });

  it("keeps the facts on the one line beside the figure at desktop width, once", () => {
    const { container } = render(<Harness onOpen={() => {}} />);
    const facts = container.querySelectorAll('[data-attr="record-row-facts"]');
    expect(facts).toHaveLength(ROWS.length);
    expect(container.textContent).toContain("$3,600");
    expect(container.textContent).toContain("per month");
  });
});

describe("list header actions", () => {
  const stack = (
    <PortalListControlStack
      variant="command"
      stickyDestinations={false}
      destinations={[{ id: "all", label: "All", href: "/portal/properties/all" }]}
      search={{ value: "", onChange: () => {}, placeholder: "Search" }}
      actions={<PortalIconAction icon={Settings} label="Settings" />}
      primary={<PortalPrimaryIconAction label="Add property" />}
    />
  );

  it("lifts the icon actions and the round + onto the page's title row", async () => {
    render(
      <PortalTitleActionsProvider>
        <PortalTitleActionsHost />
        {stack}
      </PortalTitleActionsProvider>,
    );
    const slot = await waitFor(() => {
      const el = document.querySelector('[data-slot="portal-title-actions"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(slot.querySelector('[aria-label="Add property"]')).not.toBeNull();
    expect(slot.querySelector('[aria-label="Settings"]')).not.toBeNull();
    // Nothing is drawn twice: the band itself no longer holds them.
    expect(document.querySelectorAll('[aria-label="Add property"]')).toHaveLength(1);
  });

  it("leaves a record's own header icons alone - the band keeps its controls in a record page", () => {
    render(
      <PortalTitleActionsProvider>
        <PortalTitleActionsHost detail />
        {stack}
      </PortalTitleActionsProvider>,
    );
    const band = document.querySelector('[data-slot="portal-list-control-stack"]') as HTMLElement;
    expect(band.querySelector('[aria-label="Add property"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="portal-title-actions"]')).toBeNull();
  });
});
