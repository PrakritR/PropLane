// @vitest-environment jsdom
//
// The manager Services row is the Payments row (`PortalApplicantRecordRow`):
// initials tile, the requester as the title, "service · property · room" as the
// place line, one dated glyph fact, the price as the figure, and one rounded
// card per service. The two service models stay separate; only the row's look
// is shared.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManagerServiceCardRow } from "@/components/portal/pro-service-card-row";
import { managerServiceCardParts, managerServiceRequestCardFigure } from "@/lib/manager-service-list-row";
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
  it("titles the row by the requester and leads the place line with the service", () => {
    const parts = managerServiceCardParts(base, { nowMs: NOW });
    expect(parts.name).toBe("Maya Chen");
    expect(parts.placeLine).toBe("Storage locker · Emerald Court · Unit 3");
    expect(parts.dateFact?.text).toBe("Requested Oct 3");
  });

  it("prefers the scheduled date over the requested date", () => {
    const parts = managerServiceCardParts({ ...base, scheduledIso: "2026-10-09T17:00:00Z" }, { nowMs: NOW });
    expect(parts.dateFact?.text).toBe("Scheduled Oct 9");
  });

  it("falls back to the service as the title when nobody requested it", () => {
    const parts = managerServiceCardParts({ ...base, residentName: "", residentEmail: "" }, { nowMs: NOW });
    expect(parts.hasPerson).toBe(false);
    expect(parts.name).toBe("Storage locker");
    expect(parts.placeLine).toBe("Emerald Court · Unit 3");
  });

  it("omits the property when the page already names it", () => {
    expect(managerServiceCardParts(base, { omitProperty: true, nowMs: NOW }).placeLine).toBe("Storage locker · Unit 3");
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
  it("renders the Payments row: initials tile, name title, fact line, figure slot, own card", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    render(
      <>
        <ManagerServiceCardRow row={base} figure="$25" menu={<button type="button" aria-label="Actions for Storage locker">⋯</button>} onOpen={() => {}} dataAttr="service-request-list-row" />
        <ManagerServiceCardRow row={{ ...base, residentName: "Luis Ortega", title: "Parking spot" }} onOpen={() => {}} />
      </>,
    );
    vi.useRealTimers();
    expect(screen.getByText("MC")).toBeTruthy();
    expect(screen.getByText("Maya Chen")).toBeTruthy();
    expect(screen.getByText("Storage locker · Emerald Court · Unit 3")).toBeTruthy();
    expect(screen.getAllByText("Requested Oct 3").length).toBe(2);
    expect(screen.getByRole("button", { name: "Actions for Storage locker" })).toBeTruthy();
    // The price is the bold figure; a service with none draws nothing there.
    expect(screen.getAllByText("$25").length).toBeGreaterThan(0);
    const cards = document.querySelectorAll(".portal-property-row");
    expect(cards.length).toBe(2);
    for (const card of Array.from(cards)) {
      expect(card.className).toContain("rounded-xl");
      expect(card.className).toContain("mb-3");
    }
    // No status chip rides on the row.
    expect(document.querySelector('[class*="rounded-full"][class*="bg-"]')).toBeNull();
  });

  it("uses the property glyph tile when there is no requester", () => {
    render(<ManagerServiceCardRow row={{ ...base, residentName: "", residentEmail: "" }} onOpen={() => {}} />);
    expect(document.querySelector('[data-slot="portal-row-glyph-tile"]')).toBeTruthy();
  });
});

describe("Services and Tasks lists share the Payments row", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  it("the card rows are built on PortalApplicantRecordRow, not a second row", () => {
    expect(read("src/components/portal/pro-service-card-row.tsx")).toContain("PortalApplicantRecordRow");
    expect(read("src/components/portal/pro-task-row.tsx")).toContain("PortalApplicantRecordRow");
    expect(read("src/components/portal/pro-payments-ledger-panel.tsx")).toContain("PortalApplicantRecordRow");
  });
  it("the manager Services lists no longer draw the joined wrench-tile row", () => {
    expect(read("src/components/portal/pro-all-services-panel.tsx")).not.toContain("PortalServiceRecordRow");
    expect(read("src/components/portal/pro-property-requests-panel.tsx")).not.toContain("PortalServiceRecordRow");
    expect(read("src/components/portal/pro-all-services-panel.tsx")).toContain("ManagerServiceCardRow");
  });
});
