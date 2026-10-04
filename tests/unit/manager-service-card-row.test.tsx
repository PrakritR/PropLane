// @vitest-environment jsdom
//
// The manager Services row is the Payments row (`PortalApplicantRecordRow`):
// service glyph (or first photo) tile, the SERVICE as the title, "property · room"
// as the place line, glyph facts (resident, stage by tab, money state), the price
// as the figure, and one rounded card per service. The two service models stay separate; only the row's look
// is shared.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManagerServiceCardRow, ResidentServiceCardRow, VendorServiceCardRow } from "@/components/portal/pro-service-card-row";
import { managerServiceCardParts, managerServiceRequestCardFigure, managerServiceRowFacts } from "@/lib/manager-service-list-row";
import { formatPortalRowDate } from "@/lib/portal-display-dates";

const NOW = new Date("2026-10-03T12:00:00Z").getTime();

const base = {
  title: "Storage locker",
  residentName: "Maya Chen",
  residentEmail: "maya@example.com",
  propertyLabel: "Emerald Court",
  unitLabel: "Unit 3",
  scheduledIso: "",
  createdIso: "2026-10-03T18:00:00Z",
};

afterEach(() => cleanup());

describe("formatPortalRowDate", () => {
  it("drops the year in the current year and keeps it otherwise", () => {
    expect(formatPortalRowDate("2026-10-05", NOW)).toBe("Oct 5");
    expect(formatPortalRowDate("2026-10-03T18:00:00Z", NOW)).toBe("Oct 3");
    expect(formatPortalRowDate("2025-10-05", NOW)).toBe("Oct 5, 2025");
    expect(formatPortalRowDate("", NOW)).toBe("");
    expect(formatPortalRowDate("nonsense", NOW)).toBe("");
  });
});

describe("managerServiceCardParts", () => {
  it("titles the row by the service and puts property · room on the place line", () => {
    const parts = managerServiceCardParts(base, { nowMs: NOW });
    expect(parts.name).toBe("Storage locker");
    expect(parts.person).toBe("Maya Chen");
    expect(parts.placeLine).toBe("Emerald Court · Unit 3");
    expect(parts.dateFact?.text).toBe("Requested Oct 3");
  });

  it("prefers the scheduled date over the requested date", () => {
    const parts = managerServiceCardParts({ ...base, scheduledIso: "2026-10-09T17:00:00Z" }, { nowMs: NOW });
    expect(parts.dateFact?.text).toBe("Scheduled Oct 9");
  });

  it("still titles by the service when nobody requested it", () => {
    const parts = managerServiceCardParts({ ...base, residentName: "", residentEmail: "" }, { nowMs: NOW });
    expect(parts.hasPerson).toBe(false);
    expect(parts.name).toBe("Storage locker");
    expect(parts.placeLine).toBe("Emerald Court · Unit 3");
  });

  it("omits the property when the page already names it", () => {
    expect(managerServiceCardParts(base, { omitProperty: true, nowMs: NOW }).placeLine).toBe("Unit 3");
  });
});

describe("managerServiceRowFacts", () => {
  it("says where the service stands, by tab", () => {
    expect(managerServiceRowFacts({ state: "open", createdIso: "2026-09-25T18:00:00Z", nowMs: NOW }).stage.text).toBe("Requested Sep 25");
    expect(managerServiceRowFacts({ state: "assigned", assigneeName: "Rapid Pipes", nowMs: NOW }).stage.text).toBe("Assigned to Rapid Pipes");
    expect(managerServiceRowFacts({ state: "assigned", nowMs: NOW }).stage.text).toBe("Assigned");
    expect(managerServiceRowFacts({ state: "scheduled", scheduledIso: "2026-10-08T16:00:00.000Z", nowMs: NOW }).stage.text).toBe("Thu, Oct 8 · 9am");
    expect(managerServiceRowFacts({ state: "completed", completedIso: "2026-09-27T18:00:00Z", nowMs: NOW }).stage.text).toBe("Completed Sep 27");
    expect(managerServiceRowFacts({ state: "declined", completedIso: "2026-09-27T18:00:00Z", nowMs: NOW }).stage.text).toBe("Declined Sep 27");
  });

  it("states the money as a plain fact, and nothing when there is no bill", () => {
    expect(managerServiceRowFacts({ state: "completed", bill: { amount: "$152", paid: false }, nowMs: NOW }).money?.text).toBe("Bill $152 unpaid");
    expect(managerServiceRowFacts({ state: "completed", bill: { amount: "$152", paid: true }, nowMs: NOW }).money?.text).toBe("Paid");
    expect(managerServiceRowFacts({ state: "open", nowMs: NOW }).money).toBeNull();
  });
});

