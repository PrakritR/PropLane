// PRP-463: a fee's lease-type and room scope, and payment-at-signing per lease type.
//
// The invariant under every test here is one sentence: absent means EVERY item. That is
// what a fee saved before scope existed meant, so nothing already saved changes — and it
// is also what "All rooms" has to persist as, or adding a room next month would silently
// drop the fee from it.
import { describe, expect, it } from "vitest";
import {
  derivePaymentAtSigningIncludesFromMatrix,
  expandFeeScope,
  feeAppliesToLeaseType,
  feeAppliesToRoom,
  isPaymentDueAtSigning,
  narrowFeeScope,
  paymentAtSigningMatrix,
  paymentAtSigningRows,
  setPaymentAtSigningCell,
  standardFeeScopeFor,
  withStandardFeeScope,
} from "@/lib/listing-fee-scope";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { leaseDocumentFeeLines } from "@/lib/listing-fees";
import { resolveStayPricing } from "@/lib/room-pricing";

const ROOMS = ["room-a", "room-b", "room-c"];
const TERMS = ["Long-term", "Month-to-Month", "Custom"];

function subWithRooms(): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = [...TERMS];
  sub.rooms = ROOMS.map((id, i) => ({
    ...sub.rooms[0]!,
    id,
    name: `Room ${i + 1}`,
  }));
  return sub;
}

describe("fee scope — absent means all", () => {
  it("an unscoped fee applies to every lease type and every room", () => {
    expect(feeAppliesToLeaseType({}, "Month-to-Month")).toBe(true);
    expect(feeAppliesToLeaseType({ leaseTypes: [] }, "Month-to-Month")).toBe(true);
    expect(feeAppliesToRoom({}, "room-c")).toBe(true);
    expect(feeAppliesToRoom({ roomIds: [] }, "room-c")).toBe(true);
  });

  it("a narrowed fee applies only where it is named", () => {
    expect(feeAppliesToLeaseType({ leaseTypes: ["Long-term"] }, "Long-term")).toBe(true);
    expect(feeAppliesToLeaseType({ leaseTypes: ["Long-term"] }, "Month-to-Month")).toBe(false);
    expect(feeAppliesToRoom({ roomIds: ["room-a"] }, "room-a")).toBe(true);
    expect(feeAppliesToRoom({ roomIds: ["room-a"] }, "room-b")).toBe(false);
  });

  it("picking everything stores nothing, so it cannot freeze to today's list", () => {
    expect(narrowFeeScope(ROOMS, ROOMS)).toBeUndefined();
    expect(narrowFeeScope([], ROOMS)).toBeUndefined();
    expect(narrowFeeScope(["room-c", "room-a"], ROOMS)).toEqual(["room-a", "room-c"]);
  });

  it("all-rooms keeps applying to a room added later — the whole point of storing absence", () => {
    const stored = narrowFeeScope(ROOMS, ROOMS);
    expect(feeAppliesToRoom({ roomIds: stored }, "room-d-added-next-month")).toBe(true);

    // Whereas a fee genuinely narrowed to two rooms stays narrowed.
    const narrowed = narrowFeeScope(["room-a", "room-b"], ROOMS);
    expect(feeAppliesToRoom({ roomIds: narrowed }, "room-d-added-next-month")).toBe(false);
  });

  it("expands absence back to every option for the dropdown's face", () => {
    expect(expandFeeScope(undefined, ROOMS)).toEqual(ROOMS);
    expect(expandFeeScope(["room-b"], ROOMS)).toEqual(["room-b"]);
    // An id that no longer names a room is dropped, never shown as a phantom pick.
    expect(expandFeeScope(["room-b", "deleted"], ROOMS)).toEqual(["room-b"]);
  });
});

