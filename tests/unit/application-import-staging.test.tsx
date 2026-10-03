// @vitest-environment jsdom
//
// F004: uploading a file on the application template editor's Sections step
// stages a diff (N found / N changed) instead of silently replacing the
// template — nothing changes until "Apply changes from the file", and
// "Discard" leaves the template exactly as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import {
  createPropertyApplicationTemplate,
  readPropertyApplicationTemplates,
  type ApplicationTemplateQuestionConfig,
} from "@/lib/property-application-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

const PARSED_DRAFT: ApplicationTemplateQuestionConfig = {
  version: 1,
  disabledStandardApplicationKeys: [],
  customApplicationFields: [
    { id: "pet_policy", key: "pet_policy", label: "Pet policy acknowledgment", type: "text", required: true, options: [], section: "additional" },
  ],
  applicationConfigMode: "custom",
  questionDisplayOrder: [],
  importProvenance: {
    sourceName: "lease.pdf",
    sourcePath: "mgr-1/application-import/app-tpl-1/source.pdf",
    sourceSha256: "a".repeat(64),
    importedAt: "2026-01-01T00:00:00.000Z",
    unresolvedCount: 0,
    issues: [],
  },
};

function stubImportFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/portal/application-template-import")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ draft: PARSED_DRAFT, issues: [], source: { path: PARSED_DRAFT.importProvenance!.sourcePath } }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
}

