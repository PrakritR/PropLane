// @vitest-environment jsdom
//
// F-editor c/d/e + C2-CP8: the property Add/Edit lease editor (Lease and Document
// steps only, no Settings step), footer-only commit, and the duplicate-name validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearAllWorkspaceDrafts } from "@/components/portal/add-workspace/draft";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/portal/property-lease-document-notice", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/portal/property-lease-document-notice")>();
  return { ...mod, propertyLeaseNeedsAssistantReview: () => false };
});

function submissionWithOfferedLeaseTypes() {
  const sub = createDefaultListingSubmission();
  sub.allowedLeaseTerms = ["Long-term", "Month-to-Month", "Custom", "Short-Term Stay"];
  return sub;
}

function footerStepCountHidden() {
  const primary = screen.getByRole("button", { name: /^(Save|Create lease|Next)$/ });
  const footer = primary.parentElement;
  expect(footer?.textContent ?? "").not.toMatch(/Step \d+ of \d+/);
}
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const TEMPLATE: PropertyLeaseTemplate = {
  ...createPropertyLeaseTemplate({ kind: "long-term", label: "Standard lease", source: { kind: "proplane_default" } as never }),
};

const OTHER_TEMPLATE: PropertyLeaseTemplate = {
  ...createPropertyLeaseTemplate({ kind: "short-term", label: "Guarantor lease", source: { kind: "proplane_default" } as never }),
};

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
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

describe("C2-CP8: the lease editor has no Settings step", () => {
  it("lists only Lease and Document, and none of the workspace or property switches", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={{ ...TEMPLATE, applicationLeaseTerms: ["Long-term"] }}
        templates={[TEMPLATE, OTHER_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(document.querySelector('[data-attr="listing-v2-rail-name"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-document"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-setup"]')).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Pipeline order" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Application" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Co-signer addendum" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /Default .* lease for this property/ })).toBeNull();
  });

  it("keeps the application and addendum links the workspace settings made when the lease is saved", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const editedTemplate = {
      ...TEMPLATE,
      applicationLeaseTerms: ["Long-term"],
      linkedApplicationTemplateId: "app-tpl-mapped",
      linkedGuarantorLeaseTemplateId: OTHER_TEMPLATE.id,
    };
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={submissionWithOfferedLeaseTypes()}
        template={editedTemplate}
        templates={[editedTemplate, OTHER_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={onSave}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    jumpRail("document");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = (onSave.mock.calls.at(-1)?.[0] as PropertyLeaseTemplate[]).find((t) => t.id === TEMPLATE.id);
    expect(saved?.linkedApplicationTemplateId).toBe("app-tpl-mapped");
    expect(saved?.linkedGuarantorLeaseTemplateId).toBe(OTHER_TEMPLATE.id);
  });

  it("hides the footer step count on the property lease editor", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={submissionWithOfferedLeaseTypes()}
        template={{ ...TEMPLATE, applicationLeaseTerms: ["Long-term"] }}
        templates={[TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    jumpRail("document");
    footerStepCountHidden();
  });

  it("shows no Used for mapping card on edit", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={submissionWithOfferedLeaseTypes()}
        template={{ ...TEMPLATE, applicationLeaseTerms: ["Long-term"] }}
        templates={[TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(document.querySelector('[data-attr="property-form-used-for-mapping"]')).toBeNull();
    expect(screen.queryByText("Used for")).toBeNull();
  });
});

describe("F013: lease Sections step duplicate-name validation", () => {
  it("blocks Save with an inline error when another lease already uses this name", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={{ ...OTHER_TEMPLATE, applicationLeaseTerms: ["Short-term stay"] }}
        templates={[TEMPLATE, OTHER_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={onSave}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });

    const nameInput = document.querySelector('[data-attr="property-lease-name"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: TEMPLATE.label } });

    expect(await screen.findByText(`A lease named "${TEMPLATE.label}" already exists on this property.`)).toBeTruthy();
    // Jump straight to Document (the last step, where the footer shows Save) —
    // the duplicate-name error must keep it disabled from any step.
    jumpRail("document");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("F-editor c: footer-only commit", () => {
  it("shows the upload strip only after Start from → Upload PDF", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        templates={[]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "New lease" });
    expect(screen.getByRole("button", { name: "Start from" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    const uploadOption = await screen.findByRole("option", { name: "Upload PDF" });
    fireEvent.pointerDown(uploadOption, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(uploadOption, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(document.querySelector('[data-attr="property-lease-name-upload"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Choose file" })).toBeNull();
  });

  it("never renders an in-body upload button on the PropLane path — footer Save only", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        templates={[]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "New lease" });
    expect(screen.getByRole("button", { name: "Type of lease" })).toBeTruthy();
    expect(document.querySelector('[data-attr="property-lease-name-upload"]')).toBeNull();
    fireEvent.change(document.querySelector('[data-attr="property-lease-name"]') as HTMLInputElement, {
      target: { value: "New lease" },
    });
    jumpRail("document");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create lease" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Publish application" })).toBeNull();
  });
});

describe("Add lease type picker", () => {
  it("offers Long-term and Short term only; custom dates and month-to-month are checkboxes", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        templates={[]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "New lease" });
    fireEvent.click(screen.getByRole("button", { name: "Type of lease" }));
    expect(await screen.findByRole("option", { name: "Long-term" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "Short term" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Month-to-month" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Custom start" })).toBeNull();
  });
});

describe("Edit lease header chrome", () => {
  it("does not show Discard draft in the header when editing an existing lease", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={submissionWithOfferedLeaseTypes()}
        template={{ ...TEMPLATE, applicationLeaseTerms: ["Long-term"] }}
        templates={[TEMPLATE, OTHER_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    expect(screen.queryByRole("button", { name: "Discard draft" })).toBeNull();
  });
});

describe("C2-LA4-5 clause paper on PropLane lease document step", () => {
  const CLAUSE_TEMPLATE: PropertyLeaseTemplate = {
    ...createPropertyLeaseTemplate({ kind: "long-term", label: "Clause lease", source: { kind: "proplane_default" } as never }),
    leaseTemplateHtmlOverride: `<!doctype html><html><body><section id="lease-document-header"><h1>Lease</h1></section><section id="c1"><h2>1. Rent</h2><p>Pay rent.</p></section></body></html>`,
  };

  it("uses the clause paper editor when parsed sections exist", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={CLAUSE_TEMPLATE}
        templates={[CLAUSE_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    jumpRail("document");
    await waitFor(() =>
      expect(document.querySelector('[data-attr="property-lease-clause-paper-editor"]')).not.toBeNull(),
    );
  });
});
