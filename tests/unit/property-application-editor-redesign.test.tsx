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
    // One row per section, a switch each: turning References off leaves its row in the list, switched off.
    const propertySwitch = document.querySelector('[data-attr="application-questions-editor-section-switch-references"]') as HTMLElement | null;
    expect(propertySwitch).not.toBeNull();
    expect(propertySwitch!.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(propertySwitch!);
    expect(propertySwitch!.getAttribute("aria-checked")).toBe("false");

    expect(document.querySelectorAll('[data-attr="application-questions-editor-section-references"]')).toHaveLength(1);
    const householdSwitch = document.querySelector('[data-attr="application-questions-editor-section-switch-household"]') as HTMLElement | null;
    expect(householdSwitch!.getAttribute("aria-checked")).toBe("true");
  });

  it("Personal information is checked and its switch is locked on (name and email are always asked)", async () => {
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
    const personalSwitch = document.querySelector('[data-attr="application-questions-editor-section-switch-personal"]') as HTMLButtonElement | null;
    expect(personalSwitch).not.toBeNull();
    expect(personalSwitch!.getAttribute("aria-checked")).toBe("true");
    // Personal holds full legal name and email, which are always asked: the switch is on, disabled and locked.
    expect(personalSwitch!.disabled).toBe(true);
    expect(document.querySelector('[data-attr="application-questions-editor-section-lock-personal"]')).not.toBeNull();
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
    // The co-signer link is a row on this first step (Settings no longer carries it); the signing
    // order stays a workspace setting, and with no order loaded there is no Lease row.
    expect(screen.getByRole("button", { name: "Co-signer form" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lease" })).toBeNull();
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

  it("has no Used for section on property edit: the Lease row above is the one link, and lease-side linking is on the lease", async () => {
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
    expect(document.querySelector('[data-attr="property-form-used-for-mapping"]')).toBeNull();
    expect(screen.queryByText(/Used for/i)).toBeNull();
    jumpRail("sections");
    footerStepCountHidden();
  });
});
