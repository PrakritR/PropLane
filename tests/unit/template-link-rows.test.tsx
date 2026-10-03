// @vitest-environment jsdom
//
// The per-template links moved out of Settings into each template popup's FIRST step: the
// application popup carries "Lease" (application first) and "Co-signer form"; the lease popup
// carries "Application" (lease first) and "Co-signer / guarantor addendum". The Lease/Application
// row shows only for the matching workspace signing order, and choosing saves exactly one link
// through the same setMappingTarget path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { createDefaultListingSubmission, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const LONG: PropertyLeaseTemplate = createPropertyLeaseTemplate({ kind: "long-term", label: "Long-term lease" });
const SHORT: PropertyLeaseTemplate = createPropertyLeaseTemplate({ kind: "short-term", label: "Short-term lease" });
const ADDENDUM: PropertyLeaseTemplate = {
  ...createPropertyLeaseTemplate({ kind: "long-term", label: "Guarantor addendum" }),
  listingSeedKey: "cosigner",
};
const STANDARD: PropertyApplicationTemplate = createPropertyApplicationTemplate({ kind: "long-term", label: "Standard application" });
const QUICK: PropertyApplicationTemplate = createPropertyApplicationTemplate({ kind: "long-term", label: "Quick application" });
const COSIGNER: PropertyApplicationTemplate = {
  ...createPropertyApplicationTemplate({ kind: "long-term", label: "Co-signer application" }),
  formVariant: "cosigner",
  listingSeedKey: "cosigner",
};

function subWith(
  leases: PropertyLeaseTemplate[],
  applications: PropertyApplicationTemplate[],
): ManagerListingSubmissionV1 {
  return {
    ...createDefaultListingSubmission(),
    propertyLeaseTemplates: leases,
    propertyApplicationTemplates: applications,
    propertyApplicationTemplatesExplicit: true,
  };
}

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

async function pick(trigger: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  const node = await screen.findByText(option, { selector: '[role="option"] *, [role="option"]' });
  fireEvent.pointerDown(node, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 10, clientY: 10 });
}

beforeEach(() => {
  clearAllWorkspaceDrafts();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  clearAllWorkspaceDrafts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderApplication(opts: {
  signingOrder?: "application_then_lease";
  mode?: "add" | "edit";
  template?: PropertyApplicationTemplate;
  applications?: PropertyApplicationTemplate[];
  persist?: ReturnType<typeof vi.fn>;
}) {
  const applications = opts.applications ?? [STANDARD, QUICK, COSIGNER];
  const template = opts.template ?? STANDARD;
  const persist = opts.persist ?? vi.fn().mockResolvedValue(true);
  render(
    <ManagerApplicationQuestionsEditorModal
      open
      title="Application"
      sub={subWith([LONG, SHORT], applications)}
      managerUserId="mgr-1"
      templateEditorMode={opts.mode ?? "edit"}
      applicationTemplate={opts.mode === "add" ? null : template}
      templates={applications}
      signingOrder={opts.signingOrder}
      onPersistSubmission={persist}
      onClose={() => {}}
      onSaved={() => {}}
      showToast={() => {}}
    />,
  );
  return persist;
}

function savedApplications(persist: ReturnType<typeof vi.fn>): PropertyApplicationTemplate[] {
  return (persist.mock.calls.at(-1)?.[0] as ManagerListingSubmissionV1).propertyApplicationTemplates ?? [];
}

describe("application popup, first step", () => {
  it("application first: shows a Lease row (this property's leases + Not mapped) and saves exactly one lease on this application", async () => {
    const persist = renderApplication({ signingOrder: "application_then_lease" });
    await screen.findByRole("dialog");
    const card = document.querySelector('[data-attr="property-application-step-one-card"]') as HTMLElement;
    expect(within(card).getByRole("button", { name: "Lease" })).toBeTruthy();

    await pick("Lease", "Short-term lease");
    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const saved = savedApplications(persist);
    const standard = saved.find((t) => t.id === STANDARD.id)!;
    expect(standard.linkedLeaseTemplateId).toBe(SHORT.id);
    expect(standard.usedForLeaseTemplateIds).toEqual([SHORT.id]);
    // Another application is untouched: one lease may serve many applications, never the reverse.
    expect(saved.find((t) => t.id === QUICK.id)!.linkedLeaseTemplateId ?? null).toBeNull();
  });

  it("choosing Not mapped clears the link", async () => {
    const mapped = { ...STANDARD, linkedLeaseTemplateId: LONG.id, usedForLeaseTemplateIds: [LONG.id] };
    const persist = renderApplication({
      signingOrder: "application_then_lease",
      template: mapped,
      applications: [mapped, QUICK, COSIGNER],
    });
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Lease" })).toHaveTextContent("Long-term lease");
    await pick("Lease", "Not mapped");
    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const standard = savedApplications(persist).find((t) => t.id === STANDARD.id)!;
    expect(standard.linkedLeaseTemplateId ?? null).toBeNull();
    expect(standard.usedForLeaseTemplateIds ?? []).toEqual([]);
  });

  it("order not loaded: no Lease row", async () => {
    renderApplication({});
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Lease" })).toBeNull();
  });

  it("a Save that did not touch the row leaves the stored link alone", async () => {
    const persist = renderApplication({ signingOrder: "application_then_lease" });
    await screen.findByRole("dialog");
    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    expect(savedApplications(persist).find((t) => t.id === STANDARD.id)!.linkedLeaseTemplateId ?? null).toBeNull();
  });

  it("a new, unsaved application carries its Lease choice into its first save", async () => {
    const persist = renderApplication({ signingOrder: "application_then_lease", mode: "add" });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByPlaceholderText("Application name"), { target: { value: "Brand new application" } });
    await pick("Lease", "Long-term lease");
    jumpRail("sections");
    fireEvent.click(document.querySelector('[data-attr="application-questions-save"]') as HTMLElement);
    await waitFor(() => expect(persist).toHaveBeenCalled());
    const created = savedApplications(persist).find((t) => t.label === "Brand new application")!;
    expect(created.linkedLeaseTemplateId).toBe(LONG.id);
    expect(created.usedForLeaseTemplateIds).toEqual([LONG.id]);
  });

  it("shows Co-signer form on a standard application and saves the choice; not on a co-signer form", async () => {
    const persist = renderApplication({});
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Co-signer form" })).toBeTruthy();
    await pick("Co-signer form", "Co-signer application");
    jumpRail("sections");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(persist).toHaveBeenCalled());
    expect(savedApplications(persist).find((t) => t.id === STANDARD.id)!.linkedCosignerApplicationTemplateId).toBe(COSIGNER.id);
    cleanup();

    renderApplication({ template: COSIGNER, signingOrder: "application_then_lease" });
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Co-signer form" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Lease" })).toBeNull();
  });
});

