// @vitest-environment jsdom
//
// The manager application-question builder is now one full-page workspace
// with in-place expanding rows (replacing the old three-modal stack: an
// editor modal opening a per-question modal over a property panel). These
// tests cover the new in-place-edit, reorder, option-row, and question-pack
// behaviour. The pre-existing save-gate / discard / server-confirmed-save
// contract is covered unchanged by manager-application-questions-editor-save-gate.test.tsx
// and application-question-save-confirmation.test.tsx (both still pass with
// zero edits against this redesign).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { applicationConfigForVariant, resolveListingApplicationFields, STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";
import { CustomQuestionField } from "@/components/rental-application/custom-question-field";
import { applicationDraftReviewFingerprint, createPropertyApplicationTemplate } from "@/lib/property-application-templates";

const persistOnServer = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persistOnServer(...args),
}));

function renderEditor(sub: ManagerListingSubmissionV1 = createDefaultListingSubmission(), initialVariant: "standard" | "short_term" | "cosigner" = "standard") {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Application"
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
      managerUserId="mgr-1"
      initialVariant={initialVariant}
      onClose={onClose}
      onSaved={onSaved}
      showToast={() => {}}
    />,
  );
  return { onSaved, onClose };
}

async function waitWorkspace(title = "Application") {
  await screen.findByRole("dialog", { name: title });
}

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

function expandHouseholdSection() {
  jumpRail("household");
}

function expandFirstQuestion() {
  const toggle = document.querySelector('[data-attr^="application-question-edit-"]') as HTMLElement | null;
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
  return toggle!;
}

function saveButton(): HTMLButtonElement {
  jumpRail("preview");
  const save = document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement;
  expect(save).not.toBeNull();
  return save;
}

