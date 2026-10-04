// @vitest-environment jsdom
/**
 * The shared question editor behind Edit application, Edit move-in form and the wizard's inline
 * Application and Move-in cards: one row per section, questions edited in place, and every edit
 * written back to the stored shape the form always used.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApplicationQuestionsEditor } from "@/components/portal/question-editor/application-questions-editor";
import {
  applicationEditorTypes,
  applicationSectionsForEditor,
  applyApplicationEditorChange,
  convertBuiltInQuestion,
  type ApplicationEditorState,
} from "@/components/portal/question-editor/application-question-sections";
import {
  applyMoveInEditorChange,
  MOVE_IN_EDITOR_TYPES,
  moveInSectionsForEditor,
} from "@/components/portal/question-editor/move-in-question-sections";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import { orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  applicationConfigForVariant,
  editorVisibleDisabledApplicationFields,
  resolveListingApplicationFields,
  SYSTEM_READ_ANSWER_STANDARD_KEYS,
  type ApplicationConfigSlice,
  type ApplicationFormVariant,
} from "@/lib/rental-application/application-field-catalog";
import { defaultMoveInForm, MOVE_IN_FORM_STARTERS } from "@/lib/move-in-forms/templates";
import type { MoveInFormQuestion } from "@/lib/move-in-forms/types";

afterEach(() => cleanup());

const NAME_KEY = "personal-full-legal-name";
const PETS_KEY = "additional-pets";

function startSlice(variant: ApplicationFormVariant = "standard"): ApplicationConfigSlice {
  return applicationConfigForVariant(createDefaultListingSubmission(), variant);
}

function ctxFor(slice: ApplicationConfigSlice, variant: ApplicationFormVariant = "standard") {
  return {
    variant,
    fields: orderedEditorApplicationFields(slice),
    disabledFields: editorVisibleDisabledApplicationFields(variant, slice),
  };
}

function ApplicationHarness({
  initial = startSlice(),
  disabledSectionIds = [],
  onState,
}: {
  initial?: ApplicationConfigSlice;
  disabledSectionIds?: ApplicationEditorState["disabledSectionIds"];
  onState: (next: ApplicationEditorState) => void;
}) {
  const [state, setState] = useState<ApplicationEditorState>({ slice: initial, disabledSectionIds });
  const ctx = ctxFor(state.slice);
  return (
    <ApplicationQuestionsEditor
      variant="standard"
      state={state}
      fields={ctx.fields}
      disabledFields={ctx.disabledFields}
      onState={(next) => {
        onState(next);
        setState(next);
      }}
    />
  );
}

function openSection(id: string) {
  const toggle = document.querySelector(`[data-attr="question-editor-section-toggle-${id}"], [data-attr="application-questions-editor-section-toggle-${id}"]`) as HTMLElement | null;
  expect(toggle).not.toBeNull();
  if (toggle!.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle!);
}

function rowFor(label: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes(label));
  expect(row, `a row for ${label}`).toBeTruthy();
  return row!;
}

describe("no-edit round trip", () => {
  it("opening every section and question of an application and pressing Done changes nothing", () => {
    const initial = startSlice();
    const before = JSON.stringify(initial);
    const onState = vi.fn();
    render(<ApplicationHarness initial={initial} onState={onState} />);
    for (const toggle of document.querySelectorAll<HTMLElement>('[data-attr^="application-questions-editor-section-toggle-"]')) fireEvent.click(toggle);
    for (const open of Array.from(document.querySelectorAll<HTMLElement>('[data-attr$="question-open"]')).slice(0, 12)) {
      fireEvent.click(open);
      fireEvent.click(document.querySelector('[data-attr$="question-done"]') as HTMLElement);
    }
    expect(onState).not.toHaveBeenCalled();
    expect(JSON.stringify(initial)).toBe(before);
  });

  it("opening a move-in form's questions and pressing Done changes nothing", () => {
    const form = MOVE_IN_FORM_STARTERS[1]!;
    const before = JSON.stringify(form.questions);
    const onChange = vi.fn();
    render(<MoveInQuestionsEditor questions={form.questions} onChange={onChange} />);
    for (const toggle of document.querySelectorAll<HTMLElement>('[data-attr^="move-in-questions-editor-section-toggle-"][aria-expanded="false"]')) fireEvent.click(toggle);
    fireEvent.click(document.querySelector('[data-attr="move-in-questions-editor-question-open"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-attr="move-in-questions-editor-question-done"]') as HTMLElement);
    expect(onChange).not.toHaveBeenCalled();
    expect(JSON.stringify(form.questions)).toBe(before);
  });

  it("a change that cannot apply returns the same state object, so nothing is written", () => {
    const slice = startSlice();
    const state: ApplicationEditorState = { slice, disabledSectionIds: [] };
    expect(applyApplicationEditorChange(state, { kind: "remove-section", sectionId: "personal" }, ctxFor(slice))).toBe(state);
  });
});

describe("add, edit, duplicate, delete and reorder persist", () => {
  const ctxOf = (state: ApplicationEditorState) => ctxFor(state.slice);
  const run = (state: ApplicationEditorState, change: Parameters<typeof applyApplicationEditorChange>[1]) =>
    applyApplicationEditorChange(state, change, ctxOf(state));
  const labelsIn = (state: ApplicationEditorState, section: string) =>
    ctxOf(state).fields.filter((field) => (field.section ?? "additional") === section).map((field) => field.label);

  it("application: add, edit, duplicate, reorder and delete a custom question", () => {
    let state: ApplicationEditorState = { slice: startSlice(), disabledSectionIds: [] };
    state = run(state, { kind: "add-question", sectionId: "additional" });
    const added = ctxOf(state).fields.find((field) => !field.isStandard)!;
    expect(added.section).toBe("additional");

    state = run(state, { kind: "edit-question", sectionId: "additional", questionId: added.id, patch: { label: "Do you smoke?", type: "yes_no", required: true } });
    const edited = ctxOf(state).fields.find((field) => field.id === added.id)!;
    expect([edited.label, edited.type, edited.required]).toEqual(["Do you smoke?", "yes_no", true]);

    state = run(state, { kind: "duplicate-question", sectionId: "additional", questionId: added.id });
    const copy = ctxOf(state).fields.find((field) => field.label === "Do you smoke? (copy)")!;
    expect(copy.id).not.toBe(added.id);
    expect(copy.type).toBe("yes_no");

    const ids = ctxOf(state).fields.filter((field) => (field.section ?? "additional") === "additional").map((field) => field.id);
    state = run(state, { kind: "reorder", sectionId: "additional", orderedIds: [...ids.slice(0, -2), copy.id, added.id] });
    expect(ctxOf(state).fields.filter((field) => (field.section ?? "additional") === "additional").map((field) => field.id).slice(-2)).toEqual([copy.id, added.id]);

    state = run(state, { kind: "delete-question", sectionId: "additional", questionId: copy.id });
    expect(labelsIn(state, "additional")).not.toContain("Do you smoke? (copy)");
    expect(labelsIn(state, "additional")).toContain("Do you smoke?");
  });

  it("move-in: add, edit, duplicate, reorder and delete", () => {
    let questions: MoveInFormQuestion[] = [...defaultMoveInForm("move-in").questions];
    const sectionId = moveInSectionsForEditor(questions)[0]!.id;
    const count = questions.length;
    questions = applyMoveInEditorChange(questions, { kind: "add-question", sectionId });
    expect(questions).toHaveLength(count + 1);
    const added = questions.find((q) => !defaultMoveInForm("move-in").questions.some((o) => o.id === q.id))!;

    questions = applyMoveInEditorChange(questions, { kind: "edit-question", sectionId, questionId: added.id, patch: { label: "Gate code", type: "signature" } });
    const edited = questions.find((q) => q.id === added.id)!;
    expect([edited.label, edited.type, edited.required]).toEqual(["Gate code", "signature", true]);

    questions = applyMoveInEditorChange(questions, { kind: "duplicate-question", sectionId, questionId: added.id });
    const copy = questions.find((q) => q.label === "Gate code (copy)")!;
    expect(copy.id).not.toBe(added.id);
    expect(copy.key).not.toBe(added.key);

    const section = moveInSectionsForEditor(questions).find((s) => s.questions.some((q) => q.id === copy.id))!;
    const ordered = section.questions.map((q) => q.id);
    const swapped = [...ordered];
    [swapped[ordered.indexOf(added.id)], swapped[ordered.indexOf(copy.id)]] = [copy.id, added.id];
    questions = applyMoveInEditorChange(questions, { kind: "reorder", sectionId: section.id, orderedIds: swapped });
    expect(moveInSectionsForEditor(questions).find((s) => s.id === section.id)!.questions.map((q) => q.id)).toEqual(swapped);

    questions = applyMoveInEditorChange(questions, { kind: "delete-question", sectionId: section.id, questionId: copy.id });
    expect(questions.some((q) => q.id === copy.id)).toBe(false);
    expect(questions.some((q) => q.id === added.id)).toBe(true);
  });

  it("the rendered editor adds a question, opens it, edits it and reorders with the handle's arrow keys", () => {
    const onChange = vi.fn();
    function Harness() {
      const [questions, setQuestions] = useState<MoveInFormQuestion[]>([...MOVE_IN_FORM_STARTERS[0]!.questions]);
      return <MoveInQuestionsEditor questions={questions} onChange={(next) => { onChange(next); setQuestions(next); }} />;
    }
    render(<Harness />);
    for (const toggle of document.querySelectorAll<HTMLElement>('[data-attr^="move-in-questions-editor-section-toggle-"][aria-expanded="false"]')) fireEvent.click(toggle);
    fireEvent.click(screen.getAllByRole("button", { name: "+ Add question" })[0]!);
    const label = document.querySelector('[data-attr="move-in-questions-editor-question-label"]') as HTMLInputElement;
    expect(label).not.toBeNull();
    fireEvent.change(label, { target: { value: "Pet name" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ label: "Pet name" })]));
    fireEvent.click(document.querySelector('[data-attr="move-in-questions-editor-question-done"]') as HTMLElement);

    const firstSection = document.querySelector("[data-section-id]") as HTMLElement;
    const handles = firstSection.querySelectorAll<HTMLElement>('[data-attr="move-in-questions-editor-question-handle"]');
    const firstLabel = firstSection.querySelector("[data-question-id]")!.textContent;
    fireEvent.keyDown(handles[0]!, { key: "ArrowDown" });
    expect(firstSection.querySelector("[data-question-id]")!.textContent).not.toBe(firstLabel);
  });
});

describe("sections", () => {
  it("each section is drawn exactly once, with a switch, and there is no second checkbox list", () => {
    render(<ApplicationHarness onState={() => {}} />);
    const ids = Array.from(document.querySelectorAll("[data-section-id]")).map((el) => el.getAttribute("data-section-id"));
    expect(ids).toEqual(Array.from(new Set(ids)));
    expect(ids).toHaveLength(9);
    for (const id of ids) {
      expect(document.querySelectorAll(`[data-attr="application-questions-editor-section-switch-${id}"]`)).toHaveLength(1);
    }
    expect(document.querySelector('[data-attr="application-sections-checklist"]')).toBeNull();
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it("no section is locked: every switch is live and turns the section off and back on", () => {
    const onState = vi.fn();
    render(<ApplicationHarness onState={onState} />);
    for (const id of ["personal", "property"]) {
      const sw = document.querySelector(`[data-attr="application-questions-editor-section-switch-${id}"]`) as HTMLButtonElement;
      expect(sw.disabled).toBe(false);
      expect(document.querySelector(`[data-attr="application-questions-editor-section-lock-${id}"]`)).toBeNull();
    }
    const slice = startSlice();
    const state: ApplicationEditorState = { slice, disabledSectionIds: [] };
    const off = applyApplicationEditorChange(state, { kind: "toggle-section", sectionId: "personal", enabled: false }, ctxFor(slice));
    expect(off.disabledSectionIds).toEqual(["personal"]);
    expect(off.slice.disabledStandardApplicationKeys).toContain(NAME_KEY);
  });
});

describe("answer types", () => {
  it("the move-in editor adds Photos, Signature and Acknowledge; the application editor does not", () => {
    const moveIn = MOVE_IN_EDITOR_TYPES.map((type) => type.id);
    expect(moveIn).toEqual(expect.arrayContaining(["photos", "signature"]));
    expect(MOVE_IN_EDITOR_TYPES.map((type) => type.label)).toEqual(expect.arrayContaining(["Photos", "Signature", "Acknowledge"]));
    const application = applicationEditorTypes("standard");
    expect(application.map((type) => type.id)).not.toContain("photos");
    expect(application.map((type) => type.id)).not.toContain("signature");
    expect(application.map((type) => type.label)).not.toContain("Acknowledge");
    expect(applicationEditorTypes("cosigner").map((type) => type.id)).not.toContain("file");
  });
});

describe("every question is editable, except what the system reads by key", () => {
  const find = (slice: ApplicationConfigSlice, key: string) => ctxFor(slice).fields.find((field) => field.standardKey === key)!;
  const state0 = (): ApplicationEditorState => ({ slice: startSlice(), disabledSectionIds: [] });

  it("a non-identity built-in's required flag, type and delete all persist", () => {
    let state = state0();
    const ctx = () => ctxFor(state.slice);
    const pets = find(state.slice, PETS_KEY);
    expect(pets.type).toBe("text");

    state = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "additional", questionId: pets.id, patch: { required: true } }, ctx());
    expect(find(state.slice, PETS_KEY).required).toBe(true);

    // A type change retires the built-in and asks a custom question of the new type in its place.
    const before = ctx().fields.filter((f) => (f.section ?? "additional") === "additional").map((f) => f.id);
    state = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "additional", questionId: find(state.slice, PETS_KEY).id, patch: { type: "yes_no" } }, ctx());
    expect(ctx().fields.some((f) => f.standardKey === PETS_KEY)).toBe(false);
    const replacement = ctx().fields.find((f) => !f.isStandard && f.label === "Pets")!;
    expect([replacement.type, replacement.required, replacement.section]).toEqual(["yes_no", true, "additional"]);
    const after = ctx().fields.filter((f) => (f.section ?? "additional") === "additional").map((f) => f.id);
    expect(after.indexOf(replacement.id)).toBe(before.indexOf(`std-${PETS_KEY}`));
    // The retired built-in is not listed a second time next to its replacement.
    const sections = applicationSectionsForEditor({ ...ctx(), disabledSectionIds: [] });
    expect(sections.find((s) => s.id === "additional")!.questions.filter((q) => q.label === "Pets")).toHaveLength(1);

    // Delete turns a built-in off; Add back brings it back.
    const income = find(state.slice, "additional-number-of-occupants");
    state = applyApplicationEditorChange(state, { kind: "delete-question", sectionId: "additional", questionId: income.id }, ctx());
    expect(state.slice.disabledStandardApplicationKeys).toContain("additional-number-of-occupants");
    state = applyApplicationEditorChange(state, { kind: "restore-question", sectionId: "additional", questionId: income.id }, ctx());
    expect(state.slice.disabledStandardApplicationKeys).not.toContain("additional-number-of-occupants");
  });

  it("an identity field's text edit persists; its type change detaches it and delete works", () => {
    let state = state0();
    const ctx = () => ctxFor(state.slice);
    const name = find(state.slice, NAME_KEY);
    state = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "personal", questionId: name.id, patch: { label: "Your legal name" } }, ctx());
    const renamed = find(state.slice, NAME_KEY);
    expect(renamed.label).toBe("Your legal name");
    // The key the system reads is untouched: only the words changed.
    expect(renamed.standardKey).toBe(NAME_KEY);
    expect(renamed.type).toBe("text");

    const q = applicationSectionsForEditor({ ...ctx(), disabledSectionIds: [] }).find((s) => s.id === "personal")!.questions.find((x) => x.id === name.id)!;
    expect(q.can).toMatchObject({ type: true, remove: true, label: true, required: true });
    expect(q.systemRead?.feature).toBeTruthy();

    // Detach: the standard key goes off and a custom question of the new type, with a new key, takes its place.
    const detached = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "personal", questionId: name.id, patch: { type: "long_text" } }, ctx());
    expect(detached.slice.disabledStandardApplicationKeys).toContain(NAME_KEY);
    const resolved = ctxFor(detached.slice).fields;
    expect(resolved.find((f) => f.standardKey === NAME_KEY)).toBeUndefined();
    const custom = resolved.find((f) => !f.isStandard && f.label === "Your legal name")!;
    expect(custom.type).toBe("long_text");
    expect(custom.key).not.toBe(NAME_KEY);

    const deleted = applyApplicationEditorChange(state, { kind: "delete-question", sectionId: "personal", questionId: name.id }, ctx());
    expect(deleted.slice.disabledStandardApplicationKeys).toContain(NAME_KEY);
  });

  it("a detached question is simply absent for system readers, whichever built-in it was", () => {
    let state = state0();
    const ctx = () => ctxFor(state.slice);
    for (const key of SYSTEM_READ_ANSWER_STANDARD_KEYS) {
      const field = ctx().fields.find((f) => f.standardKey === key);
      if (!field) continue;
      const next = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: field.section ?? "additional", questionId: field.id, patch: { type: field.type === "text" ? "long_text" : "text" } }, ctx());
      expect(next.slice.disabledStandardApplicationKeys, key).toContain(key);
      expect(ctxFor(next.slice).fields.some((f) => f.standardKey === key), key).toBe(false);
      state = next;
    }
    expect(ctx().fields.some((f) => f.standardKey && SYSTEM_READ_ANSWER_STANDARD_KEYS.includes(f.standardKey))).toBe(false);
  });

  it("the system-read set is the identity and screening fields plus the placement, fee and group fields", () => {
    expect(SYSTEM_READ_ANSWER_STANDARD_KEYS).toEqual(
      expect.arrayContaining([
        NAME_KEY,
        "personal-email",
        "personal-phone",
        "personal-date-of-birth",
        "personal-social-security-number",
        "employment-monthly-annual-income",
        "property-property",
        "property-lease-term",
      ]),
    );
    expect(SYSTEM_READ_ANSWER_STANDARD_KEYS).not.toContain(PETS_KEY);
  });

  it("a type change touches only the question config, never a submitted application", () => {
    const slice = startSlice();
    const frozen = JSON.stringify(slice);
    const submittedView = resolveListingApplicationFields(slice, (raw) => raw as []);
    const pets = ctxFor(slice).fields.find((f) => f.standardKey === PETS_KEY)!;
    const next = convertBuiltInQuestion(slice, ctxFor(slice).fields, pets, { type: "number" });
    // The input is not mutated, so a form already published (and the answers stored against it) keeps its shape.
    expect(JSON.stringify(slice)).toBe(frozen);
    expect(resolveListingApplicationFields(slice, (raw) => raw as []).find((f) => f.standardKey === PETS_KEY)!.type).toBe(submittedView.find((f) => f.standardKey === PETS_KEY)!.type);
    // Only question-config keys change.
    expect(Object.keys(next).sort()).toEqual(Object.keys({ ...slice, questionDisplayOrder: [] }).sort());
    expect(next.disabledStandardApplicationKeys).toContain(PETS_KEY);
  });

  it("an identity question's Type is a dropdown, its menu has Delete, and a type change asks first", async () => {
    const onState = vi.fn();
    render(<ApplicationHarness onState={onState} />);
    openSection("personal");
    const row = rowFor("Full legal name");
    fireEvent.keyDown(row.querySelector('[data-attr="application-questions-editor-question-menu"]') as HTMLElement, { key: "ArrowDown" });
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.click(row.querySelector('[data-attr="application-questions-editor-question-open"]') as HTMLElement);
    expect(document.querySelector('[data-attr="application-questions-editor-question-type-text"]')).toBeNull();
    expect(document.querySelector('[data-attr="application-questions-editor-question-required"]')).not.toBeNull();
    const pickLongText = () => {
      if (!screen.queryByRole("listbox")) fireEvent.click(document.querySelector('[data-attr="application-questions-editor-question-type"]') as HTMLElement);
      const option = within(screen.getByRole("listbox")).getByText("Long text");
      fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    };
    pickLongText();

    // One confirm; nothing is written until it is answered.
    const confirm = document.querySelector('[data-attr="application-questions-editor-question-type-confirm"]') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain("Change Full legal name to Long text?");
    expect(confirm.textContent).toContain("reads this answer as Text");
    expect(confirm.textContent).toContain("it becomes your own question");
    expect(onState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep Text" }));
    expect(document.querySelector('[data-attr="application-questions-editor-question-type-confirm"]')).toBeNull();
    expect(onState).not.toHaveBeenCalled();

    pickLongText();
    fireEvent.click(screen.getByRole("button", { name: "Change to Long text" }));
    expect(onState).toHaveBeenCalledTimes(1);
    expect((onState.mock.calls[0]![0] as ApplicationEditorState).slice.disabledStandardApplicationKeys).toContain(NAME_KEY);
    expect(document.body.textContent).not.toMatch(/Fixed|Built-in/);
  });
});
