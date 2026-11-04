import { describe, expect, it } from "vitest";

import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  isOpenApplicationRow,
  mergeDraftIntoExisting,
  selectOpenApplicationMatch,
  type OpenApplicationCandidate,
} from "@/lib/rental-application/application-draft-dedupe";
import {
  collapseDuplicateResidentDrafts,
  draftStepProgress,
} from "@/lib/rental-application/resident-application-list";
import { isInProgressApplicationRow } from "@/lib/rental-application/in-progress-application";
import { isUnsubmittedDraftApplicationRow } from "@/lib/rental-application/draft-shape";
import { wizardSubmitBlockersFromFieldErrors } from "@/lib/rental-application/submit-blockers";

function row(id: string, over: Partial<DemoApplicantRow> = {}, app: Record<string, unknown> = {}): DemoApplicantRow {
  return {
    id,
    name: "Kumar",
    property: "4709A",
    propertyId: "prop-1",
    stage: "In progress",
    bucket: "pending",
    detail: "Started Oct 29",
    email: "kumar@example.com",
    application: { propertyId: "prop-1", ...app } as DemoApplicantRow["application"],
    ...over,
  } as DemoApplicantRow;
}
const cand = (r: DemoApplicantRow, updatedAt = "2026-11-01T00:00:00Z"): OpenApplicationCandidate => ({
  id: r.id,
  row: r,
  residentEmail: r.email,
  updatedAt,
});

describe("selectOpenApplicationMatch", () => {
  it("signed-in: matches only a row bound to the same Auth subject, never by email alone", () => {
    const mine = cand(row("A", { residentUserId: "u1" }));
    const other = cand(row("B", { residentUserId: "u2" }));
    const guest = cand(row("C"));
    expect(selectOpenApplicationMatch([other, guest], { subject: "u1", email: "kumar@example.com", propertyId: "prop-1" })).toBeNull();
    expect(selectOpenApplicationMatch([other, guest, mine], { subject: "u1", email: "kumar@example.com", propertyId: "prop-1" })?.id).toBe("A");
  });

  it("guest: matches only a guest row with the same email, never a row bound to an account", () => {
    const bound = cand(row("A", { residentUserId: "u1" }));
    const guestRow = cand(row("B", { email: "Kumar@Example.com" }));
    const stranger = cand(row("C", { email: "other@example.com" }));
    expect(selectOpenApplicationMatch([bound, stranger], { subject: null, email: "kumar@example.com", propertyId: "prop-1" })).toBeNull();
    expect(selectOpenApplicationMatch([bound, stranger, guestRow], { subject: null, email: "kumar@example.com", propertyId: "prop-1" })?.id).toBe("B");
  });

  it("ignores another house, itself, approved, declined, withdrawn, merged and hand-added rows", () => {
    const rows = [
      cand(row("H", { propertyId: "prop-2", application: { propertyId: "prop-2" } as never }, {})),
      cand(row("SELF")),
      cand(row("OK", { bucket: "approved", stage: "Approved" })),
      cand(row("NO", { bucket: "rejected", stage: "Declined" })),
      cand(row("W", { withdrawnAt: "2026-11-01T00:00:00Z" })),
      cand(row("M", { mergedInto: "X" })),
      cand(row("MAN", { manuallyAdded: true })),
    ].map((c) => ({ ...c, row: { ...c.row, residentUserId: "u1" } }));
    expect(selectOpenApplicationMatch(rows, { subject: "u1", email: "kumar@example.com", propertyId: "prop-1", excludeId: "SELF" })).toBeNull();
  });

  it("prefers a sent application, then the newest draft", () => {
    const sent = cand(row("S", { stage: "Submitted", residentUserId: "u1" }), "2026-10-01T00:00:00Z");
    const d1 = cand(row("D1", { residentUserId: "u1" }), "2026-10-02T00:00:00Z");
    const d2 = cand(row("D2", { residentUserId: "u1" }), "2026-11-02T00:00:00Z");
    const input = { subject: "u1", email: "kumar@example.com", propertyId: "prop-1" };
    expect(selectOpenApplicationMatch([d1, d2], input)?.id).toBe("D2");
    expect(selectOpenApplicationMatch([d1, d2, sent], input)?.id).toBe("S");
  });

  it("among drafts the furthest along wins, then the newest", () => {
    const far = cand(row("FAR", { residentUserId: "u1" }, { wizardMaxStepReached: 5 }), "2026-10-01T00:00:00Z");
    const fresh = cand(row("FRESH", { residentUserId: "u1" }, { wizardMaxStepReached: 1 }), "2026-11-03T00:00:00Z");
    expect(selectOpenApplicationMatch([fresh, far], { subject: "u1", email: "kumar@example.com", propertyId: "prop-1" })?.id).toBe("FAR");
  });

  it("a sent application never takes a draft for a different named room", () => {
    const sent = cand(row("S", { stage: "Submitted", residentUserId: "u1" }, { roomChoice1: "p::r1" }));
    const input = { subject: "u1", email: "kumar@example.com", propertyId: "prop-1" };
    expect(selectOpenApplicationMatch([sent], { ...input, incomingRoom: "p::r2" })).toBeNull();
    expect(selectOpenApplicationMatch([sent], { ...input, incomingRoom: "p::r1" })?.id).toBe("S");
    expect(selectOpenApplicationMatch([sent], { ...input, incomingRoom: "" })?.id).toBe("S");
  });

  it("a draft takes a draft whatever the room (a room switch keeps the application)", () => {
    const draft = cand(row("D", { residentUserId: "u1" }, { roomChoice1: "p::r1" }));
    expect(
      selectOpenApplicationMatch([draft], { subject: "u1", email: "kumar@example.com", propertyId: "prop-1", incomingRoom: "p::r2" })?.id,
    ).toBe("D");
  });
});