beforeEach(() => {
  persistOnServer.mockReset();
  persistOnServer.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("in-place expanding rows", () => {
  it("keeps the current step and unsaved question edits when the parent refreshes submission props", async () => {
    const base = createDefaultListingSubmission();
    const props = { open: true, title: "Application", saveTarget: { mode: "listing" as const, saveId: "mgr-house-1" }, managerUserId: "mgr-1", onClose: vi.fn(), onSaved: vi.fn(), showToast: vi.fn() };
    const view = render(<ManagerApplicationQuestionsEditorModal {...props} sub={base} />);
    await waitWorkspace();
    jumpRail("personal");
    expandFirstQuestion();
    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "My custom personal label" } });
    view.rerender(<ManagerApplicationQuestionsEditorModal {...props} sub={{ ...base }} />);
    expect((document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement).value).toBe("My custom personal label");
    expect(screen.getByRole("heading", { name: "Personal information", level: 2 })).toBeTruthy();
  });

  it("expands a question in place with no per-question modal, and persists nothing while editing", async () => {
    renderEditor();
    await waitWorkspace();
    jumpRail("personal");
    expandFirstQuestion();

    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement | null;
    expect(labelInput).not.toBeNull();

    // The retired per-question modal is never rendered.
    expect(screen.queryByRole("heading", { name: "Edit question" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Add question" })).toBeNull();

    fireEvent.change(labelInput!, { target: { value: "Legal name (edited)" } });
    expect(labelInput!.value).toBe("Legal name (edited)");

    // Nothing is persisted until the top-level Save — the buffered-draft contract.
    expect(persistOnServer).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(false);
  });
});

describe("⋯ reorder menu", () => {
  function subWithTwoCustomQuestions(): ManagerListingSubmissionV1 {
    return {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      customApplicationFields: [
        { id: "c1", key: "pet-name", label: "Pet name", type: "text", required: false, options: [], section: "additional" },
        { id: "c2", key: "pet-breed", label: "Pet breed", type: "text", required: false, options: [], section: "additional" },
      ],
    };
  }

  it("moves a custom question with the ⋯ menu", async () => {
    renderEditor(subWithTwoCustomQuestions());
    await waitWorkspace();
    jumpRail("additional");

    const orderedIds = () =>
      Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
        .map((el) => el.getAttribute("data-attr")!.replace("application-question-edit-", ""))
        .filter((id) => id === "c1" || id === "c2");

    expect(orderedIds()).toEqual(["c1", "c2"]);

    const trigger = await screen.findByRole("button", { name: "Reorder Pet name" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const moveDown = await screen.findByRole("menuitem", { name: "Move down" });
    fireEvent.click(moveDown);

    await waitFor(() => expect(orderedIds()).toEqual(["c2", "c1"]));
  });

  it("moves built-in questions within their section", async () => {
    renderEditor(createDefaultListingSubmission());
    await waitWorkspace();
    jumpRail("additional");

    const orderedIds = () =>
      Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
        .map((el) => el.getAttribute("data-attr")!.replace("application-question-edit-", ""));
    const before = orderedIds();
    const trigger = await screen.findByRole("button", { name: /^Reorder Number of occupants/ });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));

    await waitFor(() => {
      const after = orderedIds();
      expect(after[0]).toBe(before[1]);
      expect(after[1]).toBe(before[0]);
    });
  });

  it("allows a nonstructural built-in move inside a composite section", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [],
    };
    renderEditor(sub);
    await waitWorkspace();
    jumpRail("employment");

    const orderedLabels = () =>
      Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
        .map((el) => el.textContent ?? "");
    const employer = await screen.findByRole("button", { name: /^Reorder Employer & employer address/ });
    const before = orderedLabels();
    const employerIndex = before.findIndex((label) => label.includes("Employer & employer address"));
    const nextLabel = before[employerIndex + 1];
    const nextIndex = nextLabel ? before.indexOf(nextLabel) : -1;
    expect(employerIndex).toBeGreaterThanOrEqual(0);
    expect(nextIndex).toBe(employerIndex + 1);

    fireEvent.keyDown(employer, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    await waitFor(() => {
      const after = orderedLabels();
      expect(after[employerIndex]).toBe(nextLabel);
      expect(after[employerIndex + 1]).toBe(before[employerIndex]);
    });
  });

  it("keeps a built-in's typed control fixed while allowing its label and required setting", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      customApplicationFields: [],
    };
    renderEditor(sub);
    await waitWorkspace();
    jumpRail("employment");
    const employerRow = Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
      .find((row) => row.textContent?.includes("Employer & employer address"));
    expect(employerRow).toBeDefined();
    fireEvent.click(employerRow as HTMLElement);

    const typeControl = document.querySelector('[data-attr="application-question-type"]') as HTMLButtonElement | null;
    const labelControl = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement | null;
    const requiredControl = document.querySelector('[data-attr="application-question-required"]') as HTMLInputElement | null;
    expect(typeControl).not.toBeNull();
    expect(typeControl).toBeDisabled();
    expect(labelControl).not.toBeNull();
    expect(labelControl).not.toBeDisabled();
    expect(requiredControl).not.toBeNull();
    expect(requiredControl).not.toBeDisabled();
  });

  it("uses one saved order to interleave a custom question with built-ins", async () => {
    const occupantsKey = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Number of occupants")!.standardKey;
    const petsKey = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Pets")!.standardKey;
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: STANDARD_APPLICATION_FIELD_CATALOG
        .filter((field) => ![occupantsKey, petsKey].includes(field.standardKey))
        .map((field) => field.standardKey),
      customApplicationFields: [
        { id: "custom-pets", key: "pet-name", label: "Pet name", type: "text", required: false, options: [], section: "additional" },
      ],
    };
    renderEditor(sub);
    await waitWorkspace();
    jumpRail("additional");

    const rowIds = () =>
      Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
        .map((el) => el.getAttribute("data-attr")!.replace("application-question-edit-", ""))
        .filter((id) => [`std-${occupantsKey}`, "custom-pets", `std-${petsKey}`].includes(id));
    expect(rowIds()).toEqual([`std-${occupantsKey}`, `std-${petsKey}`, "custom-pets"]);
    const trigger = await screen.findByRole("button", { name: "Reorder Pet name" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }));
    await waitFor(() => expect(rowIds()).toEqual([`std-${occupantsKey}`, "custom-pets", `std-${petsKey}`]));
    expect(screen.queryByText("Your questions appear after PropLane's.")).toBeNull();
  });

  it("keeps custom questions after typed fields in structurally bound sections", async () => {
    const propertyKey = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Property")!.standardKey;
    const roomKey = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label.startsWith("Room choices"))!.standardKey;
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: [],
      questionDisplayOrder: ["property-custom", `std-${propertyKey}`, `std-${roomKey}`],
      customApplicationFields: [
        { id: "property-custom", key: "move-in-note", label: "Move-in note", type: "text", required: false, options: [], section: "property" },
      ],
    };
    renderEditor(sub);
    await waitWorkspace();
    jumpRail("property");
    const rowIds = () =>
      Array.from(document.querySelectorAll('[data-attr^="application-question-edit-"]'))
        .map((el) => el.getAttribute("data-attr")!.replace("application-question-edit-", ""))
        .filter((id) => ["property-custom", `std-${propertyKey}`, `std-${roomKey}`].includes(id));
    expect(rowIds()).toEqual([`std-${propertyKey}`, `std-${roomKey}`, "property-custom"]);
  });
});

