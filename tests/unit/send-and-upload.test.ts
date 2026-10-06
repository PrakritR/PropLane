/**
 * Leasing pipeline, Send & upload: the form a manager sends, the lease form Send lease opens on,
 * and an upload for one resident.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { createPropertyApplicationTemplate, type ApplicationTemplateQuestionConfig, type PropertyApplicationTemplate } from "@/lib/property-application-templates";
import { createPropertyLeaseTemplate, type PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import {
  applicationFormChoicesForProperty,
  applicationFormIdForLink,
  applicationPinForLinkedForm,
  defaultApplicationFormId,
  leaseFeeForSend,
  leaseFormChoicesForApplication,
} from "@/lib/send-forms";
import { buildManagerApplyUrl } from "@/lib/manager-property-links";
import { buildApplicationRow } from "@/lib/resident-document-import/build-application-row";
import {
  uploadForResidentFields,
  uploadForResidentReview,
  uploadFormFields,
  uploadResidentOptions,
} from "@/lib/resident-document-import/upload-for-resident";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/lease-send-terms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lease-send-terms")>()),
  leaseSendSchedule: (applicant: { application?: { managerLeaseFeeWaiver?: unknown } }) =>
    applicant.application?.managerLeaseFeeWaiver ? [] : [{ key: "lease_fee", label: "Lease fee", amount: 150 }],
}));

const existingRow = {
  id: "PROPLANE-EXIST1",
  name: "Maya Chen",
  email: "maya@example.test",
  bucket: "pending",
  stage: "Application",
  property: "Fremont",
  managerUserId: "mgr-1",
  application: { propertyId: "prop-1", phone: "(206) 555-0199" },
} as unknown as DemoApplicantRow;

vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
  readManagerApplicationRows: () => [existingRow],
}));

const published = {
  version: 1,
  disabledStandardApplicationKeys: [],
  customApplicationFields: [],
  applicationConfigMode: "standard",
} as unknown as ApplicationTemplateQuestionConfig;
const lease = (label: string, terms: string[]) =>
  ({ ...createPropertyLeaseTemplate({ kind: "long-term", label, source: "axis_default" }), applicationLeaseTerms: terms }) as PropertyLeaseTemplate;
const form = (label: string, extra: Partial<PropertyApplicationTemplate> = {}) =>
  ({ ...createPropertyApplicationTemplate({ kind: "long-term", label }), publishedQuestionConfig: published, ...extra }) as PropertyApplicationTemplate;

const longLease = lease("Long-term lease", ["Long-term"]);
const mtmLease = lease("Month-to-month lease", ["Month-to-Month"]);
const longForm = form("Standard application", { linkedLeaseTemplateId: longLease.id });
const mtmForm = form("Month-to-month application", { linkedLeaseTemplateId: mtmLease.id });
const draftForm = { ...form("Draft only"), publishedQuestionConfig: undefined } as PropertyApplicationTemplate;
const sub = normalizeManagerListingSubmissionV1({
  ...createDefaultListingSubmission(),
  propertyLeaseTemplates: [longLease, mtmLease],
  propertyApplicationTemplates: [longForm, mtmForm, draftForm],
});

describe("Send application: the form picker drives the link", () => {
  it("offers the property's published application forms, never a draft", () => {
    const choices = applicationFormChoicesForProperty(sub);
    expect(choices.map((c) => c.id).sort()).toEqual([longForm.id, mtmForm.id].sort());
    expect(choices.map((c) => c.id)).not.toContain(draftForm.id);
    expect(choices.find((c) => c.id === mtmForm.id)?.leaseLabel).toBe("Month-to-month lease");
    expect(defaultApplicationFormId(choices)).toBe(choices[0]!.id);
  });

  it("a link carries the chosen form; the default form and unknown forms carry nothing", () => {
    const [first, second] = applicationFormChoicesForProperty(sub);
    expect(applicationFormIdForLink(sub, second!.id)).toBe(second!.id);
    expect(applicationFormIdForLink(sub, first!.id)).toBeUndefined();
    expect(applicationFormIdForLink(sub, "app-tpl-not-this-property")).toBeUndefined();
    expect(applicationFormIdForLink(sub, draftForm.id)).toBeUndefined();
    expect(applicationFormIdForLink(sub, "")).toBeUndefined();
  });

  it("the apply url names the form, and only when one is chosen", () => {
    const url = new URL(buildManagerApplyUrl("https://app.example.test", { propertyId: "prop-1", applicationFormId: mtmForm.id }));
    expect(url.pathname).toBe("/rent/apply");
    expect(url.searchParams.get("form")).toBe(mtmForm.id);
    expect(new URL(buildManagerApplyUrl("https://app.example.test", { propertyId: "prop-1" })).searchParams.has("form")).toBe(false);
  });

  it("the resident's wizard pins exactly that form, and only if it is still published", () => {
    expect(applicationPinForLinkedForm(sub, mtmForm.id)).toEqual({ templateId: mtmForm.id, templateVersion: 1 });
    expect(applicationPinForLinkedForm(sub, draftForm.id)).toBeNull();
    expect(applicationPinForLinkedForm(sub, "nope")).toBeNull();
    expect(applicationPinForLinkedForm(sub, undefined)).toBeNull();
  });

  it("is wired end to end: modal posts it, the route re-validates it, the wizard honours it over the lease type", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const modal = read("src/components/portal/share-lead-link-modal.tsx");
    expect(modal).toContain("applicationFormChoicesForProperty");
    expect(modal).toContain('label="Application form"');
    expect(modal).toContain("applicationFormId: kind === \"apply\" && !isMultiApply");
    const route = read("src/app/api/portal/send-lead-invite/route.ts");
    expect(route).toContain("applicationFormIdForLink(");
    expect(route).toContain("applicationFormId,");
    const wizard = read("src/components/marketing/rental-application-wizard.tsx");
    expect(wizard).toContain("applicationPinForLinkedForm(submission, linkedFormIdRef.current)");
    expect(wizard).toContain("formChosenByLink");
  });
});

describe("Send lease: the form picker and the fee waiver", () => {
  it("defaults to the lease the application's form maps to, and the others stay selectable", () => {
    const application = { leaseTerm: "Month-to-Month", rentalType: "standard" as const, applicationTemplateId: mtmForm.id };
    const { choices, defaultId } = leaseFormChoicesForApplication(sub, application);
    expect(defaultId).toBe(mtmLease.id);
    expect(choices[0]!.id).toBe(mtmLease.id);
    expect(choices.map((c) => c.id)).toContain(longLease.id);
    expect(leaseFormChoicesForApplication(sub, { ...application, leaseTerm: "Long-term", applicationTemplateId: longForm.id }).defaultId).toBe(longLease.id);
  });

  it("a property with no lease forms offers no picker", () => {
    expect(leaseFormChoicesForApplication(null, {}).choices).toEqual([]);
  });

  it("shows the nominal lease fee even when it is waived, so the waiver can be restored", () => {
    const open = { application: {} } as Parameters<typeof leaseFeeForSend>[0];
    expect(leaseFeeForSend(open, "mgr-1")).toEqual({ fee: 150, waived: false });
    const waived = {
      application: { managerLeaseFeeWaiver: { waivedAtIso: "2026-10-03T00:00:00.000Z", waivedByUserId: "mgr-1", reason: "x" } },
    } as unknown as Parameters<typeof leaseFeeForSend>[0];
    expect(leaseFeeForSend(waived, "mgr-1")).toEqual({ fee: 150, waived: true });
  });

  it("the sheet calls the existing per-lease waiver route and reinstate, nothing new", () => {
    const sheet = readFileSync(path.join(process.cwd(), "src/components/portal/lease-send-sheet.tsx"), "utf8");
    expect(sheet).toContain("waiveLeaseFeeForLease(lease.id");
    expect(sheet).toContain("reinstateLeaseFeeForLease(lease.id)");
    expect(sheet).toContain('label="Lease form"');
  });
});

describe("Upload for resident: parsed values fill the normal form and create for that resident", () => {
  const parse = {
    kind: "application",
    fileName: "filled-application.pdf",
    extractedCharacterCount: 900,
    fields: [
      { key: "tenantName", label: "Name", value: "M. Chen", confidence: "high", source: "ai" },
      { key: "tenantEmail", label: "Email", value: "someone-else@example.test", confidence: "high", source: "ai" },
      { key: "dateOfBirth", label: "Date of birth", value: "1998-04-12", confidence: "high", source: "ai" },
      { key: "employer", label: "Employer", value: "Acme", confidence: "medium", source: "ai" },
      { key: "monthlyIncome", label: "Monthly income", value: "$4,200", confidence: "high", source: "ai" },
    ],
    residentMatch: { kind: "new" },
    propertyMatch: null,
    suggestedApplicationBucket: "approved",
    suggestedLeaseBucket: "manager",
    warnings: [],
  } as unknown as ParsedResidentDocument;

  it("lists the manager's residents, with their home", () => {
    const [maya] = uploadResidentOptions([existingRow], "mgr-1");
    expect(maya).toMatchObject({ id: existingRow.id, name: "Maya Chen", email: "maya@example.test", propertyId: "prop-1" });
    expect(uploadResidentOptions([existingRow], "mgr-2")).toEqual([]);
  });

  it("the picked resident's identity wins over what the PDF says", () => {
    const [maya] = uploadResidentOptions([existingRow], "mgr-1");
    const fields = uploadForResidentFields(parse, maya!);
    expect(fields.tenantName).toBe("Maya Chen");
    expect(fields.tenantEmail).toBe("maya@example.test");
    expect(fields.dateOfBirth).toBe("1998-04-12");
    // The form shows what the application answered, and nothing it did not.
    const keys = uploadFormFields("application", fields).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["tenantName", "dateOfBirth", "employer", "monthlyIncome"]));
    expect(keys).not.toContain("jobTitle");
    // A lease upload shows the lease terms instead.
    expect(uploadFormFields("lease", fields).map((f) => f.key)).toEqual(expect.arrayContaining(["leaseStart", "monthlyRent", "securityDeposit"]));
  });

  it("builds a review for the existing resident with no verify step: Create is the confirmation", () => {
    const [maya] = uploadResidentOptions([existingRow], "mgr-1");
    const review = uploadForResidentReview({
      kind: "application",
      target: { mode: "existing", resident: maya! },
      parse,
      file: { name: "filled-application.pdf" },
      dataUrl: "data:application/pdf;base64,AAAA",
      fields: { ...uploadForResidentFields(parse, maya!), tenantEmail: "typo@example.test" },
      propertyId: "prop-1",
      roomId: "",
    });
    expect(review.residentMode).toBe("existing");
    expect(review.existingApplicationId).toBe(existingRow.id);
    expect(review.fields.tenantEmail).toBe("maya@example.test");
    expect(review.sendAccountSetup).toBe(false);
    expect(Object.keys(review)).not.toContain("verified");
  });

  it("a new resident is created and told how to sign in; a signed lease is filed as signed", () => {
    const review = uploadForResidentReview({
      kind: "lease",
      target: { mode: "new" },
      parse: { ...parse, kind: "lease", suggestedLeaseBucket: "signed" } as ParsedResidentDocument,
      file: { name: "lease.pdf" },
      dataUrl: "data:application/pdf;base64,AAAA",
      fields: { tenantName: "New Person", tenantEmail: "new@example.test" },
      propertyId: "prop-1",
      roomId: "room-a",
    });
    expect(review.residentMode).toBe("new");
    expect(review.sendAccountSetup).toBe(true);
    expect(review.leaseFullyExecuted).toBe(true);
  });

  it("an application uploaded for an existing resident fills their application in and never moves their stage", () => {
    const [maya] = uploadResidentOptions([existingRow], "mgr-1");
    const row = buildApplicationRow({
      parse,
      review: uploadForResidentReview({
        kind: "application",
        target: { mode: "existing", resident: maya! },
        parse,
        file: { name: "filled-application.pdf" },
        dataUrl: "data:application/pdf;base64,AAAA",
        fields: uploadForResidentFields(parse, maya!),
        propertyId: "prop-1",
        roomId: "",
      }),
      managerUserId: "mgr-1",
      propertyLabel: "Fremont",
    });
    expect(row.id).toBe(existingRow.id);
    expect(row.bucket).toBe("pending");
    expect(row.stage).toBe("Application");
    expect(row.email).toBe("maya@example.test");
    expect(row.application).toMatchObject({ dateOfBirth: "1998-04-12", employer: "Acme", monthlyIncome: "4200" });
  });

  it("is reachable from an application row, the Add pop-ups' Start from a file cards and the resident Add document pop-up, never a header icon beside the +", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    // No list header draws an Upload icon next to the round +: the row menu, the Add pop-ups and Add document carry it.
    expect(read("src/components/portal/pro-applications.tsx")).toContain('label: "Upload for resident"');
    expect(read("src/components/portal/pro-applications.tsx")).not.toContain('data-attr="applications-upload-for-resident"');
    expect(read("src/components/portal/pro-leases.tsx")).not.toContain('Upload for resident');
    expect(read("src/components/portal/pro-leases.tsx")).not.toContain("icon={Upload}");
    expect(read("src/components/portal/pro-properties.tsx")).not.toContain("icon={Upload}");
    expect(read("src/components/portal/lease-send-sheet.tsx")).toContain('dataAttr="lease-send-header-upload"');
    expect(read("src/components/portal/lease-send-sheet.tsx")).toContain("<WorkspaceFileCard");
    expect(read("src/components/portal/pro-properties.tsx")).toContain('router.push("/portal/properties/import")');
    expect(read("src/components/portal/listing-wizard-v2/create-workspace.tsx")).toContain("Import a portfolio");
    expect(read("src/components/portal/manager-resident-upload-modal.tsx")).toContain('label: "Read a filled application or lease"');
    // The resident record header is only Edit and Delete; each action sits in the tab it belongs to.
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(read("src/lib/portals/record-sections.ts")).not.toContain('id: "upload-for-resident"');
    expect(residents).toContain("onReadForResident");
    expect(read("src/lib/resident-record-section-actions.ts")).toContain('id: "send-application"');
    // Upload completed application is a Start-from-a-file card in the Send application pop-up, not a ⋯ item.
    expect(residents).toContain("onUploadCompletedApplication=");
    expect(read("src/components/portal/share-lead-link-modal.tsx")).toContain('dataAttr: "share-lead-header-upload"');
    expect(residents).toContain('actionId === "send-lease"');
  });
});
