// @vitest-environment jsdom
/**
 * Linked forms on every question: "When the answer is X include <form>", with the form's own fee as a plain
 * fact, a doc glyph and the form name on the question row, and a template's co-signer link shown as a rule on
 * Co-signer planned.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApplicationQuestionsEditor } from "@/components/portal/question-editor/application-questions-editor";
import type { ApplicationEditorState } from "@/components/portal/question-editor/application-question-sections";
import type { LinkedFormOption } from "@/components/portal/question-editor/question-editor-types";
import { editorFieldsWithLinkedForms, orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  applicationConfigForVariant,
  editorVisibleDisabledApplicationFields,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";

afterEach(() => cleanup());

const PREFIX = "application-questions-editor";
const OPTIONS: LinkedFormOption[] = [
  { ref: { kind: "application", id: "cos-1" }, label: "Co-signer application", feeText: "Charges $50" },
  { ref: { kind: "move_in", id: "mif-1" }, label: "Pet addendum", feeText: "No fee" },
];

function Harness({ cosignerId = null, onState }: { cosignerId?: string | null; onState?: (next: ApplicationEditorState) => void }) {
  const [state, setState] = useState<ApplicationEditorState>({
    slice: applicationConfigForVariant(createDefaultListingSubmission(), "standard") as ApplicationConfigSlice,
    disabledSectionIds: [],
  });
  const fields = editorFieldsWithLinkedForms(orderedEditorApplicationFields(state.slice), cosignerId);
  return (
    <ApplicationQuestionsEditor
      variant="standard"
      state={state}
      fields={fields}
      disabledFields={editorVisibleDisabledApplicationFields("standard", state.slice)}
      linkedFormOptions={OPTIONS}
      onState={(next) => {
        onState?.(next);
        setState(next);
      }}
    />
  );
}

function openQuestion(sectionId: string, label: string) {
  const toggle = document.querySelector(`[data-attr="${PREFIX}-section-toggle-${sectionId}"]`) as HTMLElement;
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes(label))!;
  fireEvent.click(row.querySelector(`[data-attr="${PREFIX}-question-open"]`) as HTMLElement);
}

function pick(triggerAttr: string, option: string) {
  const trigger = document.querySelector(`[data-attr="${triggerAttr}"]`) as HTMLElement;
  fireEvent.click(trigger);
  const target = within(screen.getByRole("listbox")).getByText(option);
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("Linked forms block", () => {
  it("is on a built-in and a custom question, empty until a form is linked", () => {
    render(<Harness />);
    openQuestion("household", "Co-signer planned");
    expect(document.querySelector(`[data-attr="${PREFIX}-question-linked-forms-block"]`)).not.toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-linked-form-rule"]`)).toBeNull();
    expect(screen.getByRole("button", { name: "+ Link a form" })).toBeTruthy();
  });

  it("a template's co-signer link shows as a rule on Co-signer planned, with that form's fee", () => {
    render(<Harness cosignerId="cos-1" />);
    openQuestion("household", "Co-signer planned");
    const rule = document.querySelector(`[data-attr="${PREFIX}-question-linked-form-rule"]`) as HTMLElement;
    expect(rule).not.toBeNull();
    expect(rule.textContent).toContain("Yes");
    expect(rule.textContent).toContain("Co-signer application");
    expect(rule.textContent).toContain("Charges $50");
    expect(rule.querySelector(`[data-attr="${PREFIX}-question-linked-form-needed"]`)!.getAttribute("aria-checked")).toBe("true");
  });

  it("+ Link a form adds a rule that is stored on the question and drawn on its row", () => {
    const onState = vi.fn();
    render(<Harness onState={onState} />);
    openQuestion("household", "Co-signer planned");
    fireEvent.click(screen.getByRole("button", { name: "+ Link a form" }));
    const last = onState.mock.calls.at(-1)![0] as ApplicationEditorState;
    const stored = last.slice.customApplicationFields.find((f) => f.standardKey === "household-co-signer-planned")!;
    expect(stored.linkedForms).toHaveLength(1);
    expect(stored.linkedForms![0]).toMatchObject({ whenEquals: "yes", formRef: { kind: "application", id: "cos-1" }, neededBeforeReview: false });

    pick(`${PREFIX}-question-linked-form-form`, "Pet addendum");
    const moved = (onState.mock.calls.at(-1)![0] as ApplicationEditorState).slice.customApplicationFields.find((f) => f.standardKey === "household-co-signer-planned")!;
    expect(moved.linkedForms![0]!.formRef).toEqual({ kind: "move_in", id: "mif-1" });
    expect((document.querySelector(`[data-attr="${PREFIX}-question-linked-form-fee"]`) as HTMLElement).textContent).toBe("No fee");

    fireEvent.click(document.querySelector(`[data-attr="${PREFIX}-question-linked-form-needed"]`) as HTMLElement);
    const needed = (onState.mock.calls.at(-1)![0] as ApplicationEditorState).slice.customApplicationFields.find((f) => f.standardKey === "household-co-signer-planned")!;
    expect(needed.linkedForms![0]!.neededBeforeReview).toBe(true);

    fireEvent.click(document.querySelector(`[data-attr="${PREFIX}-question-done"]`) as HTMLElement);
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes("Co-signer planned"))!;
    expect(row.querySelector(`[data-attr="${PREFIX}-question-linked-forms"]`)!.textContent).toBe("Pet addendum");
  });

  it("removing the last rule stores an empty list so the co-signer link is not re-derived", () => {
    const onState = vi.fn();
    render(<Harness cosignerId="cos-1" onState={onState} />);
    openQuestion("household", "Co-signer planned");
    fireEvent.click(document.querySelector(`[data-attr="${PREFIX}-question-linked-form-remove"]`) as HTMLElement);
    const stored = (onState.mock.calls.at(-1)![0] as ApplicationEditorState).slice.customApplicationFields.find((f) => f.standardKey === "household-co-signer-planned")!;
    expect(stored.linkedForms).toEqual([]);
    expect(document.querySelector(`[data-attr="${PREFIX}-question-linked-form-rule"]`)).toBeNull();
  });

  it("a pick question offers each of its choices as the answer to wait for", () => {
    render(<Harness />);
    openQuestion("additional", "Criminal history");
    fireEvent.click(screen.getByRole("button", { name: "+ Link a form" }));
    fireEvent.click(document.querySelector(`[data-attr="${PREFIX}-question-linked-form-when"]`) as HTMLElement);
    const listbox = screen.getByRole("listbox");
    for (const label of ["Yes", "No", "Any answer"]) expect(within(listbox).getByText(label)).toBeTruthy();
  });
});