function renderLease(opts: {
  mode?: "add" | "edit";
  template?: PropertyLeaseTemplate;
  applications?: PropertyApplicationTemplate[];
  leases?: PropertyLeaseTemplate[];
  onSave?: ReturnType<typeof vi.fn>;
}) {
  const leases = opts.leases ?? [LONG, SHORT, ADDENDUM];
  const applications = opts.applications ?? [STANDARD, QUICK, COSIGNER];
  const template = opts.template ?? LONG;
  const onSave = opts.onSave ?? vi.fn().mockResolvedValue(true);
  render(
    <PropertyLeaseFormModal
      open
      mode={opts.mode ?? "edit"}
      sub={subWith(leases, applications)}
      template={opts.mode === "add" ? null : { ...template, applicationLeaseTerms: ["Long-term"] }}
      templates={leases}
      propertyId="mgr-house-1"
      onClose={() => {}}
      onSave={onSave}
      showToast={() => {}}
    />,
  );
  return onSave;
}

function savedLeases(onSave: ReturnType<typeof vi.fn>): PropertyLeaseTemplate[] {
  return onSave.mock.calls.at(-1)?.[0] as PropertyLeaseTemplate[];
}

describe("lease popup, first step", () => {
  it("the lease popup has no Application row (one system: application first, then lease)", async () => {
    renderLease({});
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(screen.queryByRole("button", { name: "Application" })).toBeNull();
  });

  it("shows Co-signer / guarantor addendum on a regular lease, saves the choice, and hides it on an addendum", async () => {
    const onSave = renderLease({});
    await screen.findByRole("dialog", { name: "Edit lease" });
    await pick("Co-signer / guarantor addendum", "Guarantor addendum");
    jumpRail("document");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(savedLeases(onSave).find((t) => t.id === LONG.id)!.linkedGuarantorLeaseTemplateId).toBe(ADDENDUM.id);
    cleanup();

    renderLease({ template: ADDENDUM });
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(screen.queryByRole("button", { name: "Co-signer / guarantor addendum" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Application" })).toBeNull();
  });
});