describe("built-in controls that match the applicant form", () => {
  it("keeps structural household labels and order fixed while preserving supported visibility", async () => {
    renderEditor();
    await waitWorkspace();
    jumpRail("household");
    expandFirstQuestion();
    expect(document.querySelector('[data-attr="application-question-label"]')).toBeDisabled();
    expect(document.querySelector('[data-attr^="application-question-option-"]')).toBeNull();
    expect(screen.getByText("Yes", { exact: true })).toBeTruthy();
    expect(screen.getByText("No", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Reorder Group application/ })).toBeNull();
    expect(document.querySelector('[data-attr="application-question-remove"]')).not.toBeNull();
  });

  it("locks structural built-in choices and normalizes legacy choice overrides for the applicant control", async () => {
    const occupants = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Number of occupants")!;
    const group = STANDARD_APPLICATION_FIELD_CATALOG.find((field) => field.label === "Group application")!;
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      customApplicationFields: [
        { id: "override-occupants", key: occupants.standardKey, standardKey: occupants.standardKey, label: occupants.label, type: "select", required: true, options: ["6", "7"] },
        { id: "override-group", key: group.standardKey, standardKey: group.standardKey, label: group.label, type: "select", required: true, options: ["Maybe"] },
      ],
    };

    const config = applicationConfigForVariant(sub, "standard");
    expect(config.customApplicationFields.find((field) => field.standardKey === occupants.standardKey)?.options).toEqual(["1", "2", "3", "4", "5"]);
    expect(config.customApplicationFields.find((field) => field.standardKey === group.standardKey)?.options).toEqual(["Yes", "No"]);
    const resolved = resolveListingApplicationFields(config, (raw) => raw as typeof config.customApplicationFields);
    const resolvedOccupants = resolved.find((field) => field.standardKey === occupants.standardKey)!;
    const resolvedGroup = resolved.find((field) => field.standardKey === group.standardKey)!;
    expect(resolvedOccupants.options).toEqual(["1", "2", "3", "4", "5"]);
    expect(resolvedGroup.options).toEqual(["Yes", "No"]);

    const control = render(<CustomQuestionField field={resolvedOccupants} value="" onChange={() => {}} />);
    fireEvent.click(control.getByRole("button", { name: "Select" }));
    const listbox = screen.getByRole("listbox");
    expect(within(listbox).queryByText("6", { exact: true })).toBeNull();
    expect(within(listbox).getByText("5", { exact: true })).toBeTruthy();
  });

  it("freezes co-signer built-ins except identity labels and date/SSN controls", async () => {
    const sub = { ...createDefaultListingSubmission(), cosignerApplicationConfigMode: "custom" as const, cosignerDisabledStandardApplicationKeys: [] };
    renderEditor(sub, "cosigner");
    await waitWorkspace();
    jumpRail("personal");
    const nameRow = document.querySelector('[data-attr="application-question-edit-std-personal-full-legal-name"]') as HTMLElement;
    fireEvent.click(nameRow);
    expect(document.querySelector('[data-attr="application-question-label"]')).not.toBeDisabled();
    expect(document.querySelector('[data-attr="application-question-required"]')).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Reorder Full legal name/ })).toBeNull();
    expect(nameRow.parentElement?.querySelector('[data-attr="application-question-remove"]')).toBeNull();
    fireEvent.click(nameRow);
    const dobRow = document.querySelector('[data-attr="application-question-edit-std-personal-date-of-birth"]') as HTMLElement;
    fireEvent.click(dobRow);
    expect(document.querySelector('[data-attr="application-question-label"]')).not.toBeDisabled();
    expect(document.querySelector('[data-attr="application-question-required"]')).not.toBeDisabled();
    expect(document.querySelector('[data-attr="application-question-remove"]')).not.toBeNull();
    jumpRail("employment");
    const employerRow = document.querySelector('[data-attr="application-question-edit-std-employment-employer-employer-address"]') as HTMLElement;
    fireEvent.click(employerRow);
    expect(document.querySelector('[data-attr="application-question-label"]')).toBeDisabled();
    expect(document.querySelector('[data-attr="application-question-required"]')).toBeDisabled();
    expect(employerRow.parentElement?.querySelector('[data-attr="application-question-remove"]')).toBeNull();
  });

  it("omits file and photo types from co-signer authoring while keeping supported types editable", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      cosignerApplicationConfigMode: "custom",
      cosignerDisabledStandardApplicationKeys: [],
      cosignerCustomApplicationFields: [
        { id: "cosigner-note", key: "cosigner-note", label: "Additional note", type: "text", required: false, options: [], section: "household" },
      ],
    };
    renderEditor(sub, "cosigner");
    await waitWorkspace();
    jumpRail("household");
    fireEvent.click(document.querySelector('[data-attr="application-question-edit-cosigner-note"]') as HTMLElement);
    const typeControl = document.querySelector('[data-attr="application-question-type"]') as HTMLElement;
    expect(typeControl).not.toBeDisabled();
    fireEvent.click(typeControl);
    const typeListbox = screen.getByRole("listbox");
    expect(within(typeListbox).getByText("Dropdown")).toBeTruthy();
    expect(within(typeListbox).getByText("Multi-select")).toBeTruthy();
    expect(within(typeListbox).queryByText("File")).toBeNull();
    expect(within(typeListbox).queryByText("Photos")).toBeNull();
  });
});

