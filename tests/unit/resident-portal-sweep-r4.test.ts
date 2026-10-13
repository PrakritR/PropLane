// @vitest-environment jsdom
/** Round 4 (resident portal) of the portal sweep: R1, R2, R4, R5, R6, R10, R13, R15. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkHouseholdChargesToResidentUser,
  readHouseholdCharges,
  resetHouseholdViewerRoleForTests,
  seedDemoHouseholdCharges,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { formatLeaseDateLabel, formatLeaseRentLabel } from "@/lib/resident-lease-display";
import { portalBottomBarShowsSection, portalNavLockKind } from "@/lib/portals/nav-locks";
import { residentSectionLockedForManagerTier } from "@/lib/manager-access";
import { smsBubbleSenderLabel } from "@/lib/manager-sms-messages";
import { formatInboxStamp } from "@/lib/portal-inbox-storage";
import { residentApplicationRowPlaceLine, residentApplicationRowTitle } from "@/lib/resident-application-row-label";
import { firstNonEmptyTabToOpen } from "@/lib/portal-default-tab";
import { PORTAL_NAV_GROUPS } from "@/lib/portals/nav-groups";
import { RESIDENT_UNIFIED_PORTAL_SECTIONS } from "@/lib/portals/resident-sections";
import { residentPaymentsLandingBucket, residentPaymentsNavBadge } from "@/lib/resident-payments-tabs";
import { residentDueRowCount } from "@/lib/resident-payments-due-count";
import { compactLifecycleLabel } from "@/lib/resident-lifecycle-journey";
import { placeLineWithoutRawIds } from "@/lib/room-display-label";
import { inboxDisplayName } from "@/lib/inbox-display-name";
import { dropDuplicateTurns } from "@/lib/inbox-message-timeline";
import type { InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { resolveResidentLeaseDocumentView } from "@/lib/resident-lease-documents";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));

function charge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "c1",
    createdAt: "2026-01-01T00:00:00Z",
    residentEmail: "resident@example.test",
    residentName: "Resident",
    residentUserId: null,
    propertyId: "property",
    propertyLabel: "House",
    managerUserId: "manager",
    kind: "rent",
    title: "Rent",
    amountLabel: "$100.00",
    balanceLabel: "$100.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    ...overrides,
  };
}

describe("R1 a resident never writes the charge ledger", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetHouseholdViewerRoleForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("stamping the resident's user id changes the local copy and sends nothing", async () => {
    seedDemoHouseholdCharges([charge()]);
    linkHouseholdChargesToResidentUser("resident@example.test", "user-1");
    await Promise.resolve();
    expect(readHouseholdCharges()[0]?.residentUserId).toBe("user-1");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("R2 lease dates and rent read as a person writes them", () => {
  it("formats day and timestamp dates, leaves labels alone", () => {
    expect(formatLeaseDateLabel("2026-10-20")).toBe("Oct 20, 2026");
    expect(formatLeaseDateLabel("2026-10-09T03:25:21.278Z")).toBe("Oct 8, 2026");
    expect(formatLeaseDateLabel("")).toBeUndefined();
    expect(formatLeaseDateLabel("Month-to-month")).toBe("Month-to-month");
  });
  it("shows whole dollars per month", () => {
    expect(formatLeaseRentLabel("$1800.00 / month")).toBe("$1,800 / mo");
    expect(formatLeaseRentLabel("$1,050.50/mo")).toBe("$1,050.50 / mo");
    expect(formatLeaseRentLabel(null)).toBeUndefined();
  });
  it("the document subtitle is 'Signed <date>', not a raw timestamp", () => {
    const row = {
      id: "lease-1",
      unit: "Studio",
      status: "Fully Signed",
      updatedAtIso: "2026-10-09T03:25:21.278Z",
      fullySignedAt: "2026-10-09T03:25:21.278Z",
      managerSignature: { role: "manager", name: "M", signedAtIso: "2026-10-01T00:00:00.000Z" },
      residentSignature: { role: "resident", name: "R", signedAtIso: "2026-10-02T00:00:00.000Z" },
    } as unknown as LeasePipelineRow;
    const view = resolveResidentLeaseDocumentView(row, "lease-1");
    expect(view?.subtitle).toMatch(/^Signed [A-Z][a-z]{2} \d{1,2}, 2026$/);
    expect(view?.subtitle).not.toContain("T");
  });
});

describe("R3 compact tracker labels", () => {
  it("prints short labels except the current step", () => {
    expect(compactLifecycleLabel({ id: "received", label: "Application received", state: "done" })).toBe("Applied");
    expect(compactLifecycleLabel({ id: "pay_move_in", label: "Pay move-in", state: "current" })).toBe("Pay move-in");
    expect(compactLifecycleLabel({ id: "review", label: "Under review", state: "upcoming" })).toBe("Review");
  });
});

describe("R4 a section the manager's plan locks takes no tile and no bottom-bar slot", () => {
  const base = { kind: "resident" as const, residentNavStage: "post_lease" as const };
  it("the dashboard rule: services is plan-locked on the free tier only", () => {
    expect(residentSectionLockedForManagerTier("services", "free")).toBe(true);
    expect(residentSectionLockedForManagerTier("services", "paid")).toBe(false);
  });
  it("a plan-locked resident row leaves the bar but stays a notice link", () => {
    const params = { ...base, section: "services", subscriptionTier: "free" as const };
    expect(portalNavLockKind(params)).toBe("notice");
    expect(portalBottomBarShowsSection(params)).toBe(false);
    expect(portalBottomBarShowsSection({ ...params, section: "payments" })).toBe(true);
  });
  it("a stage-locked resident row keeps its slot and its inert lock", () => {
    const params = { kind: "resident" as const, section: "payments", subscriptionTier: "paid" as const, residentNavStage: "pre_approval" as const };
    expect(portalNavLockKind(params)).toBe("inert");
    expect(portalBottomBarShowsSection(params)).toBe(true);
  });
});

describe("R5 text thread labels and stamps", () => {
  it("names the sender instead of the direction word", () => {
    expect(smsBubbleSenderLabel({ direction: "outbound", sentBy: null })).toBe("You");
    expect(smsBubbleSenderLabel({ direction: "inbound", sentBy: null })).toBe("Property manager");
    expect(smsBubbleSenderLabel({ direction: "inbound", sentBy: null }, "Dana Lee")).toBe("Dana Lee");
    expect(smsBubbleSenderLabel({ direction: "outbound", sentBy: { userId: "u", name: "Sam" } })).toBe("Sam");
  });
  it("the list stamp carries the date of the message", () => {
    expect(formatInboxStamp(new Date("2026-09-13T18:31:00Z"))).toMatch(/^Sep 13, /);
  });
});

describe("R6 application rows name the property", () => {
  it("never a raw id or a bare number", () => {
    expect(residentApplicationRowTitle({ property: "PROPLANE-FCD65B78" })).toBe("Application");
    expect(residentApplicationRowTitle({ property: "2" }, "Fir Lofts")).toBe("Fir Lofts");
    expect(residentApplicationRowTitle({ property: "Alder Row — 3 rooms" })).toBe("Alder Row");
    expect(residentApplicationRowTitle({ property: "mgr-qa-c3-house-0001" })).toBe("Application");
  });
  it("the place line is room and term, with no application id", () => {
    expect(residentApplicationRowPlaceLine("2", "Long-term")).toBe("Room 2 · Long-term");
    expect(residentApplicationRowPlaceLine("—", "Long-term")).toBe("Long-term");
  });
});

describe("R10 Lease and Forms open on the first tab with rows", () => {
  const tabs = [{ id: "pending", count: 0 }, { id: "signed", count: 1 }] as const;
  it("moves off an empty default when the address names no tab", () => {
    expect(firstNonEmptyTabToOpen(tabs, "pending", false)).toBe("signed");
  });
  it("never overrides a tab the address names, or a tab that has rows", () => {
    expect(firstNonEmptyTabToOpen(tabs, "pending", true)).toBeNull();
    expect(firstNonEmptyTabToOpen([{ id: "pending", count: 2 }, { id: "signed", count: 1 }], "pending", false)).toBeNull();
  });
});

describe("R13 no group heading repeats its first row", () => {
  it("every resident group heading differs from the label of its first row", () => {
    for (const group of PORTAL_NAV_GROUPS.resident) {
      const first = RESIDENT_UNIFIED_PORTAL_SECTIONS.find((section) => section.section === group.sections[0]);
      if (!group.label || !first) continue;
      expect(group.label.toLowerCase()).not.toBe(first.label.toLowerCase());
    }
    // The case the audit caught: "My home" over the "My home" row.
    const myHome = PORTAL_NAV_GROUPS.resident.find((group) => group.id === "my-home");
    expect(myHome?.label).toBeNull();
  });
});

describe("R14 place lines carry names only", () => {
  it("drops a raw record id", () => {
    expect(placeLineWithoutRawIds("5257 Brooklyn Avenue Northeast", "mgr-qa-c3-house-0001")).toBe("5257 Brooklyn Avenue Northeast");
    expect(placeLineWithoutRawIds("Fir Lofts", "Room 3")).toBe("Fir Lofts · Room 3");
  });
});

describe("R15 Payments badge and landing tab", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  const late = (id: string, kind: HouseholdCharge["kind"]) => charge({ id, kind, title: id, dueDateLabel: "Oct 1, 2026" });
  it("the badge is the Due count and lands on Due when it has rows", () => {
    expect(residentPaymentsNavBadge(2)).toEqual({ count: 2, tone: "alert" });
    expect(residentPaymentsNavBadge(0)).toEqual({ count: 0, tone: "muted" });
    expect(residentPaymentsLandingBucket({ due: 2, upcoming: 1 })).toBe("overdue");
    expect(residentPaymentsLandingBucket({ due: 0, upcoming: 1 })).toBe("pending");
    expect(residentPaymentsLandingBucket({ due: 0, upcoming: 0 })).toBeNull();
  });
  it("counts due rows as the tab does: a move-in is one row, paid and clearing never count, failed does", () => {
    const charges = [
      late("deposit", "security_deposit"),
      late("move-in fee", "move_in_fee"),
      late("rent due", "rent"),
      charge({ id: "p", kind: "rent", status: "paid" }),
      charge({ id: "x", kind: "rent", status: "processing", dueDateLabel: "Oct 1, 2026" }),
      charge({ id: "f", kind: "rent", status: "failed", dueDateLabel: "Oct 15, 2026" }),
      charge({ id: "u", kind: "rent", dueDateLabel: "Oct 15, 2026" }),
    ];
    expect(residentDueRowCount(charges, now)).toBe(3);
  });
});

describe("V2 vendor Communication thread", () => {
  const turn = (id: string, body: string, at: string, extra: Partial<InboxBubbleMessage> = {}) =>
    ({ id, direction: "inbound", author: "Test Manager", body, at, ...extra }) as InboxBubbleMessage;
  it("a paragraph stored twice in a row shows once", () => {
    const text = "WO-1177: The resident reports Dryer vent at 5257 Brooklyn Ave NE is not resolved.";
    const kept = dropDuplicateTurns([
      turn("a", text, "Sep 15, 9:45 PM", { subject: "WO-1176 · Leaking faucet" }),
      turn("b", text, "Sep 15, 9:50 PM"),
      turn("c", "WO-1176: The offer for Leaking faucet expired.", "Sep 15, 9:51 PM"),
    ]);
    expect(kept.map((message) => message.id)).toEqual(["a", "c"]);
  });
  it("short repeated replies and different senders stay", () => {
    expect(dropDuplicateTurns([turn("a", "OK", "x"), turn("b", "OK", "y")])).toHaveLength(2);
    const body = "The same long sentence sent by two different people.";
    expect(dropDuplicateTurns([turn("a", body, "x"), turn("b", body, "y", { author: "Someone Else" })])).toHaveLength(2);
  });
  it("an email-only sender reads as a name", () => {
    expect(inboxDisplayName("manager@test.proplane.local")).toBe("Manager");
    expect(inboxDisplayName("jane.doe@x.co")).toBe("Jane Doe");
    expect(inboxDisplayName("Test Manager")).toBe("Test Manager");
  });
});
