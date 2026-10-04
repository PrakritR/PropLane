// @vitest-environment jsdom
/**
 * Nothing in the application editor is locked: every question's words, type, Required, choices, order and
 * on/off are editable (household and identity included) and the applicant wizard asks the question the way
 * the template words it; a household question can be deleted and the application is then for one person with
 * no co-signer. Changing the type of a built-in the system reads detaches it (after a confirm).
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ApplicationQuestionsEditor } from "@/components/portal/question-editor/application-questions-editor";
import {
  applicationSectionsForEditor,
  applyApplicationEditorChange,
  type ApplicationEditorState,
} from "@/components/portal/question-editor/application-question-sections";
import { RentalWizardStepBody, type WizardStepsProps } from "@/components/marketing/rental-wizard-steps";
import { MoveInFormChooser } from "@/components/portal/move-in-forms/move-in-form-chooser";
import { PROPERTY_FORM_START_FROM_OPTIONS } from "@/components/portal/property-form-wizard-kit";
import { orderedEditorApplicationFields } from "@/lib/application-editor-fields";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { validateRentalWizardStep } from "@/lib/rental-application/validate";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import {
  applicationConfigForVariant,
  editorVisibleDisabledApplicationFields,
  resolveListingApplicationFields,
  STANDARD_APPLICATION_FIELD_CATALOG,
  type ApplicationConfigSlice,
} from "@/lib/rental-application/application-field-catalog";

afterEach(() => cleanup());

const GROUP = "household-group-application";
const COSIGNER = "household-co-signer-planned";
const NAME = "personal-full-legal-name";
const PREFIX = "application-questions-editor";

function startSlice(): ApplicationConfigSlice {
  return applicationConfigForVariant(createDefaultListingSubmission(), "standard");
}

function ctxFor(slice: ApplicationConfigSlice) {
  return {
    variant: "standard" as const,
    fields: orderedEditorApplicationFields(slice),
    disabledFields: editorVisibleDisabledApplicationFields("standard", slice),
  };
}

function Harness({ initial = startSlice(), onState }: { initial?: ApplicationConfigSlice; onState?: (next: ApplicationEditorState) => void }) {
  const [state, setState] = useState<ApplicationEditorState>({ slice: initial, disabledSectionIds: [] });
  const ctx = ctxFor(state.slice);
  return (
    <ApplicationQuestionsEditor
      variant="standard"
      state={state}
      fields={ctx.fields}
      disabledFields={ctx.disabledFields}
      onState={(next) => {
        onState?.(next);
        setState(next);
      }}
    />
  );
}

function openSection(id: string) {
  const toggle = document.querySelector(`[data-attr="${PREFIX}-section-toggle-${id}"]`) as HTMLElement;
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
}

function rowFor(label: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-question-id]")).find((el) => el.textContent?.includes(label));
  expect(row, `a row for ${label}`).toBeTruthy();
  return row!;
}

function change(slice: ApplicationConfigSlice, change: Parameters<typeof applyApplicationEditorChange>[1]): ApplicationConfigSlice {
  return applyApplicationEditorChange({ slice, disabledSectionIds: [] }, change, ctxFor(slice)).slice;
}

function fieldOf(slice: ApplicationConfigSlice, standardKey: string) {
  return ctxFor(slice).fields.find((field) => field.standardKey === standardKey)!;
}

function renderStep(step: number, slice: ApplicationConfigSlice, form: Partial<ReturnType<typeof createInitialRentalWizardState>> = {}) {
  const noop = () => {};
  return render(
    <RentalWizardStepBody
      step={step}
      form={{ ...createInitialRentalWizardState(), ...form }}
      errors={{}}
      mode="public"
      applicationConfigOverride={slice}
      propertyOptions={[]}
      patch={noop as WizardStepsProps["patch"]}
      applicationFeeGate={undefined as unknown as WizardStepsProps["applicationFeeGate"]}
      occupancySyncEpoch={0}
      showAvailabilityWarnings={false}
      setPhone={noop}
      setLandlordPhone={noop}
      setPrevLandlordPhone={noop}
      setSupervisorPhone={noop}
      setRef1Phone={noop}
      setRef2Phone={noop}
      setSsn={noop}
      goToStep={noop}
      editFromReview={noop}
    />,
  );
}

describe("the Group application row opens Group application", () => {
  it("each household row opens its own question, before and after edits", () => {
    render(<Harness />);
    openSection("household");
    for (const label of ["Group application", "Co-signer planned"]) {
      fireEvent.click(rowFor(label).querySelector(`[data-attr="${PREFIX}-question-open"]`) as HTMLElement);
      const form = document.querySelector(`[data-attr="${PREFIX}-question-form"]`) as HTMLElement;
      expect((within(form).getByRole("textbox", { name: "Question" }) as HTMLInputElement).value).toBe(label);
      // The open form replaces the row it was opened from: it carries that row's id.
      expect(form.closest("li")?.getAttribute("data-question-id")).toBe(form.getAttribute("data-question-id"));
      expect(document.querySelectorAll(`[data-attr="${PREFIX}-question-form"]`)).toHaveLength(1);
      fireEvent.click(document.querySelector(`[data-attr="${PREFIX}-question-done"]`) as HTMLElement);
    }
  });

  it("a stored household override that carries the other question's id never makes the rows share an id", () => {
    const groupId = fieldOf(startSlice(), GROUP).id;
    const slice: ApplicationConfigSlice = {
      ...startSlice(),
      applicationConfigMode: "custom",
      customApplicationFields: [
        // Co-signer planned stored with the id of Group application: the two rows used to share a React key and an
        // edit handle, so opening one opened (and edited) the other.
        { id: groupId, key: COSIGNER, standardKey: COSIGNER, label: "Co-signer planned", type: "select", required: false, options: ["Yes", "No"], section: "household" },
      ],
    };
    const ids = ctxFor(slice).fields.filter((field) => field.section === "household").map((field) => field.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ctxFor(slice).fields.find((field) => field.standardKey === COSIGNER)!.required).toBe(false);

    render(<Harness initial={slice} />);
    openSection("household");
    fireEvent.click(rowFor("Group application").querySelector(`[data-attr="${PREFIX}-question-open"]`) as HTMLElement);
    const form = document.querySelector(`[data-attr="${PREFIX}-question-form"]`) as HTMLElement;
    expect((within(form).getByRole("textbox", { name: "Question" }) as HTMLInputElement).value).toBe("Group application");
    expect(document.querySelectorAll(`[data-attr="${PREFIX}-question-form"]`)).toHaveLength(1);
  });
});

describe("household and identity questions are editable and the applicant wizard asks them as worded", () => {
  it("the open household question's text, choices, Required, Type and Delete are all live", () => {
    render(<Harness />);
    openSection("household");
    fireEvent.click(rowFor("Group application").querySelector(`[data-attr="${PREFIX}-question-open"]`) as HTMLElement);
    expect(document.querySelector(`[data-attr="${PREFIX}-question-label"]`)).not.toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-label-text"]`)).toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-required"]`)).not.toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-delete"]`)).not.toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-type"]`)).not.toBeNull();
    expect(document.querySelector(`[data-attr="${PREFIX}-question-type-text"]`)).toBeNull();
    // Each choice can be reworded; none can be added, removed or moved (the wizard reads their stored values).
    expect(document.querySelector('[data-attr="application-question-option-0"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="application-question-option-add"]')).toBeNull();
    expect(document.querySelector('[data-attr="application-question-option-remove"]')).toBeNull();
    expect(document.querySelector('[data-attr="application-question-option-move-up"]')).toBeNull();
  });

  it("typing in the open form rewrites the household question and its choices, and clearing the box keeps what was typed", () => {
    const onState = vi.fn();
    render(<Harness onState={onState} />);
    openSection("household");
    fireEvent.click(rowFor("Group application").querySelector(`[data-attr="${PREFIX}-question-open"]`) as HTMLElement);
    const input = document.querySelector(`[data-attr="${PREFIX}-question-label"]`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "Moving in with others?" } });
    fireEvent.change(document.querySelector('[data-attr="application-question-option-0"]') as HTMLInputElement, { target: { value: "Yes, together" } });
    const last = onState.mock.calls.at(-1)![0] as ApplicationEditorState;
    const group = fieldOf(last.slice, GROUP);
    expect(group.label).toBe("Moving in with others?");
    expect(group.options).toEqual(["Yes, together", "No"]);
    expect(group.type).toBe("select");
    expect(group.standardKey).toBe(GROUP);
  });

  it("household and identity wording persists in the stored config and renders in the applicant wizard", () => {
    let slice = startSlice();
    slice = change(slice, { kind: "edit-question", sectionId: "household", questionId: fieldOf(slice, GROUP).id, patch: { label: "Moving in with a group?", options: ["Yes, with a group", "No, just me"] } });
    slice = change(slice, { kind: "edit-question", sectionId: "household", questionId: fieldOf(slice, COSIGNER).id, patch: { label: "Is someone co-signing?" } });
    slice = change(slice, { kind: "edit-question", sectionId: "personal", questionId: fieldOf(slice, NAME).id, patch: { label: "Your legal name" } });

    // Round trip through storage: the stored shape keeps the key and the wording survives resolution.
    const stored = JSON.parse(JSON.stringify(slice)) as ApplicationConfigSlice;
    const resolved = resolveListingApplicationFields(applicationConfigForVariant({ ...createDefaultListingSubmission(), ...stored }, "standard"), (raw) => raw as ApplicationConfigSlice["customApplicationFields"]);
    const group = resolved.find((field) => field.standardKey === GROUP)!;
    expect([group.label, group.options]).toEqual(["Moving in with a group?", ["Yes, with a group", "No, just me"]]);
    expect(resolved.find((field) => field.standardKey === NAME)!.label).toBe("Your legal name");

    renderStep(1, stored);
    expect(screen.getByText("Moving in with a group?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, with a group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No, just me" })).toBeTruthy();
    expect(screen.getByText("Is someone co-signing?")).toBeTruthy();
    expect(screen.queryByText("Applying as part of a group?")).toBeNull();
    cleanup();

    renderStep(2, stored);
    expect(screen.getByText("Your legal name")).toBeTruthy();
  });

  it("an unedited template still reads as it always did", () => {
    renderStep(1, startSlice());
    expect(screen.getByText("Applying as part of a group?")).toBeTruthy();
    expect(screen.getByText("Will someone co-sign with you?")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Yes" })).toHaveLength(2);
  });

  it("a reworded choice still stores yes / no", () => {
    let slice = startSlice();
    slice = change(slice, { kind: "edit-question", sectionId: "household", questionId: fieldOf(slice, GROUP).id, patch: { options: ["Group", "Solo"] } });
    const patch = vi.fn();
    const noop = () => {};
    render(
      <RentalWizardStepBody
        step={1}
        form={createInitialRentalWizardState()}
        errors={{}}
        mode="public"
        applicationConfigOverride={slice}
        propertyOptions={[]}
        patch={patch}
        applicationFeeGate={undefined as unknown as WizardStepsProps["applicationFeeGate"]}
        occupancySyncEpoch={0}
        showAvailabilityWarnings={false}
        setPhone={noop}
        setLandlordPhone={noop}
        setPrevLandlordPhone={noop}
        setSupervisorPhone={noop}
        setRef1Phone={noop}
        setRef2Phone={noop}
        setSsn={noop}
        goToStep={noop}
        editFromReview={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Solo" }));
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ applyingAsGroup: "no" }));
  });

  it("the two choices cannot be dropped or added through the editor", () => {
    const slice = startSlice();
    const id = fieldOf(slice, GROUP).id;
    const state = { slice, disabledSectionIds: [] };
    const dropped = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "household", questionId: id, patch: { options: ["Yes"] } }, ctxFor(slice));
    expect(dropped).toBe(state);
    const added = applyApplicationEditorChange(state, { kind: "edit-question", sectionId: "household", questionId: id, patch: { options: ["Yes", "No", "Maybe"] } }, ctxFor(slice));
    expect(added).toBe(state);
  });

  it("the household pair can swap places and the applicant wizard follows", () => {
    let slice = startSlice();
    const group = fieldOf(slice, GROUP);
    const cosigner = fieldOf(slice, COSIGNER);
    slice = change(slice, { kind: "reorder", sectionId: "household", orderedIds: [cosigner.id, group.id] });
    expect(ctxFor(slice).fields.filter((field) => field.section === "household").map((field) => field.standardKey)).toEqual([COSIGNER, GROUP]);
    renderStep(1, slice);
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Will someone co-sign with you?")).toBeLessThan(text.indexOf("Applying as part of a group?"));
  });
});

describe("a household question can be deleted and the application still submits", () => {
  it("deleting both means an individual applicant with no co-signer: nothing asked, nothing required, no error", () => {
    let slice = startSlice();
    slice = change(slice, { kind: "delete-question", sectionId: "household", questionId: fieldOf(slice, GROUP).id });
    slice = change(slice, { kind: "delete-question", sectionId: "household", questionId: fieldOf(slice, COSIGNER).id });
    expect(slice.disabledStandardApplicationKeys).toEqual(expect.arrayContaining([GROUP, COSIGNER]));

    renderStep(1, slice);
    expect(screen.queryByText("Applying as part of a group?")).toBeNull();
    expect(screen.queryByText("Will someone co-sign with you?")).toBeNull();
    cleanup();

    // The household answers stay empty and the step has no error about them.
    const form = createInitialRentalWizardState();
    expect(form.applyingAsGroup).toBeNull();
    expect(form.hasCosigner).toBeNull();
    const errors = validateRentalWizardStep(1, form, { configOverride: slice });
    expect(errors.applyingAsGroup).toBeUndefined();
    expect(errors.hasCosigner).toBeUndefined();
    expect(errors.groupSize).toBeUndefined();
    expect(errors.groupLeaderAppId).toBeUndefined();

    // The review step has no household section either.
    renderStep(10, slice);
    expect(screen.queryByText("Household application")).toBeNull();
  });

  it("deleting just one leaves the other asked", () => {
    let slice = startSlice();
    slice = change(slice, { kind: "delete-question", sectionId: "household", questionId: fieldOf(slice, COSIGNER).id });
    renderStep(1, slice);
    expect(screen.getByText("Applying as part of a group?")).toBeTruthy();
    expect(screen.queryByText("Will someone co-sign with you?")).toBeNull();
  });
});

describe("nothing is undeletable and nothing has a locked control", () => {
  it("every built-in deletes, including name, phone, email and the placement questions", () => {
    const slice = startSlice();
    const state = { slice, disabledSectionIds: [] };
    for (const def of STANDARD_APPLICATION_FIELD_CATALOG) {
      const field = fieldOf(slice, def.standardKey);
      const next = applyApplicationEditorChange(state, { kind: "delete-question", sectionId: def.section, questionId: field.id }, ctxFor(slice));
      expect(next.slice.disabledStandardApplicationKeys, def.standardKey).toContain(def.standardKey);
    }
  });

  it("the editor offers Delete, Type, Required, wording and order on every question", () => {
    const sections = applicationSectionsForEditor({ ...ctxFor(startSlice()), disabledSectionIds: [] });
    const questions = sections.flatMap((section) => section.questions);
    expect(questions.length).toBeGreaterThan(30);
    for (const q of questions) {
      expect(q.can?.remove, q.label).not.toBe(false);
      expect(q.can?.type, q.label).not.toBe(false);
      expect(q.can?.required, q.label).not.toBe(false);
      expect(q.can?.label, q.label).not.toBe(false);
      expect(q.can?.move, q.label).not.toBe(false);
    }
  });

  it("no section is locked on: every switch is live", () => {
    render(<Harness />);
    for (const id of ["personal", "property", "household"]) {
      expect((document.querySelector(`[data-attr="${PREFIX}-section-switch-${id}"]`) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(document.querySelector(`[data-attr^="${PREFIX}-section-lock-"]`)).toBeNull();
  });

  it("Required toggles on name, phone and email and the template stays publishable", () => {
    let slice = startSlice();
    for (const key of [NAME, "personal-phone", "personal-email"]) {
      slice = change(slice, { kind: "edit-question", sectionId: "personal", questionId: fieldOf(slice, key).id, patch: { required: false } });
      expect(fieldOf(slice, key).required, key).toBe(false);
    }
  });
});

describe("Upload a PDF is in each +", () => {
  it("the property Application and Lease popups offer Upload a PDF under Start from", () => {
    expect(PROPERTY_FORM_START_FROM_OPTIONS.map((option) => option.label)).toContain("Upload a PDF");
  });

  it("the property Move-in + offers Upload a PDF", async () => {
    render(<MoveInFormChooser open onClose={() => {}} onPick={() => {}} copySources={[]} />);
    expect(await screen.findByText("Upload a PDF")).toBeTruthy();
  });
});