describe("option rows", () => {
  it("an option containing a comma survives a save round trip", async () => {
    const { onSaved } = renderEditor();
    await waitWorkspace();
    expandHouseholdSection();

    fireEvent.click(document.querySelector('[data-attr="application-questions-add"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-attr="application-question-add-choice-blank"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-attr="application-questions-add-confirm"]') as HTMLElement);

    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement | null;
    expect(labelInput).not.toBeNull();
    fireEvent.change(labelInput!, { target: { value: "City" } });

    // `Select` renders a custom listbox (FieldSingleSelect), not a native <select> —
    // open it and tap the "Dropdown" (select-type) option.
    const typeTrigger = document.querySelector('[data-attr="application-question-type"]') as HTMLElement | null;
    expect(typeTrigger).not.toBeNull();
    fireEvent.click(typeTrigger!);
    const typeListbox = screen.getByRole("listbox");
    const dropdownOption = within(typeListbox).getByText("Dropdown");
    fireEvent.pointerDown(dropdownOption, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(dropdownOption, { pointerId: 1, clientX: 10, clientY: 10 });

    fireEvent.click(document.querySelector('[data-attr="application-question-option-add"]') as HTMLElement);
    const optionInput = document.querySelector('[data-attr="application-question-option-0"]') as HTMLInputElement | null;
    expect(optionInput).not.toBeNull();
    fireEvent.change(optionInput!, { target: { value: "New York, NY" } });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const persistedNext = persistOnServer.mock.calls[0]?.[2] as ManagerListingSubmissionV1;
    const saved = (persistedNext.customApplicationFields ?? []).find((f) => f.label === "City");
    expect(saved?.options).toEqual(["New York, NY"]);
  });
});

describe("question packs", () => {
  it("adding a pack mints keys unique against every existing question key", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      // Pre-seed a key collision with the "Emergency contact" pack's own first question.
      customApplicationFields: [
        {
          id: "existing1",
          key: "emergency-contact-full-name",
          label: "Existing question",
          type: "text",
          required: false,
          options: [],
          section: "additional",
        },
      ],
    };
    renderEditor(sub);
    await waitWorkspace();
    expandHouseholdSection();

    fireEvent.click(document.querySelector('[data-attr="application-questions-add"]') as HTMLElement);
    // "Emergency contact" is the recommended pack — preselected by default.
    const recommendedRadio = document.querySelector(
      '[data-attr="application-question-add-choice-emergency-contact"]',
    ) as HTMLInputElement | null;
    expect(recommendedRadio?.checked).toBe(true);
    fireEvent.click(document.querySelector('[data-attr="application-questions-add-confirm"]') as HTMLElement);

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(persistOnServer).toHaveBeenCalledTimes(1));
    const persistedNext = persistOnServer.mock.calls[0]?.[2] as ManagerListingSubmissionV1;
    const keys = (persistedNext.customApplicationFields ?? []).map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k === "emergency-contact-full-name").length).toBe(1);
  });
});