describe("managerServiceRequestCardFigure", () => {
  it("shows a price and nothing when there is none", () => {
    expect(managerServiceRequestCardFigure({ price: "$25" })).toBe("$25");
    expect(managerServiceRequestCardFigure({ price: "25" })).toBe("$25");
    expect(managerServiceRequestCardFigure({ price: "" })).toBeUndefined();
    expect(managerServiceRequestCardFigure({ price: "—" })).toBeUndefined();
  });
});

describe("ManagerServiceCardRow", () => {
  it("renders the service as the title with place line, resident / stage / money facts, figure and own card", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    render(
      <>
        <ManagerServiceCardRow
          row={{ ...base, title: "Kitchen faucet drip", residentName: "Liam Foster", propertyLabel: "The Pioneer", unitLabel: "Room 8B" }}
          figure="$152"
          facts={managerServiceRowFacts({ state: "completed", completedIso: "2026-09-27T18:00:00Z", bill: { amount: "$152", paid: false }, nowMs: NOW })}
          menu={<button type="button" aria-label="Actions for Kitchen faucet drip">⋯</button>}
          onOpen={() => {}}
          dataAttr="work-order-list-row"
        />
        <ManagerServiceCardRow row={{ ...base, residentName: "Luis Ortega", title: "Parking spot" }} onOpen={() => {}} />
      </>,
    );
    vi.useRealTimers();
    // Title is the service, never the resident; the resident is a fact.
    expect(screen.getByText("Kitchen faucet drip")).toBeTruthy();
    expect(screen.queryByText("MC")).toBeNull();
    expect(screen.getByText("The Pioneer · Room 8B")).toBeTruthy();
    const facts = document.querySelector('[data-attr="record-row-facts"]');
    expect(facts?.textContent).toContain("Liam Foster");
    expect(facts?.textContent).toContain("Completed Sep 27");
    expect(facts?.textContent).toContain("Bill $152 unpaid");
    expect(screen.getByRole("button", { name: "Actions for Kitchen faucet drip" })).toBeTruthy();
    expect(screen.getAllByText("$152").length).toBeGreaterThan(0);
    // Without a stage the requested date stands in.
    expect(screen.getByText("Requested Oct 3")).toBeTruthy();
    const cards = document.querySelectorAll(".portal-property-row");
    expect(cards.length).toBe(2);
    for (const card of Array.from(cards)) {
      expect(card.className).toContain("rounded-xl");
      expect(card.className).toContain("mb-3");
    }
    // No status chip rides on the row.
    expect(document.querySelector('[class*="rounded-full"][class*="bg-"]')).toBeNull();
  });

  it("puts the service glyph in the tile, never the resident's initials", () => {
    render(<ManagerServiceCardRow row={base} onOpen={() => {}} />);
    expect(document.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeTruthy();
    expect(document.querySelector('[data-slot="portal-row-photo-tile"]')).toBeNull();
    expect(screen.queryByText("MC")).toBeNull();
  });

  it("shows the first photo in the tile when the service has one", () => {
    render(<ManagerServiceCardRow row={base} photoUrl="data:image/png;base64,AAAA" onOpen={() => {}} />);
    const tile = document.querySelector('[data-slot="portal-row-photo-tile"]');
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(document.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeNull();
  });

  it("keeps the resident as a fact when there is one and draws none when there is not", () => {
    const { unmount } = render(<ManagerServiceCardRow row={base} onOpen={() => {}} />);
    expect(document.querySelector('[data-attr="record-row-facts"]')?.textContent).toContain("Maya Chen");
    unmount();
    render(<ManagerServiceCardRow row={{ ...base, residentName: "", residentEmail: "" }} onOpen={() => {}} />);
    expect(document.querySelector('[data-attr="record-row-facts"]')?.textContent ?? "").not.toContain("Maya");
  });
});

describe("ResidentServiceCardRow", () => {
  it("titles the row by the service with the service glyph tile, place line, date fact and price", () => {
    render(
      <ResidentServiceCardRow
        row={{ title: "Storage locker", propertyLabel: "Emerald Court", unitLabel: "Room 2", scheduledIso: "", createdIso: "2026-10-03T18:00:00Z" }}
        request={{ price: "$25", priceLimit: "" }}
        onSelectedChange={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Storage locker")).toBeTruthy();
    expect(screen.getByText("Emerald Court · Room 2")).toBeTruthy();
    expect(screen.getByText(/^Requested /)).toBeTruthy();
    expect(screen.getAllByText("$25").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeTruthy();
    expect(document.querySelector(".portal-property-row")?.className).toContain("rounded-xl");
  });

  it("draws no figure for a maintenance request", () => {
    render(
      <ResidentServiceCardRow
        row={{ title: "Leaking tap", propertyLabel: "Emerald Court", unitLabel: "", scheduledIso: "2026-10-09T17:00:00Z", createdIso: "" }}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/^Scheduled /)).toBeTruthy();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

describe("VendorServiceCardRow", () => {
  it("shows site initials in the tile, the service as title, place line, scheduled date and job amount", () => {
    render(
      <VendorServiceCardRow
        title="Replace faucet"
        placeLine="Emerald Court · Unit 3"
        dateText="Scheduled Oct 9"
        figure="$180"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("EC")).toBeTruthy();
    expect(screen.getByText("Replace faucet")).toBeTruthy();
    expect(screen.getByText("Emerald Court · Unit 3")).toBeTruthy();
    expect(screen.getByText("Scheduled Oct 9")).toBeTruthy();
    expect(screen.getAllByText("$180").length).toBeGreaterThan(0);
  });
});

describe("Services and Tasks lists share the Payments row", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  it("the card rows are built on PortalApplicantRecordRow, not a second row", () => {
    expect(read("src/components/portal/pro-service-card-row.tsx")).toContain("PortalApplicantRecordRow");
    expect(read("src/components/portal/pro-task-row.tsx")).toContain("PortalApplicantRecordRow");
    expect(read("src/components/portal/pro-payments-ledger-panel.tsx")).toContain("PortalApplicantRecordRow");
  });
  it("the resident and vendor Services lists render the shared card too", () => {
    expect(read("src/components/portal/resident-services-panel.tsx")).toContain("ResidentServiceCardRow");
    expect(read("src/components/portal/resident-portal-grouped-data-list.tsx")).toContain("renderRow");
    expect(read("src/components/portal/vendor-work-orders-panel.tsx")).toContain("VendorServiceCardRow");
    expect(read("src/components/portal/vendor-work-orders-panel.tsx")).not.toContain("PortalServiceRecordRow");
  });
  it("the manager Services lists no longer draw the joined wrench-tile row", () => {
    expect(read("src/components/portal/pro-all-services-panel.tsx")).not.toContain("PortalServiceRecordRow");
    expect(read("src/components/portal/pro-property-requests-panel.tsx")).not.toContain("PortalServiceRecordRow");
    expect(read("src/components/portal/pro-all-services-panel.tsx")).toContain("ManagerServiceCardRow");
  });
});
