// @vitest-environment jsdom
//
// The "Workspace form" / "Custom for this listing" picker
// (`applicationFormSourcePicker` in `pro-application-questions-editor-modal.tsx`)
// was unreachable dead code: the ONLY real call site
// (`pro-property-application-questions-panel.tsx`) always opens this modal
// with a `templateEditorMode`, and the picker used to render only when
// `!isTemplateEditor`. These tests render with `templateEditorMode="edit"` —
// the real-world shape — to prove the picker is actually reachable and that
// switching it copies the workspace form onto the listing once, and back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { WorkspaceApplicationFormTemplate } from "@/lib/rental-application/workspace-application-form";

const persistOnServer = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock("@/lib/manager-property-save-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-property-save-target")>()),
  persistManagerListingSubmissionOnServer: (...args: unknown[]) => persistOnServer(...args),
}));

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const WORKSPACE_TEMPLATE: WorkspaceApplicationFormTemplate = {
  customApplicationFields: [
    { id: "ws-gate", key: "pets", label: "Do you have pets?", type: "yes_no", required: true, options: [], section: "additional" },
  ],
  disabledStandardApplicationKeys: [],
  applicationConfigMode: "custom",
  shortTermCustomApplicationFields: [
    { id: "ws-gate", key: "pets", label: "Do you have pets?", type: "yes_no", required: true, options: [], section: "additional" },
  ],
  shortTermDisabledStandardApplicationKeys: [],
  shortTermApplicationConfigMode: "custom",
  cosignerCustomApplicationFields: [
    { id: "ws-gate", key: "pets", label: "Do you have pets?", type: "yes_no", required: true, options: [], section: "additional" },
  ],
  cosignerDisabledStandardApplicationKeys: [],
  cosignerApplicationConfigMode: "custom",
  shareAcrossVariants: true,
};

const TEMPLATE: PropertyApplicationTemplate = {
  id: "app-tpl-1",
  kind: "long-term",
  label: "Long-term application",
  formVariant: "standard",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderTemplateEditor(sub: ManagerListingSubmissionV1 = createDefaultListingSubmission()) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Edit application"
      sub={sub}
      saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
      managerUserId="mgr-1"
      initialVariant="standard"
      lockVariant
      templateEditorMode="edit"
      applicationTemplate={TEMPLATE}
      templates={[TEMPLATE]}
      onPersistSubmission={async () => true}
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

function picker(): HTMLElement {
  return screen.getByRole("button", { name: "Application form" });
}

async function pickOption(label: string) {
  // The menu's own close (from a previous pick) can still be settling —
  // wait for any stale listbox to clear before opening a fresh one, or a
  // rapid second pick can toggle open-then-immediately-closed.
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  fireEvent.click(picker());
  const listbox = await screen.findByRole("listbox");
  const option = within(listbox).getByText(label);
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

beforeEach(() => {
  persistOnServer.mockReset();
  persistOnServer.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ template: WORKSPACE_TEMPLATE, workspaceId: "ws-1", configured: true })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Workspace form / Custom for this listing picker (templateEditorMode='edit', the real call shape)", () => {
  it("is reachable and defaults to 'Workspace form' for a listing that never set applicationFormSource", async () => {
    renderTemplateEditor();
    await waitWorkspace();

    // The real Applications tab always opens this modal in templateEditorMode,
    // landing on the "Name" step first — the picker must show there.
    await waitFor(() => expect(picker()).toBeTruthy());
    expect(picker().textContent).toContain("Workspace form");
    expect(picker().textContent).not.toContain("not set up yet");
  });

  it("switching to 'Custom for this listing' copies the workspace form onto the listing and stays editable", async () => {
    renderTemplateEditor();
    await waitWorkspace();
    await waitFor(() => expect(picker()).toBeTruthy());

    await pickOption("Custom for this listing");

    await waitFor(() => expect(picker().textContent).toContain("Custom for this listing"));

    // Jump to the section holding the copied question and confirm it renders
    // the EDITABLE builder (a real question card), not the read-only summary.
    const rail = document.querySelector('[data-attr="listing-v2-rail-additional"]') as HTMLElement | null;
    expect(rail).not.toBeNull();
    fireEvent.click(rail!);

    // No read-only "Following the workspace application form" notice once switched.
    await waitFor(() => expect(screen.queryByText(/Following the workspace application form/i)).toBeNull());

    // Expand the copied question's card (same id it had on the workspace
    // template — proving it was actually copied, not re-created) and confirm
    // it's a real, editable label input pre-filled with the copied question.
    const toggle = document.querySelector('[data-attr="application-question-edit-ws-gate"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const labelInput = await screen.findByDisplayValue("Do you have pets?");
    expect(labelInput.getAttribute("data-attr")).toBe("application-question-label");
  });

  it("switching back to 'Workspace form' returns to the read-only workspace preview", async () => {
    renderTemplateEditor();
    await waitWorkspace();
    await waitFor(() => expect(picker()).toBeTruthy());

    await pickOption("Custom for this listing");
    await waitFor(() => expect(picker().textContent).toContain("Custom for this listing"));

    await pickOption("Workspace form");
    await waitFor(() => expect(picker().textContent).toContain("Workspace form"));

    const rail = document.querySelector('[data-attr="listing-v2-rail-additional"]') as HTMLElement | null;
    fireEvent.click(rail!);

    await waitFor(() => {
      expect(screen.queryByText(/Following the workspace application form/i)).not.toBeNull();
    });
  });

  it("is hidden for a bulk (multi-property) edit, where a single listing's flag is ambiguous", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Edit application"
        sub={createDefaultListingSubmission()}
        propertyIds={["house-1", "house-2"]}
        managerUserId="mgr-1"
        initialVariant="standard"
        lockVariant
        templateEditorMode="edit"
        applicationTemplate={TEMPLATE}
        templates={[TEMPLATE]}
        onPersistSubmission={async () => true}
        onClose={onClose}
        onSaved={onSaved}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();
    expect(screen.queryByRole("button", { name: "Application form" })).toBeNull();
  });
});