describe("Preview step", () => {
  function previewPane(): HTMLElement | null {
    return document.querySelector('[data-attr="application-preview-pane"]');
  }

  it("jumping to Preview renders the open section's questions through the real applicant control, and jumping back returns to editing", async () => {
    renderEditor();
    await waitWorkspace();
    expandHouseholdSection();

    expect(document.querySelector('[data-attr="application-preview-section"]')).toBeNull();
    expect(document.querySelector('[data-attr="application-questions-save"]')).toBeNull();

    jumpRail("preview");

    expect(document.querySelector('[data-attr="application-preview-section"]')).not.toBeNull();
    const pane = previewPane();
    expect(pane).not.toBeNull();
    expect(within(pane!).getByText("Household application")).toBeTruthy();
    expect(within(pane!).getByText("Group application")).toBeTruthy();
    expect(within(pane!).getByText("Co-signer planned")).toBeTruthy();
    expect(pane!.querySelector("[inert]")).not.toBeNull();
    expect(persistOnServer).not.toHaveBeenCalled();

    jumpRail("household");

    expect(document.querySelector('[data-attr="application-preview-section"]')).toBeNull();
    expect(document.querySelector('[data-attr^="application-question-edit-"]')).not.toBeNull();
    expect(persistOnServer).not.toHaveBeenCalled();
  });

  it("reflects an UNSAVED edit — proving the pane reads the live buffered draft, not saved data", async () => {
    renderEditor();
    await waitWorkspace();
    jumpRail("personal");
    expandFirstQuestion();

    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Legal name (edited)" } });

    jumpRail("preview");
    const pane = previewPane()!;
    expect(within(pane).getByText("Legal name (edited)")).toBeTruthy();
    expect(within(pane).queryByText("Full legal name")).toBeNull();
    expect(persistOnServer).not.toHaveBeenCalled();
  });

  it("keeps required identity questions visible after optional fields are disabled", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: STANDARD_APPLICATION_FIELD_CATALOG.map((def) => def.standardKey),
      customApplicationFields: [],
    };
    renderEditor(sub);
    await waitWorkspace();

    jumpRail("preview");
    const pane = previewPane()!;
    expect(within(pane).getByText("Full legal name")).toBeTruthy();
    expect(within(pane).getByText("Phone")).toBeTruthy();
    expect(within(pane).getByText("Email")).toBeTruthy();
    expect(pane.querySelector("[inert]")).not.toBeNull();
  });

  it("a question with a blank label and an empty option row renders without throwing", async () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      customApplicationFields: [
        { id: "blank1", key: "", label: "", type: "select", required: false, options: [""], section: "additional" },
      ],
    };
    renderEditor(sub);
    await waitWorkspace();
    jumpRail("additional");

    expect(() => jumpRail("preview")).not.toThrow();
    const pane = previewPane()!;
    expect(within(pane).getByText("Untitled question")).toBeTruthy();
    expect(persistOnServer).not.toHaveBeenCalled();
  });
});

