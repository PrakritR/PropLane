// @vitest-environment jsdom
//
// The application-questions editor used to persist through a fire-and-forget
// mirror write: `persistManagerListingSubmission` wrote localStorage and
// kicked off an unawaited network mirror, then always returned true. A server
// refusal (403 property limit, 401, 500) was invisible — the editor showed a
// success toast and closed while the server kept the old questions, and the
// edit was gone on reload. The fix routes application-question saves through
// the server-confirmed persist (`persistManagerListingSubmissionOnServer`)
// and only treats the save as successful when it resolves true.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const persistOnServer = vi.fn<
  (...args: unknown[]) => Promise<boolean>
>();

vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persistOnServer(...args),
}));

function renderEditor() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Edit application"
      sub={createDefaultListingSubmission()}
      saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
      managerUserId="mgr-1"
      onClose={onClose}
      onSaved={onSaved}
      showToast={() => {}}
    />,
  );
  return { onSaved, onClose };
}

async function waitWorkspace() {
  await screen.findByRole("dialog", { name: "Edit application" });
}

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

function expandFirstQuestionSection() {
  jumpRail("household");
}

function removeFirstQuestion() {
  expandFirstQuestionSection();
  const removeBtn = document.querySelector('[data-attr="application-question-remove"]') as HTMLElement | null;
  expect(removeBtn).not.toBeNull();
  fireEvent.click(removeBtn!);
}

function saveButton(): HTMLButtonElement {
  jumpRail("preview");
  const save = document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement;
  expect(save).not.toBeNull();
  return save;
}

beforeEach(() => {
  persistOnServer.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("application-question editor — server-confirmed save", () => {
  it("does not close or report success when the server refuses the save", async () => {
    persistOnServer.mockResolvedValue(false);
    const { onSaved, onClose } = renderEditor();
    await waitWorkspace();

    removeFirstQuestion();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    await waitFor(() => expect(persistOnServer).toHaveBeenCalledTimes(1));

    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(document.querySelector('[data-attr="application-questions-save-error"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-attr="application-questions-save-error"]')?.textContent).toMatch(
      /could not save/i,
    );

    // The form is still dirty — Save stays enabled so the manager can retry.
    expect(saveButton().disabled).toBe(false);
  });

  it("closes and reports success only after the server confirms the save", async () => {
    persistOnServer.mockResolvedValue(true);
    const { onSaved, onClose } = renderEditor();
    await waitWorkspace();

    removeFirstQuestion();
    fireEvent.click(saveButton());

    await waitFor(() => expect(persistOnServer).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);

    expect(document.querySelector('[data-attr="application-questions-save-error"]')).toBeNull();
  });
});
