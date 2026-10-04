/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-property-pipeline", () => ({ readExtraListingsForUser: () => [] }));
vi.mock("@/lib/manager-portfolio-access", () => ({
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
  resolvePropertyLabelForId: (id: string) => id,
}));

import { PropertyResidentOnboardWizard } from "@/components/portal/property-resident-onboard-wizard";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

function renderDialog() {
  return render(
    <PropertyResidentOnboardWizard
      open
      propertyId="p1"
      propertyLabel="Magnolia House"
      managerUserId="m1"
      onClose={() => {}}
      onImported={() => {}}
      showToast={() => {}}
    />,
  );
}

/** studio-redesign(property-tabs) round 1: Add resident is the standard PortalDialog frame. */
describe("PropertyResidentOnboardWizard (Add resident)", () => {
  it("has no context column, no subtext header and a meaningful resident preview", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Add resident" });
    expect(dialog.querySelector("[data-popup-context]")).toBeNull();
    expect(dialog.textContent).not.toContain("Upload an application PDF and/or lease PDF");
    expect(dialog.textContent).not.toContain("Email portal account setup instructions after import. Yes");
    const preview = dialog.querySelector("[data-popup-preview]")!;
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain("New resident");
    expect(preview.textContent).not.toContain("Not set");
  });

  it("keeps the two upload tiles at the top", () => {
    renderDialog();
    expect(document.querySelector('[data-attr="property-onboard-application-pdf"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="property-onboard-lease-pdf"]')).toBeTruthy();
  });

  it("the primary action lives in the frame's footer, not the body", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Add resident" });
    const primary = screen.getByRole("button", { name: "Import resident" });
    expect(primary.getAttribute("data-attr")).toBe("property-onboard-import");
    const footer = primary.closest("[data-field-select-host-footer]");
    expect(footer).toBeTruthy();
    expect(dialog.querySelector("[data-popup-form]")!.contains(primary)).toBe(false);
    expect(dialog.querySelectorAll('[data-attr="property-onboard-import"]')).toHaveLength(1);
  });

  it("labels are sentence case with no asterisks; optional fields say Optional; account setup is a switch", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Add resident" });
    const form = dialog.querySelector("[data-popup-form]")!;
    const labels = Array.from(form.querySelectorAll("label span, [data-wizard-picker] > span")).map((el) => el.textContent ?? "");
    expect(labels.length).toBeGreaterThan(5);
    for (const text of labels) {
      expect(text).not.toContain("*");
      expect(text === text.toUpperCase() && /[A-Z]{3,}/.test(text), text).toBe(false);
    }
    expect(form.textContent).toContain("Optional");
    expect(form.querySelector('[data-attr="property-onboard-tenantName"]')).toBeTruthy();
    const toggle = form.querySelector('[role="switch"][data-attr="property-onboard-send-setup"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(form.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("source: no ALL-CAPS label class, no raw date input, no <select>", () => {
    const src = readFileSync(join(__dirname, "..", "..", "src/components/portal/property-resident-onboard-wizard.tsx"), "utf8");
    expect(src).not.toContain("MODAL_FIELD_LABEL_CLASS");
    expect(src).not.toMatch(/\buppercase\b/);
    expect(src).not.toContain('type="date"');
    expect(src).not.toContain("<Select");
    expect(src).not.toContain("<ModalFooter");
  });
});
