import { describe, expect, it } from "vitest";
import {
  filterFormsList,
  formsBlocksFact,
  formsBucketCounts,
  formsBucketOf,
  formsDateFact,
  formatMoveInDate,
  groupMoveInAnswers,
  lateFormNeedsLine,
  lateMoveInForms,
  moveInFormDaysLate,
  moveInFormPlaceLine,
  moveInFormTitle,
} from "@/lib/move-in-forms/manager-rows";
import { describeMoveInDetails } from "@/components/portal/move-in-forms/resident-record-move-in-section";
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
    blocks: "nothing",
    questionCount: 5,
    photoCount: 0,
    signed: false,
    ...patch,
  };
}

describe("move-in form row copy", () => {
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

describe("the Forms list helpers", () => {
  const sent = (patch: Partial<MoveInFormSummary> = {}) => form({ blocks: "nothing", ...patch });
  const done = (patch: Partial<MoveInFormSummary> = {}) => sent({ status: "submitted", submittedAt: "2026-09-28T20:00:00.000Z", ...patch });

  it("Pending is a sent copy and Completed a submitted one; a cancelled copy is in neither", () => {
    expect(formsBucketOf({ status: "sent" })).toBe("pending");
    expect(formsBucketOf({ status: "submitted" })).toBe("completed");
    expect(formsBucketOf({ status: "cancelled" })).toBeNull();
    expect(formsBucketCounts([sent(), sent({ id: "2" }), done({ id: "3" }), sent({ id: "4", status: "cancelled" })])).toEqual({ pending: 2, completed: 1 });
  });

  it("says what a row blocks as a plain fact, reading an old intake form's default from its kind", () => {
    expect(formsBlocksFact(sent({ blocks: "lease_signing" }))).toBe("Blocks Lease signing");
    expect(formsBlocksFact(sent({ blocks: "approval" }))).toBe("Blocks Approval");
    expect(formsBlocksFact(sent({ blocks: "move_in_details" }))).toBe("Blocks Move-in details");
    expect(formsBlocksFact(sent({ blocks: "nothing" }))).toBe("Blocks nothing");
    expect(formsBlocksFact(sent({ kind: "intake", blocks: undefined as never }))).toBe("Blocks Move-in details");
  });

  it("the date fact is Due (red once late) for a pending form and Submitted for a completed one", () => {
    expect(formsDateFact(sent({ dueAt: "2026-10-12T06:59:59.000Z" }), NOW)).toEqual({ text: "Due Oct 11", late: false });
    expect(formsDateFact(sent({ dueAt: "2026-10-01T06:59:59.000Z" }), NOW)).toEqual({ text: "Due Sep 30 · 3 days late", late: true });
    expect(formsDateFact(sent({ dueAt: null, sentAt: "2026-10-01T17:00:00.000Z" }), NOW)).toEqual({ text: "Sent Oct 1", late: false });
    expect(formsDateFact(done(), NOW)).toEqual({ text: "Submitted Sep 28", late: false });
  });

  it("filters by bucket, kind, property, resident, blocks and search, late first", () => {
    const rows = [
      sent({ id: "a", formName: "Intake", kind: "intake", blocks: "move_in_details", dueAt: "2026-10-20T06:59:59.000Z" }),
      sent({ id: "b", formName: "Pet agreement", blocks: "lease_signing", residentName: "Maya Chen", applicationId: "app-2", propertyId: "p2", propertyLabel: "Alder Row", dueAt: "2026-10-01T06:59:59.000Z" }),
      done({ id: "c", formName: "Checklist", kind: "move-in" }),
      sent({ id: "x", status: "cancelled" }),
    ];
    const ids = (filters: Parameters<typeof filterFormsList>[1]) => filterFormsList(rows, filters, NOW).map((f) => f.id);
    expect(ids({ bucket: "pending" })).toEqual(["b", "a"]);
    expect(ids({ bucket: "completed" })).toEqual(["c"]);
    expect(ids({ bucket: "pending", kinds: ["intake"] })).toEqual(["a"]);
    expect(ids({ bucket: "pending", propertyIds: ["p2"] })).toEqual(["b"]);
    expect(ids({ bucket: "pending", residentIds: ["app-1"] })).toEqual(["a"]);
    expect(ids({ bucket: "pending", blocks: ["lease_signing", "approval"] })).toEqual(["b"]);
    expect(ids({ bucket: "pending", blocks: ["nothing"] })).toEqual([]);
    expect(ids({ bucket: "pending", query: "maya alder" })).toEqual(["b"]);
    expect(ids({ bucket: "pending", query: "blocks lease" })).toEqual(["b"]);
  });
});

describe("resident record helpers", () => {
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
