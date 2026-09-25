// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { clearRentalWizardDraft, loadRentalVariantDraft, rememberRentalVariantAxisId, rememberRentalVariantDraft, saveRentalWizardDraft, saveRentalWizardDraftAxisId } from "@/lib/rental-application/drafts";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

describe("application target draft pins", () => {
  it("keeps independent published versions and answers for each stay type", () => {
    clearRentalWizardDraft();
    const base = { ...createInitialRentalWizardState(), propertyId: "property-1" };
    saveRentalWizardDraft({ ...base, rentalType: "standard", applicationTemplateId: "standard-template", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "standard", label: "Standard question", type: "text", value: "standard answer" }] });
    saveRentalWizardDraftAxisId("APP-standard");
    rememberRentalVariantDraft({ ...base, rentalType: "short_term", applicationTemplateId: "short-template", applicationTemplateVersion: 2, customFieldAnswers: [{ key: "short", label: "Short question", type: "text", value: "short answer" }] });
    rememberRentalVariantAxisId("property-1", "short_term", "APP-short");
    expect(loadRentalVariantDraft("property-1", "standard")?.axisId).toBe("APP-standard");
    expect(loadRentalVariantDraft("property-1", "short_term")?.axisId).toBe("APP-short");
    expect(loadRentalVariantDraft("property-1", "standard")).toMatchObject({ applicationTemplateVersion: 1, customFieldAnswers: [{ key: "standard", value: "standard answer" }] });
    expect(loadRentalVariantDraft("property-1", "short_term")).toMatchObject({ applicationTemplateVersion: 2, customFieldAnswers: [{ key: "short", value: "short answer" }] });
    expect(loadRentalVariantDraft("property-2", "standard")).toBeUndefined();
    clearRentalWizardDraft();
  });

  it("restores only a target-scoped record reference after a module reload", async () => {
    clearRentalWizardDraft();
    const base = { ...createInitialRentalWizardState(), propertyId: "property-1" };
    saveRentalWizardDraft({ ...base, rentalType: "standard", applicationTemplateVersion: 1, customFieldAnswers: [{ key: "private", label: "Private", type: "text", value: "secret" }] });
    saveRentalWizardDraftAxisId("APP-standard");
    vi.resetModules();
    const fresh = await import("@/lib/rental-application/drafts");
    expect(fresh.loadRentalVariantDraft("property-1", "standard")).toMatchObject({ axisId: "APP-standard", serverOnly: true, customFieldAnswers: [] });
    expect(fresh.loadRentalVariantDraft("property-1", "short_term")).toBeUndefined();
    expect(window.sessionStorage.getItem("axis:rental-application:variant-axis-ids:v1")).not.toContain("secret");
    fresh.clearRentalWizardDraft();
  });
});
