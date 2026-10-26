import { describe, expect, it } from "vitest";
import { deriveStayCard, nextPaymentLabel, stayCardLeaseFromRow, stayDatesLabel } from "@/lib/inbox-stay-card";

/**
 * A3 (stay chat). The stay card is derived on read from the person's current lease, booking or approved
 * application in the workspace. Nothing is stored; no stay and nothing approved = no card.
 */
const NOV_1 = new Date(2026, 10, 1).getTime();
const NOV_15 = new Date(2026, 10, 15).getTime();

const lease = {
  id: "lease-1",
  homeLabel: "4709A 8th Ave",
  roomLabel: "Room 3",
  rentLabel: "$1,150.00 / month",
  start: "2026-11-01",
  end: "2027-04-30",
  phase: "signed" as const,
};

describe("a lease is the stay", () => {
  it("the resident sees home and room, dates, rent, next payment and Pay / Lease / Request service", () => {
    const card = deriveStayCard({ viewer: "resident", leases: [lease], charges: [{ unpaid: true, dueMs: NOV_15 }, { unpaid: true, dueMs: NOV_1 }, { unpaid: false, dueMs: new Date(2026, 9, 1).getTime() }] })!;
    expect(card.source).toBe("lease");
    expect(card.title).toBe("4709A 8th Ave · Room 3");
    expect(card.fact).toBe("Nov 1 – Apr 30 · $1,150 / mo · next payment Nov 1");
    expect(card.actions.map((a) => a.label)).toEqual(["Pay", "Lease", "Request service"]);
    expect(card.actions.every((a) => a.href.startsWith("/resident/"))).toBe(true);
    expect(card.photoUrl).toBeNull();
  });

  it("the manager sees the same stay with the lease state and Charge / Lease / Record", () => {
    const card = deriveStayCard({ viewer: "manager", leases: [lease], charges: [{ unpaid: true, dueMs: NOV_1 }] })!;
    expect(card.fact).toBe("Nov 1 – Apr 30 · $1,150 / mo · next payment Nov 1 · lease signed");
    expect(card.actions.map((a) => a.label)).toEqual(["Charge", "Lease", "Record"]);
    expect(card.actions.every((a) => a.href.startsWith("/portal/"))).toBe(true);
  });

  it("a lease waiting on a signature says so and has no next payment yet", () => {
    const sent = { ...lease, phase: "sent" as const };
    expect(deriveStayCard({ viewer: "resident", leases: [sent], charges: [{ unpaid: true, dueMs: NOV_1 }] })!.fact).toBe("Nov 1 – Apr 30 · $1,150 / mo · lease ready to sign");
    expect(deriveStayCard({ viewer: "manager", leases: [sent] })!.fact).toContain("lease sent");
  });

  it("a signed lease wins over a newer unsigned one, and the photo is the listing's own or none", () => {
    const newer = { ...lease, id: "lease-2", phase: "sent" as const };
    expect(deriveStayCard({ viewer: "manager", leases: [newer, { ...lease, photoUrl: "data:image/jpeg;base64,AAAA" }] })!.photoUrl).toBe("data:image/jpeg;base64,AAAA");
  });

  it("years show only when the stay runs a year or more", () => {
    expect(stayDatesLabel("2026-11-01", "2027-04-30")).toBe("Nov 1 – Apr 30");
    expect(stayDatesLabel("2026-11-01", "2027-11-01")).toBe("Nov 1, 2026 – Nov 1, 2027");
    expect(stayDatesLabel("2026-11-01", "2026-12-15")).toBe("Nov 1 – Dec 15");
    expect(stayDatesLabel("2026-11-01", null)).toBe("from Nov 1");
    expect(nextPaymentLabel([{ unpaid: false, dueMs: NOV_1 }, { unpaid: true, dueMs: null }])).toBe("");
  });
});

describe("a booking is the stay when there is no lease", () => {
  const booking = { id: "stay-1", homeLabel: "Cedar Court", roomLabel: "Room 2", checkIn: "2026-11-05", checkOut: "2026-11-09", totalLabel: "$480", live: true };

  it("draws the stay's dates and total", () => {
    const card = deriveStayCard({ viewer: "resident", bookings: [booking], now: new Date(2026, 10, 1) })!;
    expect(card.source).toBe("booking");
    expect(card.title).toBe("Cedar Court · Room 2");
    expect(card.fact).toBe("Nov 5 – Nov 9 · $480");
  });

  it("a cancelled stay and an ended stay are no stay", () => {
    expect(deriveStayCard({ viewer: "resident", bookings: [{ ...booking, live: false }], now: new Date(2026, 10, 1) })).toBeNull();
    expect(deriveStayCard({ viewer: "resident", bookings: [booking], now: new Date(2026, 11, 20) })).toBeNull();
  });

  it("the nearest upcoming stay is the one shown", () => {
    const later = { ...booking, id: "stay-2", checkIn: "2026-12-01", checkOut: "2026-12-03" };
    expect(deriveStayCard({ viewer: "manager", bookings: [later, booking], now: new Date(2026, 10, 1) })!.fact).toContain("Nov 5");
  });
});

describe("approved with no lease yet (the empty state)", () => {
  it("says the application is approved and the lease has not gone out, with one next step", () => {
    const card = deriveStayCard({ viewer: "resident", applications: [{ id: "app-1", homeLabel: "4709A 8th Ave", roomLabel: "Room 3", approved: true }] })!;
    expect(card.source).toBe("application");
    expect(card.title).toBe("4709A 8th Ave · Room 3");
    expect(card.fact).toBe("Application approved · lease not sent yet");
    expect(card.actions.map((a) => a.label)).toEqual(["Lease"]);
  });

  it("a draft lease is not a stay yet; it reads as the same empty state", () => {
    const draft = { ...lease, phase: "draft" as const };
    expect(deriveStayCard({ viewer: "manager", leases: [draft] })!.fact).toBe("Application approved · lease not sent yet");
  });

  it("a pending application, or nothing at all, draws no card", () => {
    expect(deriveStayCard({ viewer: "resident", applications: [{ id: "app-1", homeLabel: "X", approved: false }] })).toBeNull();
    expect(deriveStayCard({ viewer: "manager" })).toBeNull();
  });
});

describe("a lease row becomes a stay-card lease", () => {
  const row = { id: "l1", unit: "4709A 8th Ave", signedRentLabel: "$1,150/mo", application: { leaseStart: "2026-11-01", leaseEnd: "2027-04-30" } };

  it("maps the phase from the row's own timestamps and drops a voided lease", () => {
    expect(stayCardLeaseFromRow(row, "Room 3")?.phase).toBe("draft");
    expect(stayCardLeaseFromRow({ ...row, sentToResidentAt: "2026-10-01T00:00:00Z" }, "Room 3")?.phase).toBe("sent");
    expect(stayCardLeaseFromRow({ ...row, sentToResidentAt: "x", fullySignedAt: "2026-10-20T00:00:00Z" }, "Room 3")?.phase).toBe("signed");
    expect(stayCardLeaseFromRow({ ...row, voidedAt: "2026-10-21T00:00:00Z" }, "Room 3")).toBeNull();
  });
});
