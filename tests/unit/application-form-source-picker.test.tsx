// @vitest-environment jsdom
//
// F-editor b/F005/F020: the property Add/Edit application editor no longer
// offers a "Workspace form" / "Custom for this listing" picker, or a "Make
// default format" link — this property's application is always its own
// form. A template that was still following the workspace (never explicitly
// customized) is detached from it once, silently, the moment the workspace
// form finishes loading — the same one-time copy "Custom for this listing"
// used to do by hand, now automatic and never user-visible as an edit.
//
// The listing-wide editor (opened outside a property record, `isTemplateEditor`
// false) is untouched and keeps its own picker — out of scope here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("F-editor b: no Workspace form / Custom for this listing picker in the property template editor", () => {
  it("never renders the picker or Make default format, even after the workspace form loads", async () => {
    renderTemplateEditor();
    await waitWorkspace();

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Application form" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make default format" })).toBeNull();

    const formRail = document.querySelector('[data-attr="listing-v2-rail-sections"]') as HTMLElement | null;
    expect(formRail).not.toBeNull();
    fireEvent.click(formRail!);
    expect(screen.queryByRole("button", { name: "Application form" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make default format" })).toBeNull();
  });

  it("silently detaches from the workspace form once it loads, copying its fields onto the template", async () => {
    renderTemplateEditor();
    await waitWorkspace();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());

    // Jump to the Form step and expand the section holding the copied
    // question — no picker to switch first, it is already there.
    const formRail = document.querySelector('[data-attr="listing-v2-rail-sections"]') as HTMLElement | null;
    expect(formRail).not.toBeNull();
    fireEvent.click(formRail!);

    // No read-only "Following the workspace application form" notice — the
    // template is editable immediately.
    expect(screen.queryByText(/Following the workspace application form/i)).toBeNull();

    const sectionToggle = document.querySelector('[data-attr="application-section-toggle-additional"]') as HTMLElement | null;
    expect(sectionToggle).not.toBeNull();
    fireEvent.click(sectionToggle!);

    // Expand the copied question's card (same id it had on the workspace
    // template — proving it was actually copied, not re-created) and confirm
    // it's a real, editable label input pre-filled with the copied question.
    const toggle = document.querySelector('[data-attr="application-question-edit-ws-gate"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle!);
    const labelInput = await screen.findByDisplayValue("Do you have pets?");
    expect(labelInput.getAttribute("data-attr")).toBe("application-question-label");
  });

  it("is unreachable for a bulk (multi-property) edit, where a single listing's flag is ambiguous", async () => {
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
    expect(screen.queryByRole("button", { name: "Make default format" })).toBeNull();
  });
});
