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
import { STANDARD_APPLICATION_FIELD_CATALOG } from "@/lib/rental-application/application-field-catalog";

const persistOnServer = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persistOnServer(...args),
}));

function renderEditor(sub: ManagerListingSubmissionV1 = createDefaultListingSubmission()) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Application"
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
      managerUserId="mgr-1"
      onClose={onClose}
      onSaved={onSaved}
      showToast={() => {}}
    />,
  );
  return { onSaved, onClose };
}

function expandHouseholdSection() {
  const toggle = document.querySelector('[data-attr="application-section-toggle-household"]') as HTMLElement | null;
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
}

function expandFirstQuestion() {
  const toggle = document.querySelector('[data-attr^="application-question-edit-"]') as HTMLElement | null;
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
  return toggle!;
}

function saveButton(): HTMLButtonElement {
  return document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement;
}

beforeEach(() => {
  persistOnServer.mockReset();
  persistOnServer.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("in-place expanding rows", () => {
  it("expands a question in place with no per-question modal, and persists nothing while editing", () => {
    renderEditor();
    expandHouseholdSection();
    expandFirstQuestion();

    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement | null;
    expect(labelInput).not.toBeNull();

    // The retired per-question modal is never rendered.
    expect(screen.queryByRole("heading", { name: "Edit question" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Add question" })).toBeNull();

    fireEvent.change(labelInput!, { target: { value: "Group application (edited)" } });
    expect(labelInput!.value).toBe("Group application (edited)");

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

  it("moves a custom question with the ⋯ menu; a built-in offers no move control", async () => {
    renderEditor(subWithTwoCustomQuestions());
    const toggle = document.querySelector('[data-attr="application-section-toggle-additional"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);

    // Built-in fields (e.g. "Number of occupants" in Additional details) never get a reorder trigger.
    expect(screen.queryByRole("button", { name: /^Reorder Number of occupants/ })).toBeNull();

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
});

describe("option rows", () => {
  it("an option containing a comma survives a save round trip", async () => {
    const { onSaved } = renderEditor();
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

describe("Edit / Preview toggle", () => {
  function editToggle(): HTMLElement {
    return document.querySelector('[data-attr="application-preview-toggle-edit"]') as HTMLElement;
  }
  function previewToggle(): HTMLElement {
    return document.querySelector('[data-attr="application-preview-toggle-preview"]') as HTMLElement;
  }
  function previewPane(): HTMLElement | null {
    return document.querySelector('[data-attr="application-preview-pane"]');
  }

  it("toggling to Preview renders the open section's questions through the real applicant control, and toggling back returns to editing", () => {
    renderEditor();
    expandHouseholdSection();

    // Edit is the default view — no preview pane mounted yet.
    expect(editToggle().getAttribute("aria-selected")).toBe("true");
    expect(previewToggle().getAttribute("aria-selected")).toBe("false");
    expect(previewPane()).toBeNull();

    fireEvent.click(previewToggle());

    expect(previewToggle().getAttribute("aria-selected")).toBe("true");
    const pane = previewPane();
    expect(pane).not.toBeNull();
    // The open section (household) and its two built-in questions, through the
    // real applicant control.
    expect(within(pane!).getByText("Household application")).toBeTruthy();
    expect(within(pane!).getByText("Group application")).toBeTruthy();
    expect(within(pane!).getByText("Co-signer planned")).toBeTruthy();
    // The REAL applicant control, wrapped read-only — never a hand-drawn imitation.
    expect(pane!.querySelector("[inert]")).not.toBeNull();
    // Read-only preview never persists.
    expect(persistOnServer).not.toHaveBeenCalled();

    fireEvent.click(editToggle());

    expect(editToggle().getAttribute("aria-selected")).toBe("true");
    expect(previewToggle().getAttribute("aria-selected")).toBe("false");
    expect(previewPane()).toBeNull();
    expect(persistOnServer).not.toHaveBeenCalled();
  });

  it("reflects an UNSAVED edit — proving the pane reads the live buffered draft, not saved data", () => {
    renderEditor();
    expandHouseholdSection();
    expandFirstQuestion();

    const labelInput = document.querySelector('[data-attr="application-question-label"]') as HTMLInputElement;
    fireEvent.change(labelInput, { target: { value: "Group application (edited)" } });

    fireEvent.click(previewToggle());
    const pane = previewPane()!;
    expect(within(pane).getByText("Group application (edited)")).toBeTruthy();
    expect(within(pane).queryByText("Group application")).toBeNull();
    expect(persistOnServer).not.toHaveBeenCalled();
  });

  it("a section with no questions shows the empty state", () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      disabledStandardApplicationKeys: STANDARD_APPLICATION_FIELD_CATALOG.map((def) => def.standardKey),
      customApplicationFields: [],
    };
    renderEditor(sub);

    fireEvent.click(previewToggle());
    const pane = previewPane()!;
    expect(within(pane).getByText("No questions in this section yet.")).toBeTruthy();
    expect(pane.querySelector("[inert]")).toBeNull();
  });

  it("a question with a blank label and an empty option row renders without throwing", () => {
    const sub: ManagerListingSubmissionV1 = {
      ...createDefaultListingSubmission(),
      applicationConfigMode: "custom",
      customApplicationFields: [
        { id: "blank1", key: "", label: "", type: "select", required: false, options: [""], section: "additional" },
      ],
    };
    renderEditor(sub);
    const additionalToggle = document.querySelector(
      '[data-attr="application-section-toggle-additional"]',
    ) as HTMLElement;
    fireEvent.click(additionalToggle);

    expect(() => fireEvent.click(previewToggle())).not.toThrow();
    const pane = previewPane()!;
    expect(within(pane).getByText("Untitled question")).toBeTruthy();
    expect(persistOnServer).not.toHaveBeenCalled();
  });
});
