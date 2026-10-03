import { describe, expect, it } from "vitest";
import {
  filterMoveInForms,
  formatMoveInDate,
  groupMoveInAnswers,
  lateFormNeedsLine,
  lateMoveInForms,
  moveInFormDaysLate,
  moveInFormFacts,
  moveInFormPlaceLine,
  moveInFormTabCounts,
  moveInFormTitle,
} from "@/lib/move-in-forms/manager-rows";
import { describeMoveInDetails, orderResidentMoveInForms } from "@/components/portal/move-in-forms/resident-record-move-in-section";
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormSummary } from "@/lib/move-in-forms/types";

// Oct 3, 2026, midday Pacific.
const NOW = new Date("2026-10-03T19:00:00.000Z");

function form(patch: Partial<MoveInFormSummary> = {}): MoveInFormSummary {
  return {
    id: "f1",
    applicationId: "app-1",
    managerUserId: "m1",
    propertyId: "p1",
    propertyLabel: "5257 Brooklyn Ave",
    roomLabel: "Room 5",
    residentName: "Atlas Bailly",
    residentEmail: "atlas@example.com",
    formId: "starter-pet-agreement",
    formName: "Pet agreement",
    source: "built",
    status: "sent",
    signedDocumentSha256: null,
    sentAt: "2026-09-28T17:00:00.000Z",
    dueAt: "2026-10-02T06:59:59.000Z", // end of Oct 1 Pacific
    submittedAt: null,
    remindedAt: null,
    managerViewedAt: null,
    kind: "other",
    questionCount: 5,
    photoCount: 0,
    signed: false,
    ...patch,
  };
}

describe("move-in form row facts", () => {
  it("waiting: Sent and Due, with lateness as plain text on the due fact", () => {
    const facts = moveInFormFacts(form(), NOW);
    expect(facts.map((f) => f.text)).toEqual(["Sent Sep 28", "Due Oct 1 · 2 days late"]);
    expect(facts[1]?.late).toBe(true);
    expect(facts[0]?.late).toBeUndefined();
  });

  it("waiting and not late: no lateness text", () => {
    const facts = moveInFormFacts(form({ dueAt: "2026-10-15T06:59:59.000Z" }), NOW);
    expect(facts.map((f) => f.text)).toEqual(["Sent Sep 28", "Due Oct 14"]);
    expect(facts.some((f) => f.late)).toBe(false);
  });

  it("a waiting form with no due date shows only Sent", () => {
    expect(moveInFormFacts(form({ dueAt: null }), NOW).map((f) => f.text)).toEqual(["Sent Sep 28"]);
  });

  it("submitted: date, Signed and a photo count only when they exist", () => {
    const base = form({ status: "submitted", submittedAt: "2026-09-27T23:12:00.000Z" });
    expect(moveInFormFacts({ ...base, signed: true, photoCount: 4 }, NOW).map((f) => f.text)).toEqual(["Submitted Sep 27", "Signed", "4 photos"]);
    expect(moveInFormFacts({ ...base, photoCount: 1 }, NOW).map((f) => f.text)).toEqual(["Submitted Sep 27", "1 photo"]);
    expect(moveInFormFacts(base, NOW).map((f) => f.text)).toEqual(["Submitted Sep 27"]);
  });

  it("title and place line", () => {
    expect(moveInFormTitle(form())).toBe("Atlas Bailly · Pet agreement");
    expect(moveInFormPlaceLine(form())).toBe("5257 Brooklyn Ave · Room 5");
    expect(moveInFormPlaceLine(form({ roomLabel: "" }))).toBe("5257 Brooklyn Ave");
  });
});

describe("days late", () => {
  it("counts Pacific calendar days past the due day", () => {
    expect(moveInFormDaysLate(form(), NOW)).toBe(2);
    expect(moveInFormDaysLate(form(), new Date("2026-10-02T05:00:00.000Z"))).toBe(0); // Oct 1, 10pm Pacific: the due day itself
    expect(moveInFormDaysLate(form(), new Date("2026-10-02T19:00:00.000Z"))).toBe(1);
  });

  it("is zero for a submitted, cancelled or undated form", () => {
    expect(moveInFormDaysLate(form({ status: "submitted" }), NOW)).toBe(0);
    expect(moveInFormDaysLate(form({ status: "cancelled" }), NOW)).toBe(0);
    expect(moveInFormDaysLate(form({ dueAt: null }), NOW)).toBe(0);
  });

  it("singular and the Overview line", () => {
    expect(lateFormNeedsLine("Pet agreement", 1)).toBe("Pet agreement is 1 day late");
    expect(lateFormNeedsLine("Pet agreement", 2)).toBe("Pet agreement is 2 days late");
  });

  it("late forms are the waiting ones past due, most late first", () => {
    const list = [
      form({ id: "a", formName: "B form", dueAt: "2026-10-02T06:59:59.000Z" }),
      form({ id: "b", formName: "A form", dueAt: "2026-10-01T06:59:59.000Z" }),
      form({ id: "c", dueAt: "2026-10-20T06:59:59.000Z" }),
      form({ id: "d", status: "submitted" }),
    ];
    expect(lateMoveInForms(list, NOW).map((e) => [e.form.id, e.daysLate])).toEqual([["b", 3], ["a", 2]]);
  });
});

