// @vitest-environment jsdom
//
// F-editor a/c + C2-CP8: the property Add/Edit application editor's Sections-step
// default-sections checklist, the footer-only commit contract, and the absence of
// a Settings step (workspace choices live in Settings -> Applications & leases).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, type PropertyApplicationTemplate } from "@/lib/property-application-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

function submissionWithOfferedLeaseTypes() {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
  return sub;
}

function footerStepCountHidden() {
  const primary = screen.getByRole("button", { name: /^(Save|Create application|Next)$/ });
  const footer = primary.parentElement;
  expect(footer?.textContent ?? "").not.toMatch(/Step \d+ of \d+/);
}

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
    for (const railId of ["name", "sections"]) {
      jumpRail(railId);
      expect(screen.queryByRole("button", { name: "Publish application" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Upload PDF" })).toBeNull();
    }
    // The one commit action is the footer's Save.
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});

describe("C2-CP8: the application editor has no Settings step", () => {
  const OTHER_TEMPLATE: PropertyApplicationTemplate = {
    id: "app-tpl-cosigner-target",
    kind: "long-term",
    label: "Guest application",
    formVariant: "standard",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("lists only Application and Questions, and keeps the links workspace settings made on Save", async () => {
    const base = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    const template: PropertyApplicationTemplate = {
      ...base,
      linkedCosignerApplicationTemplateId: OTHER_TEMPLATE.id,
      linkedLeaseTemplateId: "lease-tpl-mapped",
      usedForLeaseTemplateIds: ["lease-tpl-mapped"],
    };
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
    expect(document.querySelector('[data-attr="listing-v2-rail-name"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-sections"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-setup"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Co-signer form" })).toBeNull();
    expect(screen.queryByText("Signing order")).toBeNull();
    expect(screen.queryByText("Used for leases")).toBeNull();

    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const savedSubmission = persist.mock.calls.at(-1)?.[0] as ManagerListingSubmissionV1;
    const saved = savedSubmission.propertyApplicationTemplates?.find((t) => t.id === template.id);
    expect(saved?.linkedCosignerApplicationTemplateId).toBe(OTHER_TEMPLATE.id);
    expect(saved?.linkedLeaseTemplateId).toBe("lease-tpl-mapped");
  });

  it("shows Used for mapping on property edit when a preview property id is set", async () => {
    const template = createPropertyApplicationTemplate({ kind: "long-term", label: "Long-term application" });
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Application"
        sub={submissionWithOfferedLeaseTypes()}
        managerUserId="mgr-1"
        applicationPreviewPropertyId="mgr-demo-cascade"
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
    await waitFor(() =>
      expect(document.querySelector('[data-attr="property-form-used-for-mapping"]')).not.toBeNull(),
    );
    jumpRail("sections");
    footerStepCountHidden();
  });
});
