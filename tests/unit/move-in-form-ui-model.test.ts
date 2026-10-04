import { describe, expect, it } from "vitest";
import {
  addMoveInQuestion,
  addMoveInSection,
  answersToMap,
  audienceSummary,
  cleanMoveInTemplateForSave,
  answerFormatProblem,
  copyTemplateToProperty,
  firstFormatProblem,
  duplicateMoveInTemplate,
  fieldStringToAnswer,
  flattenSections,
  groupQuestionsBySection,
  isMoveInFormLate,
  mapToAnswers,
  moveInFormPreviewHtml,
  moveInFormProblems,
  moveInFormProgress,
  removeMoveInQuestion,
  removeMoveInSection,
  renameMoveInSection,
  reorderMoveInSection,
  moveMoveInQuestion,
  templateFigure,
  templateSourceLine,
  uniqueQuestionKey,
  updateMoveInQuestion,
  upsertMoveInTemplate,
  visibleMoveInQuestions,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
import type { MoveInFormQuestion, MoveInFormTemplate } from "@/lib/move-in-forms/types";

function q(key: string, patch: Partial<MoveInFormQuestion> = {}): MoveInFormQuestion {
  return { id: `q-${key}`, key, label: key, type: "text", required: false, options: [], ...patch };
}

describe("answers and visibility", () => {
  const questions = [
    q("has_pet", { type: "yes_no", required: true }),
    q("pet_name", { required: true, showIf: { fieldKey: "has_pet", equals: "yes" } }),
    q("sign", { type: "signature", required: true }),
  ];

  it("hides a conditional question until its gate holds that exact answer", () => {
    expect(visibleMoveInQuestions(questions, {}).map((x) => x.key)).toEqual(["has_pet", "sign"]);
    const yes = answersToMap([{ key: "has_pet", value: "yes" }]);
    expect(visibleMoveInQuestions(questions, yes).map((x) => x.key)).toEqual(["has_pet", "pet_name", "sign"]);
    const no = answersToMap([{ key: "has_pet", value: "no" }]);
    expect(visibleMoveInQuestions(questions, no).map((x) => x.key)).toEqual(["has_pet", "sign"]);
  });

  it("a question hidden by its own gate cannot open another", () => {
    const chain = [
      q("a", { type: "yes_no" }),
      q("b", { showIf: { fieldKey: "a", equals: "yes" } }),
      q("c", { showIf: { fieldKey: "b", equals: "x" } }),
    ];
    const map = answersToMap([{ key: "b", value: "x" }]);
    expect(visibleMoveInQuestions(chain, map).map((x) => x.key)).toEqual(["a"]);
  });

  it("progress counts only visible questions and lists required ones still empty", () => {
    const map = answersToMap([{ key: "has_pet", value: "yes" }]);
    const progress = moveInFormProgress(questions, map);
    expect(progress.total).toBe(3);
    expect(progress.answered).toBe(1);
    expect(progress.ratio).toBeCloseTo(1 / 3);
    expect(progress.missing.map((x) => x.key)).toEqual(["pet_name", "sign"]);
    expect(progress.resumeIndex).toBe(1);
  });

  it("an unticked required checkbox and a blank string do not count as answered", () => {
    const boxes = [q("agree", { type: "checkbox", required: true }), q("name", { required: true })];
    const map = answersToMap([
      { key: "agree", value: "" },
      { key: "name", value: "   " },
    ]);
    expect(moveInFormProgress(boxes, map).missing.map((x) => x.key)).toEqual(["agree", "name"]);
    expect(moveInFormProgress(boxes, answersToMap([{ key: "agree", value: "yes" }, { key: "name", value: "Ada" }])).missing).toEqual([]);
  });

  it("everything answered resumes on the last question", () => {
    const map = answersToMap([
      { key: "has_pet", value: "no" },
      { key: "sign", signature: { storagePath: "u/sig.png", signedName: "Ada", signedAt: "2026-10-03T00:00:00Z" } },
    ]);
    const progress = moveInFormProgress(questions, map);
    expect(progress.missing).toEqual([]);
    expect(progress.resumeIndex).toBe(1);
  });

  it("only visible, filled answers are written back, in question order", () => {
    const map = answersToMap([
      { key: "sign", signature: { storagePath: "u/sig.png", signedName: "Ada", signedAt: "x" } },
      { key: "pet_name", value: "Rex" },
      { key: "has_pet", value: "no" },
    ]);
    // pet_name is hidden by has_pet = no, so a stale answer never leaves the device.
    expect(mapToAnswers(questions, map).map((a) => a.key)).toEqual(["has_pet", "sign"]);
  });

  it("holds back half-typed answers from a draft but not from a submit", () => {
    const form = [q("phone", { type: "phone" }), q("name")];
    const map = answersToMap([
      { key: "phone", value: "(206) 55" },
      { key: "name", value: "Ada" },
    ]);
    expect(mapToAnswers(form, map, { draft: true }).map((a) => a.key)).toEqual(["name"]);
    expect(mapToAnswers(form, map).map((a) => a.key)).toEqual(["phone", "name"]);
    expect(firstFormatProblem(form, map)?.question.key).toBe("phone");
    expect(answerFormatProblem(form[0]!, { key: "phone", value: "(206) 555-1234" })).toBeNull();
  });

  it("applies the server's format rules to typed answers", () => {
    expect(answerFormatProblem(q("e", { type: "email" }), { key: "e", value: "nope" })).toMatch(/email/i);
    expect(answerFormatProblem(q("e", { type: "email" }), { key: "e", value: "ada@example.com" })).toBeNull();
    expect(answerFormatProblem(q("n", { type: "number" }), { key: "n", value: "12abc" })).toMatch(/number/i);
    expect(answerFormatProblem(q("n", { type: "currency" }), { key: "n", value: "1200.50" })).toBeNull();
    expect(fieldStringToAnswer({ type: "currency", key: "n" }, "$1,200.50")).toEqual({ key: "n", value: "1200.50" });
    expect(fieldStringToAnswer({ type: "number", key: "n" }, "12abc")).toEqual({ key: "n", value: "12abc" });
    expect(answerFormatProblem(q("d", { type: "date" }), { key: "d", value: "2026-13-40" })).toMatch(/date/i);
    expect(answerFormatProblem(q("d", { type: "date" }), { key: "d", value: "2026-10-03" })).toBeNull();
    expect(answerFormatProblem(q("s", { type: "select", options: ["a", "b"] }), { key: "s", value: "c" })).toMatch(/option/i);
    expect(answerFormatProblem(q("t"), { key: "t", value: "x".repeat(501) })).toMatch(/500/);
    expect(answerFormatProblem(q("t"), { key: "t", value: "" })).toBeNull();
  });

  it("converts pick-several answers both ways", () => {
    const multi = { type: "multi_select" as const, key: "keys" };
    expect(fieldStringToAnswer(multi, JSON.stringify(["Front", "Room"]))).toEqual({ key: "keys", value: ["Front", "Room"] });
    expect(fieldStringToAnswer(multi, "")).toBeNull();
    expect(fieldStringToAnswer({ type: "text", key: "n" }, "  ")).toBeNull();
  });
});

describe("question and section editing", () => {
  const base = [q("a", { section: "Keys" }), q("b", { section: "Keys" }), q("c", { section: "Room" })];

  it("groups by first-seen section and flattens back without losing order", () => {
    const groups = groupQuestionsBySection(base);
    expect(groups.map((g) => [g.name, g.questions.map((x) => x.key)])).toEqual([
      ["Keys", ["a", "b"]],
      ["Room", ["c"]],
    ]);
    expect(flattenSections(groups).map((x) => x.key)).toEqual(["a", "b", "c"]);
  });

  it("adds a question to the end of its section, with a key nobody else holds", () => {
    const next = addMoveInQuestion(base, "Keys");
    expect(next.map((x) => x.section)).toEqual(["Keys", "Keys", "Keys", "Room"]);
    const added = next[2]!;
    expect(added.label).toBe("");
    expect(base.some((x) => x.key === added.key)).toBe(false);
    expect(new Set(next.map((x) => x.key)).size).toBe(next.length);
  });

  it("a new section arrives with one blank question so it exists in the stored list", () => {
    const next = addMoveInSection(base);
    expect(next).toHaveLength(4);
    expect(next[3]!.section).toBe("Section 3");
    expect(addMoveInSection(next)[4]!.section).toBe("Section 4");
  });

  it("renames and removes a section", () => {
    expect(renameMoveInSection(base, "Keys", "Keys and access").map((x) => x.section)).toEqual(["Keys and access", "Keys and access", "Room"]);
    expect(renameMoveInSection(base, "Keys", "").map((x) => x.section)).toEqual([undefined, undefined, "Room"]);
    expect(removeMoveInSection(base, "Keys").map((x) => x.key)).toEqual(["c"]);
  });

  it("reorders inside one section and leaves the others alone", () => {
    expect(reorderMoveInSection(base, "Keys", ["q-b", "q-a"]).map((x) => x.key)).toEqual(["b", "a", "c"]);
    // A list that is not a permutation of the section is refused rather than dropping a question.
    expect(reorderMoveInSection(base, "Keys", ["q-b"]).map((x) => x.key)).toEqual(["a", "b", "c"]);
  });

  it("changing a type drops options it cannot use, seeds a pick list, and forces a signature required", () => {
    const withOptions = [q("p", { type: "select", options: ["x", "y"] })];
    expect(updateMoveInQuestion(withOptions, "q-p", { type: "text" })[0]!.options).toEqual([]);
    expect(updateMoveInQuestion([q("t")], "q-t", { type: "multi_select" })[0]!.options).toHaveLength(2);
    const signed = updateMoveInQuestion([q("s")], "q-s", { type: "signature" })[0]!;
    expect(signed.required).toBe(true);
    expect(removeMoveInQuestion(base, "q-a").map((x) => x.key)).toEqual(["b", "c"]);
  });

  it("unique keys never collide and ignore label punctuation", () => {
    expect(uniqueQuestionKey(new Set(), "Keys & Access!")).toBe("keys_access");
    expect(uniqueQuestionKey(new Set(["keys_access"]), "Keys & Access!")).toBe("keys_access_2");
    expect(uniqueQuestionKey(new Set(), "")).toBe("question");
  });
});

describe("template list and wording", () => {
  const upload = (): MoveInFormTemplate => ({
    ...newMoveInFormTemplate("upload"),
    name: "Pet agreement",
    pdf: { storagePath: "u/move-in-forms/f/1.pdf", fileName: "pets.pdf", pageCount: 3, sha256: "a".repeat(64) },
  });

  it("upserts by id, keeping place, and appends a new one", () => {
    const list = [...MOVE_IN_FORM_STARTERS];
    const renamed = upsertMoveInTemplate(list, { ...list[1]!, name: "Keys" });
    expect(renamed.map((t) => t.id)).toEqual(list.map((t) => t.id));
    expect(renamed[1]!.name).toBe("Keys");
    expect(upsertMoveInTemplate(list, upload())).toHaveLength(list.length + 1);
  });

  it("a duplicate of an uploaded form drops the PDF reference, which is stored under the original's id", () => {
    const original = upload();
    const { copy } = duplicateMoveInTemplate([original], original.id, "mif-copy");
    expect(copy!.pdf).toBeNull();
    expect(copy!.source).toBe("upload");
  });

  it("a duplicate sits after its original, sent only by hand, with its own id and no starter mark", () => {
    const list = [...MOVE_IN_FORM_STARTERS];
    const checklistAt = list.findIndex((t) => t.starterKey === "move-in-checklist");
    const { list: next, copy } = duplicateMoveInTemplate(list, list[checklistAt]!.id, "mif-copy");
    expect(copy).not.toBeNull();
    expect(next[checklistAt + 1]!.id).toBe("mif-copy");
    expect(list[checklistAt]!.trigger).toBe("lease-signed");
    expect(copy!.trigger).toBe("manual");
    expect(copy!.starterKey).toBeUndefined();
    expect(copy!.name).toBe("Move-in checklist (copy)");
    expect(duplicateMoveInTemplate(list, "nope", "x").copy).toBeNull();
  });

  it("copying to another property clears the PDF and the room list that belonged to the source", () => {
    const copy = copyTemplateToProperty({ ...upload(), audience: { kind: "rooms", roomIds: ["r1"] }, trigger: "lease-signed" }, "mif-new");
    expect(copy.pdf).toBeNull();
    expect(copy.audience).toEqual({ kind: "every-room" });
    expect(copy.trigger).toBe("manual");
  });

  it("moves a question one place inside its own section and stops at the ends", () => {
    const list = [q("a", { section: "S" }), q("b", { section: "S" }), q("c", { section: "T" })];
    expect(moveMoveInQuestion(list, list[0]!.id, "down").map((x) => x.key)).toEqual(["b", "a", "c"]);
    expect(moveMoveInQuestion(list, list[1]!.id, "up").map((x) => x.key)).toEqual(["b", "a", "c"]);
    expect(moveMoveInQuestion(list, list[1]!.id, "down").map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(moveMoveInQuestion(list, list[0]!.id, "up").map((x) => x.key)).toEqual(["a", "b", "c"]);
  });

  it("row wording: source line, audience and figure", () => {
    expect(templateSourceLine(newMoveInFormTemplate("built"))).toBe("Built in PropLane");
    expect(templateSourceLine(upload())).toBe("pets.pdf · 3 pages");
    expect(templateSourceLine({ ...upload(), pdf: null })).toBe("PDF not uploaded yet");
    const rooms = [{ id: "r1", label: "Room 1" }, { id: "r2", label: "Room 2" }, { id: "r3", label: "Room 3" }];
    expect(audienceSummary({ kind: "every-room" }, rooms)).toBe("Every room");
    expect(audienceSummary({ kind: "whole-house" }, rooms)).toBe("Whole house");
    expect(audienceSummary({ kind: "rooms", roomIds: ["r1", "r3"] }, rooms)).toBe("Room 1, Room 3");
    expect(audienceSummary({ kind: "rooms", roomIds: ["r1", "r2", "r3"] }, rooms)).toBe("3 rooms");
    expect(audienceSummary({ kind: "rooms", roomIds: [] }, rooms)).toBe("No rooms picked");

    const t = { id: "f1" };
    expect(templateFigure(t, [])).toBe("");
    expect(
      templateFigure(t, [
        { formId: "f1", status: "submitted" },
        { formId: "f1", status: "sent" },
        { formId: "f1", status: "cancelled" },
        { formId: "other", status: "submitted" },
      ]),
    ).toBe("1 of 2 residents");
  });

  it("late is a due moment in the past, never an absent one", () => {
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(isMoveInFormLate("2026-10-02T12:00:00Z", now)).toBe(true);
    expect(isMoveInFormLate("2026-10-04T12:00:00Z", now)).toBe(false);
    expect(isMoveInFormLate(null, now)).toBe(false);
  });
});

describe("saving", () => {
  it("names what blocks a form, in step order", () => {
    const empty = newMoveInFormTemplate("built");
    expect(moveInFormProblems(empty)).toEqual(["Name this form.", "Add at least one question."]);
    const upload = newMoveInFormTemplate("upload");
    expect(moveInFormProblems(upload)).toEqual(["Name this form.", "Upload the PDF."]);
    expect(
      moveInFormProblems({ ...empty, name: "x", questions: [q("a", { label: "" }), q("p", { type: "select", options: ["one"] })] }),
    ).toEqual(["Every question needs words.", "A pick question needs at least two choices."]);
    expect(moveInFormProblems({ ...empty, name: "x", questions: [q("a")], audience: { kind: "rooms", roomIds: [] } })).toEqual(["Pick at least one room."]);
  });

  it("every starter is saveable as shipped", () => {
    for (const starter of MOVE_IN_FORM_STARTERS) expect(moveInFormProblems(starter)).toEqual([]);
  });

  it("drops blank questions and trims pick lists before the form is written", () => {
    const cleaned = cleanMoveInTemplateForSave({
      ...newMoveInFormTemplate("built"),
      name: "  Keys  ",
      questions: [q("a", { label: "  Count  " }), q("b", { label: "" }), q("c", { type: "select", options: [" x ", "", "y"] })],
    });
    expect(cleaned.name).toBe("Keys");
    expect(cleaned.questions.map((x) => x.label)).toEqual(["Count", "c"]);
    expect(cleaned.questions[1]!.options).toEqual(["x", "y"]);
  });

  it("the new-tab preview escapes everything it prints", () => {
    const html = moveInFormPreviewHtml({ name: "<b>Hi</b>", questions: [q("a", { label: "<script>x</script>", section: "S&T" })] });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("S&amp;T");
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
  });
});