describe("standard fee row scope", () => {
  it("stores a narrowing and drops the entry when it stops narrowing anything", () => {
    let scopes = withStandardFeeScope(undefined, "applicationFee", { leaseTypes: ["Long-term"] });
    expect(scopes).toEqual({ applicationFee: { leaseTypes: ["Long-term"] } });

    scopes = withStandardFeeScope(scopes, "applicationFee", { leaseTypes: undefined });
    expect(scopes).toBeUndefined();
  });

  it("survives normalization, pruned to lease types and rooms that still exist", () => {
    const sub = subWithRooms();
    sub.standardFeeScopes = {
      applicationFee: { leaseTypes: ["Long-term"], roomIds: ["room-a", "gone"] },
      securityDeposit: { leaseTypes: ["No-Such-Term"] },
    };
    const n = normalizeManagerListingSubmissionV1(sub);
    expect(standardFeeScopeFor(n, "applicationFee")).toEqual({
      leaseTypes: ["Long-term"],
      roomIds: ["room-a"],
    });
    // A scope naming nothing real narrows nothing, so it is stored as absent = all.
    expect(standardFeeScopeFor(n, "securityDeposit")).toEqual({});
  });

  it("keeps an application fee off a lease type it is not scoped to", () => {
    const sub = subWithRooms();
    sub.applicationFee = "50";
    sub.standardFeeScopes = { applicationFee: { leaseTypes: ["Long-term"] } };
    const n = normalizeManagerListingSubmissionV1(sub);

    const onLongTerm = leaseDocumentFeeLines(n, "long-term", { leaseTerm: "Long-term" });
    expect(onLongTerm.oneTime.some((l) => l.label === "Application fee")).toBe(true);

    const onMonthToMonth = leaseDocumentFeeLines(n, "long-term", { leaseTerm: "Month-to-Month" });
    expect(onMonthToMonth.oneTime.some((l) => l.label === "Application fee")).toBe(false);
  });

  it("leaves the context-free listing preview showing every fee, as it always did", () => {
    const sub = subWithRooms();
    sub.applicationFee = "50";
    sub.standardFeeScopes = { applicationFee: { leaseTypes: ["Long-term"] } };
    const n = normalizeManagerListingSubmissionV1(sub);

    // No billing context = no lease to be out of scope OF.
    const preview = leaseDocumentFeeLines(n, "long-term");
    expect(preview.oneTime.some((l) => l.label === "Application fee")).toBe(true);
  });
});

describe("custom fee scope survives a save", () => {
  it("keeps leaseTypes and roomIds through normalization", () => {
    const sub = subWithRooms();
    sub.customFees = [
      {
        id: "fee-parking",
        label: "Parking fee",
        amount: "75",
        frequency: "monthly",
        leaseTypes: ["Long-term"],
        roomIds: ["room-a", "room-c"],
      },
    ];
    const n = normalizeManagerListingSubmissionV1(sub);
    const fee = n.customFees?.find((f) => f.id === "fee-parking");
    expect(fee?.leaseTypes).toEqual(["Long-term"]);
    expect(fee?.roomIds).toEqual(["room-a", "room-c"]);
  });

  it("gates the fee out of a lease of another type", () => {
    const sub = subWithRooms();
    sub.customFees = [
      {
        id: "fee-parking",
        label: "Parking fee",
        amount: "75",
        frequency: "monthly",
        leaseTypes: ["Long-term"],
      },
    ];
    const n = normalizeManagerListingSubmissionV1(sub);
    const longTerm = leaseDocumentFeeLines(n, "long-term", { leaseTerm: "Long-term" });
    const mtm = leaseDocumentFeeLines(n, "long-term", { leaseTerm: "Month-to-Month" });
    const named = (lines: { label: string }[]) => lines.some((l) => l.label === "Parking fee");
    expect(named([...longTerm.monthly, ...longTerm.foldedIntoRent])).toBe(true);
    expect(named([...mtm.monthly, ...mtm.foldedIntoRent])).toBe(false);
  });
});

