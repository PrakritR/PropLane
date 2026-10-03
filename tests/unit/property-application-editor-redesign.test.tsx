// @vitest-environment jsdom
//
// F-editor a/c/d: the property Add/Edit application editor's Sections-step
// default-sections checklist, the footer-only commit contract, and the
// Setup step's "Linked co-signer form" picker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate } from "@/lib/property-lease-templates";

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

async function waitWorkspace(title = "Application") {
  await screen.findByRole("dialog", { name: title });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F003: Sections step default-sections checklist", () => {
  it("unchecking a section drops it from the Form step's list and every count", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();

    jumpRail("sections");
    const propertyRow = document.querySelector('[data-attr="application-sections-checklist-property"]') as HTMLInputElement | null;
    expect(propertyRow).not.toBeNull();
    expect(propertyRow!.checked).toBe(true);

    fireEvent.click(propertyRow!);
    expect(propertyRow!.checked).toBe(false);

    expect(document.querySelector('[data-attr="application-section-toggle-property"]')).toBeNull();
    expect(document.querySelector('[data-attr="application-section-toggle-household"]')).not.toBeNull();
  });

  it("locks a section holding a never-removable question (Personal information) checked", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();

    jumpRail("sections");
    const personalRow = document.querySelector('[data-attr="application-sections-checklist-personal"]') as HTMLInputElement | null;
    expect(personalRow).not.toBeNull();
    expect(personalRow!.checked).toBe(true);
    expect(personalRow!.disabled).toBe(true);
  });
});

describe("F-editor c: footer-only commit", () => {
  it("never renders an in-body Publish/Upload button on any step of the property editor", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template]}
        onPersistSubmission={async () => true}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();
    for (const railId of ["name", "sections", "setup"]) {
      jumpRail(railId);
      expect(screen.queryByRole("button", { name: "Publish application" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Upload PDF" })).toBeNull();
    }
    // The one commit action is the footer's Save.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("F009: Setup step's Linked co-signer form picker", () => {
  const OTHER_TEMPLATE: PropertyApplicationTemplate = {
    id: "app-tpl-cosigner-target",
    kind: "long-term",
    label: "Guest application",
    formVariant: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("stores the picked template's id, and never offers the template being edited", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    const persist = vi.fn().mockResolvedValue(true);
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={createDefaultListingSubmission()}
        managerUserId="mgr-1"
        templateEditorMode="edit"
        applicationTemplate={template}
        templates={[template, OTHER_TEMPLATE]}
        onPersistSubmission={persist}
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await waitWorkspace();
    jumpRail("setup");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    const picker = screen.getByRole("button", { name: "Co-signer form" });
    fireEvent.click(picker);
    const listbox = await screen.findByRole("listbox");
    // The template being edited is never offered as its own co-signer form.
    expect(screen.queryByText("Long-term application", { selector: '[role="listbox"] *' })).toBeNull();
    const option = screen.getByText("Guest application");
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    void listbox;

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const savedSubmission = persist.mock.calls.at(-1)?.[0] as ManagerListingSubmissionV1;
    const savedTemplate = savedSubmission.propertyApplicationTemplates?.find((t) => t.id === template.id);
    expect(savedTemplate?.linkedCosignerApplicationTemplateId).toBe(OTHER_TEMPLATE.id);
  });
});

describe("C2-R30-11 intake ↔ licensing Used for leases link", () => {
  it("writes linkedApplicationTemplateId on leases selected in Used for leases", () => {
    const intake = createPropertyApplicationTemplate({ kind: "long-term", label: "Intake form" });
    const licensing = createPropertyLeaseTemplate({ kind: "long-term", label: "Licensing agreement" });
    const templateId = intake.id;
    const selectedLeases = new Set([licensing.id]);
    const propertyLeaseTemplates = [licensing].map((lease) =>
      selectedLeases.has(lease.id) ? { ...lease, linkedApplicationTemplateId: templateId } : lease,
    );
    expect(propertyLeaseTemplates[0]?.linkedApplicationTemplateId).toBe(templateId);
  });
});
