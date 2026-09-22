// @vitest-environment jsdom
//
// Super-plan row 3 — Edit application / lease / Add request / Add promotion
// must open the same AddWorkspace rail as Schedule tour (steps on the left,
// Continue until Preview, not a stacked Modal).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerApplicationQuestionsEditorModal } from "@/components/portal/pro-application-questions-editor-modal";
import { PropertyLeaseFormModal } from "@/components/portal/property-lease-form-modal";
import { PropertyApplicationFormModal } from "@/components/portal/property-application-form-modal";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
import { PromotionDefaultSuggestions } from "@/components/portal/promotion-default-suggestions";
import { EMPTY_DRAFT } from "@/components/portal/promotion-form";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { createDefaultListingSubmission, createManagerListingServiceOption } from "@/lib/manager-listing-submission";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function jumpRail(id: string) {
  const btn = document.querySelector(`[data-attr="listing-v2-rail-${id}"]`) as HTMLElement | null;
  expect(btn).not.toBeNull();
  fireEvent.click(btn!);
}

describe("AddWorkspace editor shells (source)", () => {
  it("application / lease / request / promotion editors compose AddWorkspace instead of a Modal shell", () => {
    const files = [
      "src/components/portal/pro-application-questions-editor-modal.tsx",
      "src/components/portal/property-lease-form-modal.tsx",
      "src/components/portal/service-offering-edit-modal.tsx",
      "src/components/portal/promotion-new-modal.tsx",
      "src/components/portal/property-application-form-modal.tsx",
      "src/components/portal/pro-vendor-form-modal.tsx",
      "src/components/portal/pro-task-form-modal.tsx",
      "src/components/portal/pro-add-lease-modal.tsx",
      "src/components/portal/pro-add-payment-modal.tsx",
      "src/components/portal/pro-add-outgoing-payment-modal.tsx",
      "src/components/portal/pro-add-service-modal.tsx",
      "src/components/portal/bookings-block-dates-modal.tsx",
    ];
    for (const file of files) {
      const body = src(file);
      expect(body).toContain("<AddWorkspace");
      expect(body).not.toMatch(/<Modal[\s\n]+open=\{open\}/);
    }
  });

  it("suggestion + opens the new-promotion workspace on Content instead of immediately seeding a row", () => {
    const panel = src("src/components/portal/pro-property-promotion-panel.tsx");
    expect(panel).not.toMatch(/addDefaultPromotionPreset\(/);
    expect(panel).toContain('setNewPromotionStepId("content")');
    expect(panel).toContain("setShowNewModal(true)");
  });

  it("suggested promotion rows have no grey helper sentence", () => {
    const suggestions = src("src/components/portal/promotion-default-suggestions.tsx");
    expect(suggestions).not.toContain("preset.description");
  });
});

describe("Edit application workspace chrome", () => {
  it("opens a step rail with Continue, then Save on Preview", async () => {
    render(
      <ManagerApplicationQuestionsEditorModal
        open
        title="Edit application"
        sub={createDefaultListingSubmission()}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr-1"
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit application" });
    expect(document.querySelector('[data-attr="listing-v2-rail-form"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-household"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="application-questions-next"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="application-questions-save"]')).toBeNull();

    jumpRail("preview");
    const save = document.querySelector('[data-attr="application-questions-save"]') as HTMLButtonElement | null;
    expect(save).not.toBeNull();
    expect(save!.textContent).toBe("Save");
  });
});

describe("Edit / Add lease workspace chrome", () => {
  it("opens Name → Document → Preview with Continue until Save", async () => {
    render(
      <PropertyLeaseFormModal
        open
        mode="add"
        sub={createDefaultListingSubmission()}
        onClose={() => {}}
        onSave={() => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "New lease" });
    expect(document.querySelector('[data-attr="listing-v2-rail-name"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-document"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="property-lease-next"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="property-lease-add-save"]')).toBeNull();

    jumpRail("preview");
    expect(document.querySelector('[data-attr="property-lease-add-save"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="property-lease-html-preview"]')).not.toBeNull();
  });
});

describe("Add request type workspace chrome", () => {
  it("opens Details → Price → Preview", async () => {
    render(
      <ServiceOfferingEditModal
        open
        isNew
        offering={createManagerListingServiceOption("Parking spot")}
        sub={createDefaultListingSubmission()}
        saveTarget={{ mode: "listing", saveId: "mgr-house-1" }}
        managerUserId="mgr-1"
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
        entityLabel="request type"
      />,
    );
    await screen.findByRole("dialog", { name: "Add request type" });
    expect(document.querySelector('[data-attr="listing-v2-rail-details"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-price"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="service-offering-next"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="service-offering-save"]')).toBeNull();

    jumpRail("preview");
    expect(document.querySelector('[data-attr="service-offering-save"]')).not.toBeNull();
    expect(screen.getAllByText("Parking spot").length).toBeGreaterThan(0);
  });
});

describe("Add promotion workspace chrome", () => {
  function Harness({
    initialStepId,
    initialKind = "flyer",
  }: {
    initialStepId?: "kind" | "content";
    initialKind?: "flyer" | "text";
  }) {
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    return (
      <AppUiProvider>
        <PromotionNewModal
          open
          onClose={() => {}}
          initialKind={initialKind}
          initialStepId={initialStepId}
          draft={draft}
          setDraft={setDraft}
          listings={[]}
          onSelectProperty={() => {}}
          onGenerateFlyer={() => {}}
          onGenerateText={() => {}}
        />
      </AppUiProvider>
    );
  }

  it("opens Kind → Content → Preview from New promotion", async () => {
    render(<Harness />);
    await screen.findByRole("dialog", { name: "New promotion" });
    expect(document.querySelector('[data-attr="listing-v2-rail-kind"]')?.getAttribute("aria-current")).toBe("step");
    expect(document.querySelector('[data-attr="listing-v2-rail-content"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="promotion-new-next"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="promotion-generate"]')).toBeNull();
    expect(document.querySelector('[data-attr="promotion-new-property"]')).not.toBeNull();
  });

  it("suggestion + lands on Content with Kind already chosen", async () => {
    render(<Harness initialKind="flyer" initialStepId="content" />);
    await screen.findByRole("dialog", { name: "New promotion" });
    expect(document.querySelector('[data-attr="listing-v2-rail-content"]')?.getAttribute("aria-current")).toBe("step");
    expect(document.querySelector('[data-attr="promotion-new-kind"]')).toBeNull();
  });
});

describe("Add application template workspace chrome", () => {
  it("opens Name → Preview instead of a small dialog", async () => {
    render(
      <PropertyApplicationFormModal
        open
        mode="add"
        templates={[]}
        onClose={() => {}}
        onSave={() => true}
      />,
    );
    await screen.findByRole("dialog", { name: "Add application" });
    expect(document.querySelector('[data-attr="listing-v2-rail-name"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-v2-rail-preview"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="property-application-next"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="property-application-save"]')).toBeNull();
  });
});

describe("Promotion suggestion +", () => {
  it("calls onAddPreset for the missing flyer row", () => {
    const onAddPreset = vi.fn();
    render(
      <PromotionDefaultSuggestions propertyId="prop-1" promotionRow={null} onAddPreset={onAddPreset} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Flyer from listing" }));
    expect(onAddPreset).toHaveBeenCalledWith("default_flyer");
  });
});