// Redesign (studio-redesign-0929, property-lease-apps): the Sections-step strip is
// gone. A saved application re-imports through the "Start from" row's Replace action
// (hidden input); a new one picks "Upload PDF" in "Start from", which reveals the strip.
function pickFile() {
  const input = (document.querySelector('[data-attr="property-application-start-from-file"] input[type="file"]') ??
    document.querySelector('[data-attr="application-replace-upload-input"]')) as HTMLInputElement;
  expect(input).not.toBeNull();
  const file = new File(["%PDF-1.4"], "lease.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

async function chooseUploadPdf() {
  const trigger = document.querySelector('[data-attr="property-application-start-from"]') as HTMLElement;
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByText("Upload PDF"));
}

beforeEach(() => {
  stubImportFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F004: import stages a diff before applying", () => {
  it("does not add the parsed question to the form until Apply is clicked", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="prop-1"
        templateEditorMode="edit"
        applicationTemplate={{ ...template, id: "app-tpl-1" }}
        templates={[{ ...template, id: "app-tpl-1" }]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Application" });

    pickFile();

    const summary = await screen.findByText(/section.*found/);
    expect(summary).toBeTruthy();
    expect(document.querySelector('[data-attr="application-pending-import"]')).not.toBeNull();

    // Nothing written yet — the "Additional details" section's own always-
    // visible question count has not moved (its row content is collapsed by
    // default, so this checks the count rather than expanding — expanding
    // is exercised separately below).
    jumpRail("sections");
    const additionalRow = () => document.querySelector('[data-attr="application-section-toggle-additional"]');
    const countBefore = additionalRow()?.textContent ?? "";
    jumpRail("name");

    // Apply writes exactly the parsed sections into the working copy.
    fireEvent.click(screen.getByRole("button", { name: "Apply changes from the file" }));
    expect(document.querySelector('[data-attr="application-pending-import"]')).toBeNull();
    jumpRail("sections");
    await waitFor(() => expect(additionalRow()?.textContent).not.toBe(countBefore));
    // The question's own section starts collapsed — expand it to see the row.
    // It renders both as the row's own title AND (auto-expanded, since it's
    // new) its question-editor field label, so this checks for at least one
    // match rather than a single unique one.
    fireEvent.click(additionalRow() as HTMLElement);
    expect((await screen.findAllByText("Pet policy acknowledgment")).length).toBeGreaterThan(0);
  });

  it("Discard leaves the template untouched", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="prop-1"
        templateEditorMode="edit"
        applicationTemplate={{ ...template, id: "app-tpl-1" }}
        templates={[{ ...template, id: "app-tpl-1" }]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Application" });

    pickFile();
    await waitFor(() => expect(document.querySelector('[data-attr="application-pending-import"]')).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(document.querySelector('[data-attr="application-pending-import"]')).toBeNull();

    jumpRail("sections");
    const additionalToggle = document.querySelector('[data-attr="application-section-toggle-additional"]') as HTMLElement | null;
    if (additionalToggle) fireEvent.click(additionalToggle);
    expect(screen.queryByText("Pet policy acknowledgment")).toBeNull();
  });

  it("Compare shows the changed section without applying it", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="prop-1"
        templateEditorMode="edit"
        applicationTemplate={{ ...template, id: "app-tpl-1" }}
        templates={[{ ...template, id: "app-tpl-1" }]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Application" });

    pickFile();
    await waitFor(() => expect(document.querySelector('[data-attr="application-pending-import"]')).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect(document.querySelector('[data-attr="application-pending-import-changed-sections"]')).not.toBeNull();
    // Still nothing applied.
    jumpRail("sections");
    const additionalToggle = document.querySelector('[data-attr="application-section-toggle-additional"]') as HTMLElement | null;
    if (additionalToggle) fireEvent.click(additionalToggle);
    expect(screen.queryByText("Pet policy acknowledgment")).toBeNull();
  });
});

describe("F004: a brand-new (unsaved) application stages before persisting too", () => {
  function renderAddModal(onPersistSubmission = vi.fn().mockResolvedValue(true)) {
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Add application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="prop-1"
        templateEditorMode="add"
        applicationTemplate={null}
        templates={[]}
        onPersistSubmission={onPersistSubmission}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    return onPersistSubmission;
  }

  it("does not create or persist anything until the footer commit, and Discard leaves an empty new form", async () => {
    const onPersistSubmission = renderAddModal();
    await screen.findByRole("dialog", { name: "Add application" });
    await chooseUploadPdf();

    pickFile();

    expect(await screen.findByText(/section.*found/)).toBeTruthy();
    expect(document.querySelector('[data-attr="application-pending-import"]')).not.toBeNull();
    // The parse call itself only ever POSTs — nothing is created/saved yet.
    expect(onPersistSubmission).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(document.querySelector('[data-attr="application-pending-import"]')).toBeNull();
    expect(onPersistSubmission).not.toHaveBeenCalled();

    jumpRail("sections");
    const additionalRow = document.querySelector('[data-attr="application-section-toggle-additional"]') as HTMLElement | null;
    if (additionalRow) fireEvent.click(additionalRow);
    expect(screen.queryByText("Pet policy acknowledgment")).toBeNull();
  });

  it("Apply only fills the working copy — the footer commit is the first and only persist call", async () => {
    const onPersistSubmission = renderAddModal();
    await screen.findByRole("dialog", { name: "Add application" });
    await chooseUploadPdf();

    pickFile();
    await waitFor(() => expect(document.querySelector('[data-attr="application-pending-import"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Apply changes from the file" }));
    expect(document.querySelector('[data-attr="application-pending-import"]')).toBeNull();
    expect(onPersistSubmission).not.toHaveBeenCalled();

    const nameInput = document.querySelector("#application-template-name") as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Fall 2026 Application" } });

    // The footer's commit button only renders on the LAST rail step.
    jumpRail("sections");
    const addButton = await screen.findByRole("button", { name: "Create application" });
    await waitFor(() => expect(addButton).not.toBeDisabled());
    fireEvent.click(addButton);

    await waitFor(() => expect(onPersistSubmission).toHaveBeenCalledTimes(1));
    const [merged] = onPersistSubmission.mock.calls[0]!;
    const created = readPropertyApplicationTemplates(merged)[0];
    expect(created?.draftQuestionConfig?.customApplicationFields.some((f) => f.key === "pet_policy")).toBe(true);
    expect(created?.draftQuestionConfig?.importProvenance?.sourcePath).toBe(PARSED_DRAFT.importProvenance!.sourcePath);
  });
});
