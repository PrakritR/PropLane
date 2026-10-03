// @vitest-environment jsdom
//
// F-editor c/d/e: the property Add/Edit lease editor's Setup step (one fee
// toggle, segmented pipeline, Linked co-signer/guarantor addendum), footer-
// only commit, and the Sections step's duplicate-name validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
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
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F014/F-editor c: lease Setup — one fee toggle, segmented pipeline, no checkboxes", () => {
  it("renders the fee, pipeline and default controls as toggles/segmented control, never a checkbox", async () => {
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
    jumpRail("setup");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    expect(screen.getByRole("switch", { name: "Offer this lease to applicants" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Pipeline order" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Default .* lease for this property/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("F015: lease Setup's Linked co-signer / guarantor addendum picker", () => {
  it("stores the picked lease template's id, and never offers the lease being edited", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={{ ...TEMPLATE, applicationLeaseTerms: ["Long-term"] }}
        templates={[TEMPLATE, OTHER_TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={onSave}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    jumpRail("setup");
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    const picker = screen.getByRole("button", { name: "A co-signer or guarantor signs" });
    fireEvent.click(picker);
    const listbox = await screen.findByRole("listbox");
    const option = screen.getByText("Guarantor lease");
    fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    void listbox;

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const savedTemplates = onSave.mock.calls.at(-1)?.[0] as PropertyLeaseTemplate[];
    const saved = savedTemplates.find((t) => t.id === TEMPLATE.id);
    expect(saved?.linkedGuarantorLeaseTemplateId).toBe(OTHER_TEMPLATE.id);
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
    // Jump straight to Setup (the last step, where the footer shows Save) —
    // the duplicate-name error must keep it disabled from any step.
    jumpRail("setup");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("F-editor c: footer-only commit", () => {
  it("never renders an in-body upload button — only the dashed Start-from-a-file card and the footer Save", async () => {
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
    expect(document.querySelector('[data-attr="property-lease-name-upload"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Choose file" })).toBeNull();
    // Fill the required name so Continue is reachable, then confirm the
    // footer's commit label is "Add lease" on the last step — never a
    // second in-body commit button anywhere along the way.
    fireEvent.change(document.querySelector('[data-attr="property-lease-name"]') as HTMLInputElement, {
      target: { value: "New lease" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to Document" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to Settings" }));
    expect(screen.getByRole("button", { name: "Create lease" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish application" })).toBeNull();
  });
});