describe("server reviewed application publishing", () => {
  it("keeps property-specific PDF review and publishing out of bulk editing", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="manager-1"
        propertyIds={["mgr-house-1", "mgr-house-2"]}
        applicationPreviewPropertyId="mgr-house-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template]}
        onPersistSubmission={vi.fn().mockResolvedValue(true)}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();
    jumpRail("preview");
    expect(screen.queryByRole("button", { name: "Import PDF" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish application" })).toBeNull();
  });

  it("saves the draft, records explicit source review, then publishes with a version check", async () => {
    const sourceDraft = {
      disabledStandardApplicationKeys: [],
      customApplicationFields: [],
      applicationConfigMode: "custom" as const,
      questionDisplayOrder: STANDARD_APPLICATION_FIELD_CATALOG.map((field) => `std-${field.standardKey}`),
      version: 1,
      importProvenance: { sourcePath: "manager/application-import/template/original.pdf", sourceSha256: "a".repeat(64), unresolvedCount: 0 },
    };
    const template = {
      id: "imported-template",
      kind: "long-term" as const,
      formVariant: "standard" as const,
      label: "Imported form",
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      draftQuestionConfig: sourceDraft,
    };
    const persist = vi.fn().mockResolvedValue(true);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const savedSubmission = persist.mock.calls.at(-1)?.[0] as ManagerListingSubmissionV1 | undefined;
      const savedTemplate = savedSubmission?.propertyApplicationTemplates?.find((item) => item.id === template.id) ?? template;
      const savedDraft = savedTemplate.draftQuestionConfig ?? sourceDraft;
      const reviewedDraft = {
        ...savedDraft,
        importProvenance: {
          ...savedDraft.importProvenance!,
          reviewedByUserId: "manager-1",
          reviewedAt: "2026-09-24T00:01:00.000Z",
          reviewedDraftFingerprint: applicationDraftReviewFingerprint(savedDraft),
        },
      };
      const responseBody = String(_input).includes("meta=1")
        ? { draftFingerprint: applicationDraftReviewFingerprint(savedDraft), revision: "2026-09-24T00:00:00Z" }
        : init?.method === "PUT"
        ? { draft: reviewedDraft }
        : { version: 1, template: { ...savedTemplate, draftQuestionConfig: reviewedDraft, publishedQuestionConfig: { ...reviewedDraft, version: 1 } } };
      return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Imported form"
        sub={createDefaultListingSubmission()}
        managerUserId="manager-1"
        applicationPreviewPropertyId="mgr-house-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template]}
        onPersistSubmission={persist}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace("Imported form");
    jumpRail("preview");
    fireEvent.click(await screen.findByRole("button", { name: "Compare and confirm PDF" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(true));
    const reviewCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(reviewCall?.[1]?.body))).toMatchObject({
      propertyId: "mgr-house-1",
      templateId: template.id,
      sourceSha256: "a".repeat(64),
      draftFingerprint: expect.any(String),
      expectedRevision: "2026-09-24T00:00:00Z",
    });

    fireEvent.click(screen.getByRole("button", { name: "Publish application" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const publishCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(publishCall?.[1]?.body))).toMatchObject({
      propertyId: "mgr-house-1",
      templateId: template.id,
      expectedPublishedVersion: 0,
    });
    expect(persist).toHaveBeenCalled();
  });
});