describe("payment at signing, per lease type", () => {
  it("a listing with no matrix collects the same payments on every lease type", () => {
    const sub = subWithRooms();
    sub.paymentAtSigningIncludes = ["security_deposit", "move_in_fee"];
    sub.paymentAtSigningByLeaseType = undefined;
    const matrix = paymentAtSigningMatrix(sub);
    for (const term of TERMS) {
      expect(matrix[term]).toEqual(["security_deposit", "move_in_fee"]);
    }
  });

  it("one cell is independent of the others", () => {
    const sub = subWithRooms();
    sub.paymentAtSigningIncludes = ["security_deposit"];
    let matrix = paymentAtSigningMatrix(sub);
    matrix = setPaymentAtSigningCell(matrix, "Month-to-Month", "security_deposit", false);
    expect(matrix["Long-term"]).toContain("security_deposit");
    expect(matrix["Month-to-Month"]).not.toContain("security_deposit");
  });

  it("the flat list stays the union of the standard ids, so old readers are untouched", () => {
    const matrix = {
      "Long-term": ["security_deposit", "fee:fee-parking", "room_rent:room-a"],
      "Month-to-Month": ["move_in_fee"],
    };
    // Fee and room keys live only in the matrix — never handed to a reader typed for the
    // four standard ids.
    expect(derivePaymentAtSigningIncludesFromMatrix(matrix)).toEqual([
      "security_deposit",
      "move_in_fee",
    ]);
  });

  it("serializes per lease type and prunes rows that no longer exist", () => {
    const sub = subWithRooms();
    sub.customFees = [{ id: "fee-parking", label: "Parking fee", amount: "75", frequency: "monthly" }];
    sub.paymentAtSigningByLeaseType = {
      "Long-term": ["security_deposit", "fee:fee-parking", "room_rent:room-a"],
      "Month-to-Month": ["fee:fee-deleted", "room_rent:room-deleted"],
      "No-Such-Term": ["security_deposit"],
    };
    const n = normalizeManagerListingSubmissionV1(sub);
    expect(n.paymentAtSigningByLeaseType?.["Long-term"]).toEqual([
      "security_deposit",
      "fee:fee-parking",
      "room_rent:room-a",
    ]);
    expect(n.paymentAtSigningByLeaseType?.["Month-to-Month"]).toEqual([]);
    expect(n.paymentAtSigningByLeaseType?.["No-Such-Term"]).toBeUndefined();
    expect(n.paymentAtSigningIncludes).toEqual(["security_deposit"]);
  });

  it("answers per lease, and per listing when no lease names a term", () => {
    const sub = subWithRooms();
    sub.paymentAtSigningByLeaseType = {
      "Long-term": ["security_deposit"],
      "Month-to-Month": [],
      Custom: [],
    };
    expect(isPaymentDueAtSigning(sub, "security_deposit", "Long-term")).toBe(true);
    expect(isPaymentDueAtSigning(sub, "security_deposit", "Month-to-Month")).toBe(false);
    expect(isPaymentDueAtSigning(sub, "security_deposit", null)).toBe(true);
  });
});

describe("the signing table grows with the fee list", () => {
  it("derives a row per manager-added fee, and per room when renting by room", () => {
    const sub = subWithRooms();
    sub.customFees = [
      { id: "fee-parking", label: "Parking fee", amount: "75", frequency: "monthly" },
      // Preset-backed rows are already the four standard payments; they must not double up.
      { id: "fee-deposit", label: "Security deposit", amount: "900", frequency: "one-time", presetId: "security_deposit" },
    ];

    const rows = paymentAtSigningRows(sub, { includeRoomRent: true });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("security_deposit");
    expect(keys).toContain("fee:fee-parking");
    expect(keys).toContain("room_rent:room-a");
    expect(keys.filter((k) => k === "fee:fee-deposit")).toHaveLength(0);
    expect(rows.find((r) => r.key === "fee:fee-parking")?.label).toBe("Parking fee");

    // Whole-home listing: no room rows.
    expect(paymentAtSigningRows(sub).some((r) => r.kind === "roomRent")).toBe(false);
  });

  it("gives an unnamed fee its row immediately, so the table visibly grows", () => {
    const sub = subWithRooms();
    sub.customFees = [{ id: "fee-new", label: "  ", amount: "", frequency: "monthly" }];
    expect(paymentAtSigningRows(sub).find((r) => r.key === "fee:fee-new")?.label).toBe("Untitled fee");
  });
});

describe("a room priced per lease type", () => {
  const room = {
    id: "room-a",
    monthlyRent: 1000,
    securityDeposit: "1000",
    termPricing: { "Month-to-Month": { monthlyRent: 1200, securityDeposit: "1500" } },
  };

  // The checkbox is only honest if unticking it changes what the ledger bills — this is
  // the same resolver the lease document and the charges read.
  it("bills the term's own rent and deposit on a lease of that term", () => {
    const pricing = resolveStayPricing({
      room,
      submission: {},
      application: { leaseTerm: "Month-to-Month" },
    });
    expect(pricing.monthlyRate).toBe(1200);
    expect(pricing.deposit).toBe(1500);
  });

  it("falls back to the long-term price for a term with no entry", () => {
    const pricing = resolveStayPricing({
      room,
      submission: {},
      application: { leaseTerm: "Long-term" },
    });
    expect(pricing.monthlyRate).toBe(1000);
    expect(pricing.deposit).toBe(1000);
  });

  it("is untouched when the lease names no term at all — every existing caller", () => {
    const pricing = resolveStayPricing({ room, submission: {}, application: {} });
    expect(pricing.monthlyRate).toBe(1000);
    expect(pricing.deposit).toBe(1000);
  });

  it("still lets a manager's negotiated override win", () => {
    const pricing = resolveStayPricing({
      room,
      submission: {},
      application: { leaseTerm: "Month-to-Month", managerRentOverride: "950" },
    });
    expect(pricing.monthlyRate).toBe(950);
  });
});
