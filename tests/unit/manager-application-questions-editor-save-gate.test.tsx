// @vitest-environment jsdom
//
// Round 31 — the bulk Edit-application editor must NOT commit on every change. Edits stay
// local until an explicit Save; Cancel discards them; closing with pending changes prompts.
// These tests drive the real modal and assert the persist path is only ever hit on Save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const persistBulk = vi.fn(() => ({ saved: 4, failed: 0 }));

vi.mock("@/lib/manager-property-save-target", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/manager-property-save-target")>();
  return {
    ...actual,
    persistApplicationConfigToPropertyIds: (...args: unknown[]) => persistBulk(...(args as [])),
    persistManagerListingSubmission: vi.fn(() => true),
  };
});

function renderEditor() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Edit application · 4 properties"
      sub={createDefaultListingSubmission()}
      propertyIds={["p1", "p2", "p3", "p4"]}
      managerUserId="mgr-1"
      onClose={onClose}
      onSaved={onSaved}
      showToast={() => {}}
    />,
  );
  return { onSaved, onClose };
}

function expandFirstQuestionSection() {
  const toggle = document.querySelector('[data-attr^="application-section-toggle-"]') as HTMLElement | null;
  expect(toggle).not.toBeNull();
  fireEvent.click(toggle!);
}

function removeFirstQuestion() {
  expandFirstQuestionSection();
  const removeBtn = document.querySelector('[data-attr="application-question-remove"]') as HTMLElement | null;
  expect(removeBtn).not.toBeNull();
  fireEvent.click(removeBtn!);
}

beforeEach(() => {
  persistBulk.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("property application template editor — delete footer", () => {
  it("shows Delete on the left in edit mode when canDelete is true", () => {
    const onDelete = vi.fn();
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Edit application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={{
          id: "app-custom",
          kind: "long-term",
          label: "Summer intern application",
          formVariant: "standard",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }}
        templates={[
          {
            id: "app-default",
            kind: "long-term",
            label: "Long-term application",
            formVariant: "standard",
            listingSeedKey: "long-term",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "app-custom",
            kind: "long-term",
            label: "Summer intern application",
            formVariant: "standard",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ]}
        canDelete
        onDelete={onDelete}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
        onPersistSubmission={() => true}
      />,
    );

    const deleteBtn = document.querySelector('[data-attr="application-questions-delete"]') as HTMLButtonElement | null;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn?.textContent).toBe("Delete");

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(deleteBtn!);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("bulk application editor — save gate (round 31)", () => {
  it("does not persist on edit; Save is disabled until something changes", () => {
    renderEditor();
    const save = document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    removeFirstQuestion();

    // The edit changed nothing on disk.
    expect(persistBulk).not.toHaveBeenCalled();
    expect((document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("persists exactly once, across all properties, only when Save is confirmed", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onSaved, onClose } = renderEditor();

    removeFirstQuestion();
    expect(persistBulk).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('[data-attr="application-questions-save"]') as HTMLElement);

    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("4 properties"));
    expect(persistBulk).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Cancel with pending changes prompts, discards, and never persists", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onSaved, onClose } = renderEditor();

    removeFirstQuestion();

    // Footer Cancel was removed — dismiss via the header × (same save gate).
    const closeBtn = document.querySelector('button[aria-label="Close"]') as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Discard"));
    expect(persistBulk).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // Radix/Vaul Close + the button onClick both route through requestClose.
    expect(onClose).toHaveBeenCalled();
  });

  it("closing Add question only dismisses the child modal, not the application editor", () => {
    const { onClose } = renderEditor();

    const addBtn = document.querySelector('[data-attr="application-questions-add"]') as HTMLElement | null;
    expect(addBtn).not.toBeNull();
    fireEvent.click(addBtn!);

    expect(screen.getByRole("heading", { name: "Add question" })).toBeTruthy();

    const closeButtons = Array.from(document.querySelectorAll('button[aria-label="Close"]'));
    expect(closeButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(closeButtons[closeButtons.length - 1]!);

    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-attr="application-questions-save"]')).toBeTruthy();
  });
});