describe("list filtering", () => {
  const list = [
    form({ id: "1", status: "submitted", submittedAt: "2026-09-27T23:12:00.000Z", signed: true }),
    form({ id: "2", residentName: "Maya Chen", propertyId: "p2", propertyLabel: "4709a 8th Ave", roomLabel: "Room 2", formName: "Move-in checklist" }),
    form({ id: "3", status: "cancelled" }),
  ];

  it("a cancelled request is on neither tab", () => {
    expect(moveInFormTabCounts(list)).toEqual({ submitted: 1, waiting: 1 });
    expect(filterMoveInForms(list, {}).map((f) => f.id)).toEqual(["1", "2"]);
  });

  it("filters by tab, property, form name and every typed word", () => {
    expect(filterMoveInForms(list, { tab: "waiting" }).map((f) => f.id)).toEqual(["2"]);
    expect(filterMoveInForms(list, { propertyId: "p1" }).map((f) => f.id)).toEqual(["1"]);
    expect(filterMoveInForms(list, { formName: "move-in CHECKLIST" }).map((f) => f.id)).toEqual(["2"]);
    expect(filterMoveInForms(list, { query: "maya 8th" }, NOW).map((f) => f.id)).toEqual(["2"]);
    expect(filterMoveInForms(list, { query: "maya brooklyn" }, NOW)).toEqual([]);
  });
});

describe("dates", () => {
  it("formats on the Pacific wall clock", () => {
    expect(formatMoveInDate("2026-10-02T06:59:59.000Z")).toBe("Oct 1");
    expect(formatMoveInDate(null)).toBe("");
    expect(formatMoveInDate("nope")).toBe("");
  });
});

describe("answers grouped for the viewer", () => {
  const q = (key: string, patch: Partial<MoveInFormQuestion> = {}): MoveInFormQuestion =>
    ({ id: `q-${key}`, key, label: key, type: "text", required: false, options: [], ...patch }) as MoveInFormQuestion;
  const questions = [
    q("has_pet", { type: "yes_no", section: "Pets", label: "Bringing a pet?" }),
    q("pet_name", { section: "Pets", showIf: { fieldKey: "has_pet", equals: "yes" } }),
    q("photo", { type: "photos", section: "Pets" }),
    q("sig", { type: "signature" }),
  ];

  it("groups by section, hides an unanswered conditional question, keeps blanks otherwise", () => {
    const answers: MoveInFormAnswer[] = [{ key: "has_pet", value: "no" }];
    const groups = groupMoveInAnswers(questions, answers);
    expect(groups.map((g) => g.title)).toEqual(["Pets", "Answers"]);
    expect(groups[0]!.rows.map((r) => r.question.key)).toEqual(["has_pet", "photo"]);
    expect(groups[0]!.rows[0]!.view).toEqual({ kind: "text", text: "No" });
    expect(groups[0]!.rows[1]!.view).toEqual({ kind: "empty" });
  });

  it("shows a conditional question when its condition held; files and signatures stay paths", () => {
    const answers: MoveInFormAnswer[] = [
      { key: "has_pet", value: true },
      { key: "pet_name", value: "Biscuit" },
      { key: "photo", files: ["a.jpg", "b.jpg"] },
      { key: "sig", signature: { storagePath: "s.png", signedName: "Atlas Bailly", signedAt: "2026-09-27T23:12:00.000Z" } },
    ];
    const groups = groupMoveInAnswers(questions, answers);
    expect(groups[0]!.rows.map((r) => r.view.kind)).toEqual(["text", "text", "files"]);
    expect(groups[1]!.rows[0]!.view).toMatchObject({ kind: "signature", signedName: "Atlas Bailly", storagePath: "s.png" });
  });
});

describe("resident record helpers", () => {
  it("orders submitted first (as filed), then waiting by due date", () => {
    const ordered = orderResidentMoveInForms([
      form({ id: "w2", dueAt: "2026-10-09T06:59:59.000Z" }),
      form({ id: "s2", status: "submitted", submittedAt: "2026-09-28T20:00:00.000Z" }),
      form({ id: "w1", dueAt: "2026-10-02T06:59:59.000Z" }),
      form({ id: "s1", status: "submitted", submittedAt: "2026-09-27T20:00:00.000Z" }),
      form({ id: "x", status: "cancelled" }),
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["s1", "s2", "w1", "w2"]);
  });

  it("describes the property's move-in details as facts, with blanks saying so", () => {
    expect(describeMoveInDetails(null, false)).toEqual({ instructions: "None added", photos: "None added", video: "None added" });
    expect(
      describeMoveInDetails(
        {
          instructions: "Use the side door",
          houseInstructions: "Code is on the fridge",
          roomLabel: "Room 5",
          moveInPhotoDataUrls: ["a", "b"],
          houseMoveInPhotoDataUrls: ["c"],
          moveInVideoDataUrl: "v",
          houseMoveInVideoDataUrl: null,
          residentSection: null,
        },
        false,
      ),
    ).toEqual({ instructions: "The whole house · Room 5", photos: "3", video: "Added" });
  });
});