describe("mergeDraftIntoExisting", () => {
  it("keeps the kept id and start stamp, takes non-blank incoming answers, keeps what incoming leaves blank", () => {
    const kept = row("KEPT", {}, { fullLegalName: "Kumar C", employer: "Acme", monthlyIncome: "5000", wizardStep: 4, wizardMaxStepReached: 4 });
    const incoming = row("NEW", { detail: "Started Nov 2" }, { fullLegalName: "", employer: "Globex", roomChoice1: "p::r2", wizardStep: 1, wizardMaxStepReached: 1 });
    const merged = mergeDraftIntoExisting(kept, incoming);
    expect(merged.id).toBe("KEPT");
    expect(merged.detail).toBe("Started Oct 29");
    const app = merged.application as Record<string, unknown>;
    expect(app.fullLegalName).toBe("Kumar C");
    expect(app.employer).toBe("Globex");
    expect(app.monthlyIncome).toBe("5000");
    expect(app.roomChoice1).toBe("p::r2");
    expect(app.wizardStep).toBe(4);
    expect(app.wizardMaxStepReached).toBe(4);
  });
});

describe("isOpenApplicationRow", () => {
  it("a draft and a sent pending application are open", () => {
    expect(isOpenApplicationRow(row("A"))).toBe(true);
    expect(isOpenApplicationRow(row("B", { stage: "Submitted" }))).toBe(true);
    expect(isOpenApplicationRow(row("C", { bucket: "approved" }))).toBe(false);
  });
});

describe("isUnsubmittedDraftApplicationRow (the server's approval refusal)", () => {
  it("refuses a pending draft, never a sent, approved or hand-added row", () => {
    expect(isUnsubmittedDraftApplicationRow(row("A"))).toBe(true);
    expect(isUnsubmittedDraftApplicationRow(row("A", { stage: "Incomplete" }))).toBe(true);
    expect(isUnsubmittedDraftApplicationRow(row("B", { stage: "Submitted" }))).toBe(false);
    expect(isUnsubmittedDraftApplicationRow(row("C", { bucket: "approved", stage: "Approved" }))).toBe(false);
    expect(isUnsubmittedDraftApplicationRow(row("D", { manuallyAdded: true }))).toBe(false);
    expect(isUnsubmittedDraftApplicationRow(row("E", { stage: undefined as never }))).toBe(false);
    expect(isUnsubmittedDraftApplicationRow(null)).toBe(false);
  });
});

describe("resident list: one row per house", () => {
  it("collapses duplicate unsent drafts to the furthest along and shows progress", () => {
    const rows = [
      row("A", {}, { wizardMaxStepReached: 2 }),
      row("B", {}, { wizardMaxStepReached: 4 }),
      row("C", { propertyId: "prop-2", application: { propertyId: "prop-2" } as never }),
    ];
    const out = collapseDuplicateResidentDrafts(rows, isInProgressApplicationRow, 7);
    expect(out.map((r) => r.id).sort()).toEqual(["B", "C"]);
    expect(draftStepProgress(out.find((r) => r.id === "B")!, 7)).toEqual({ done: 3, total: 7 });
    expect(draftStepProgress(row("Z"), 7)).toEqual({ done: 0, total: 7 });
  });

  it("drops a draft a sent application for the same house already covers, keeps another room's", () => {
    const sent = row("S", { stage: "Submitted" }, { roomChoice1: "p::r1" });
    const same = row("D1", {}, { roomChoice1: "p::r1" });
    const blank = row("D2", {}, {});
    const other = row("D3", {}, { roomChoice1: "p::r2" });
    const out = collapseDuplicateResidentDrafts([sent, same, blank, other], isInProgressApplicationRow, 7);
    expect(out.map((r) => r.id).sort()).toEqual(["D3", "S"]);
  });
});

describe("wizardSubmitBlockersFromFieldErrors", () => {
  it("names the step and links each refused field to the step that owns it", () => {
    const blockers = wizardSubmitBlockersFromFieldErrors({ monthlyIncome: "Monthly income is required.", digitalSignature: "Sign to submit." });
    expect(blockers).toEqual([
      { message: "Work and income: Monthly income is required.", step: 4 },
      { message: "Review, sign and pay: Sign to submit.", step: 7 },
    ]);
  });
});
