// @vitest-environment node
//
// PLAN-0917-1236 Pack 1 — add lease / charge / payment / service / income /
// expense / document upload open the same AddWorkspace rail as Add application.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("Pack 1 add workspaces (source)", () => {
  it("lease, incoming charge, outgoing payment, and service use AddWorkspace instead of a Modal shell", () => {
    const files = [
      "src/components/portal/pro-add-lease-modal.tsx",
      "src/components/portal/pro-add-payment-modal.tsx",
      "src/components/portal/pro-add-outgoing-payment-modal.tsx",
      "src/components/portal/pro-add-service-modal.tsx",
    ];
    for (const file of files) {
      const body = src(file);
      expect(body, file).toContain("<AddWorkspace");
      expect(body, file).not.toMatch(/<Modal[\s\n]+open=\{open\}/);
    }
  });

  it("incoming empty and header still say Add charge", () => {
    const payments = src("src/components/portal/pro-payments.tsx");
    expect(payments).toContain('label: "Add charge"');
    expect(payments).toContain('label="Add charge"');
    expect(src("src/components/portal/pro-add-payment-modal.tsx")).toContain('title="Add charge"');
  });

  it("Who uses the shared workspace helper; Generate / Upload are header icons, not body buttons", () => {
    const lease = src("src/components/portal/pro-add-lease-modal.tsx");
    expect(lease).toContain("buildManagerPropertyFilterOptions");
    expect(lease).toContain("headerActions");
    expect(lease).toContain('data-attr="add-lease-method-generate"');
    expect(lease).toContain('data-attr="add-lease-method-upload"');
    expect(lease).toContain("PortalIconAction");
    expect(lease).not.toMatch(/<Button[\s\S]*?data-attr="add-lease-method-generate"/);
    expect(lease).not.toMatch(/<Button[\s\S]*?data-attr="add-lease-method-upload"/);
  });

  it("charge and service pickers use the shared workspace helper", () => {
    expect(src("src/components/portal/pro-add-payment-modal.tsx")).toContain("buildManagerPropertyFilterOptions");
    expect(src("src/components/portal/pro-add-service-modal.tsx")).toContain("buildManagerPropertyFilterOptions");
  });

  it("outgoing last step is Save and keeps the existing save selector", () => {
    const outgoing = src("src/components/portal/pro-add-outgoing-payment-modal.tsx");
    expect(outgoing).toContain('title="Add payment"');
    expect(outgoing).toContain('lastLabel="Save"');
    expect(outgoing).toContain('finishDataAttr="outgoing-payment-save"');
  });

  it("finances add income and add expense open AddWorkspace", () => {
    const finances = src("src/components/portal/pro-finances-panel.tsx");
    expect(finances).toContain('title="Add income"');
    expect(finances).toContain('title={expenseDraft.id ? "Edit expense" : "Add expense"}');
    expect(finances).toContain("<AddWorkspace");
    expect(finances).not.toMatch(/<Modal[\s\n]+open=\{incomeModal\}/);
    expect(finances).not.toMatch(/<Modal[\s\n]+open=\{expenseModal\}/);
  });

  it("document upload is File → Details → Review on AddWorkspace", () => {
    const docs = src("src/components/portal/pro-document-library.tsx");
    expect(docs).toContain('id: "file"');
    expect(docs).toContain('id: "details"');
    expect(docs).toContain('id: "review"');
    expect(docs).toContain('finishDataAttr="document-upload-submit"');
    expect(docs).toContain("<AddWorkspace");
  });

  it("promotion Kind step also picks the property so Content does not repeat it", () => {
    const promo = src("src/components/portal/promotion-new-modal.tsx");
    expect(promo).toContain('dataAttr="promotion-new-property"');
    expect(promo).toContain("hidePropertyPicker");
  });
});
