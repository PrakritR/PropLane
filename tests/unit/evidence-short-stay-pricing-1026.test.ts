// @vitest-environment jsdom
//
// EVIDENCE HARNESS — codex-1's half of the Prakrit integration: a short stay may not be approved, nor its
// lease sent, until the property's rates can actually price every night of it. This writes the exact copy the
// manager reads on the Approve button and the Send lease gate, for each shape of stay.
//
//   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-short-stay-pricing-1026.test.ts
//
// Without EVIDENCE_DIR it is an ordinary assertion suite.
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { shortStayPricingBlocker } from "@/lib/short-stay-pricing-gate";
import { shortStayApprovalBlocker } from "@/lib/short-stay-pricing-gate.server";
import { leaseSendGateBlockerAmong, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { DemoApplicantRow } from "@/data/demo-portal";

const transcript: string[] = [];
function scene(title: string) {
  transcript.push("", title, "-".repeat(title.length));
}
function line(label: string, value: string) {
  transcript.push(`  ${label.padEnd(34)}${value}`);
}
function verdict(blocker: string | null) {
  return blocker ? `BLOCKED — "${blocker}"` : "allowed";
}

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "short-stay-pricing-transcript.txt"), `${transcript.join("\n")}\n`);
});

/** A house whose only room is let by the week ($350), with an optional nightly headline rate. */
function listing(nightly = "") {
  const base = createDefaultListingSubmission();
  return normalizeManagerListingSubmissionV1({
    ...base,
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "",
    rooms: [{ ...base.rooms[0]!, id: "room", shortTermRent: nightly, dailyRentPrice: undefined, weeklyRentPrice: 350 }],
  });
}
function stay(checkIn: string, checkOut: string): DemoApplicantRow {
  return {
    id: "AXIS-STAY",
    managerUserId: "owner",
    propertyId: "house",
    bucket: "approved",
    stage: "Approved",
    name: "Ava Lee",
    email: "ava@example.com",
    application: { rentalType: "short_term", roomChoice1: "house::room", leaseStart: checkIn, leaseEnd: checkOut },
  } as DemoApplicantRow;
}
function lease(row: DemoApplicantRow, extra: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease",
    axisId: "AXIS-STAY",
    propertyId: "house",
    residentName: "Ava Lee",
    residentEmail: "ava@example.com",
    unit: "House",
    bucket: "manager",
    stageLabel: "Manager Review",
    status: "Manager Review",
    updated: "",
    updatedAtIso: "2026-10-25",
    notes: "",
    pdfVersion: 1,
    thread: [],
    generatedHtml: "<p>Stay agreement</p>",
    application: row.application,
    ...extra,
  } as LeasePipelineRow;
}

describe("a short stay may not be approved or sent until every night of it can be priced", () => {
  it("blocks the eight-night weekly-only stay on BOTH the approve and the send gate", () => {
    const weeklyOnly = listing();
    const eightNights = stay("2027-10-01", "2027-10-09");

    scene("SCENE 1 — eight nights, and the room has only a $350 weekly rate");
    line("Ava Lee · Oct 1 → Oct 9", "8 nights · room rates: weekly $350, nightly —");
    const approve = shortStayPricingBlocker(eightNights, weeklyOnly);
    const send = leaseSendGateBlockerAmong(lease(eightNights), [eightNights], weeklyOnly);
    line("manager taps Approve", verdict(approve));
    line("manager taps Send lease", verdict(send));
    transcript.push("  (a weekly-only rate cannot price the 8th night, so neither gate lets it through)");

    expect(approve).toBe(send);
    expect(approve).toMatch(/nightly rate that covers the full stay/);
  });

  it("lets the same stay through at whole weeks, or once a nightly rate exists", () => {
    const weeklyOnly = listing();
    const sevenNights = stay("2027-10-01", "2027-10-08");
    const eightNights = stay("2027-10-01", "2027-10-09");

    scene("SCENE 2 — the two ways the manager clears it");
    const shortened = leaseSendGateBlockerAmong(lease(sevenNights), [sevenNights], weeklyOnly);
    line("shorten to 7 nights (one week)", verdict(shortened));
    const priced = leaseSendGateBlockerAmong(lease(eightNights), [eightNights], listing("55"));
    line("or set a $55 nightly rate", verdict(priced));

    expect(shortened).toBeNull();
    expect(priced).toBeNull();
  });

  it("names the dates when check-out is not after check-in", () => {
    scene("SCENE 3 — the dates themselves are wrong (never silently clamped to one night)");
    const sameDay = shortStayPricingBlocker(stay("2027-10-01", "2027-10-01"), listing("55"));
    const backwards = shortStayPricingBlocker(stay("2027-10-01", "2027-09-30"), listing("55"));
    line("check-out same day as check-in", verdict(sameDay));
    line("check-out before check-in", verdict(backwards));

    expect(sameDay).toMatch(/valid check-in and check-out dates/);
    expect(backwards).toMatch(/valid check-in and check-out dates/);
  });

  it("fails closed when the property's rates cannot be read, and never re-gates a signed lease", async () => {
    scene("SCENE 4 — fail closed, and leave signed history alone");
    const eq = vi.fn().mockReturnThis();
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq,
        maybeSingle: async () => ({ data: null, error: { message: "offline" } }),
      }),
    };
    const unreadable = await shortStayApprovalBlocker(db as unknown as SupabaseClient, stay("2027-10-01", "2027-10-09"), null);
    line("the rates read fails", verdict(unreadable));

    const signedLease = lease(stay("2027-10-01", "2027-10-09"), {
      residentSignature: { signedAtIso: "2026-10-20", name: "Ava Lee" },
    } as Partial<LeasePipelineRow>);
    const signed = leaseSendGateBlockerAmong(signedLease, [stay("2027-10-01", "2027-10-09")], null);
    line("a lease Ava already signed", verdict(signed));
    transcript.push("  (an unreadable rate is refused, not waved through; a signed stay is history and is not re-priced)");

    expect(unreadable).toMatch(/Could not verify/);
    expect(signed).toBeNull();
  });
});
