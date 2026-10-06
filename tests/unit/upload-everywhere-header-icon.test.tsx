// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DocumentsStep } from "@/components/portal/resident-wizard/step-documents";
import { LeaseStep } from "@/components/portal/resident-wizard/step-lease";
import { ApplicationStep } from "@/components/portal/resident-wizard/step-application";
import type { ResidentWizardDerived } from "@/components/portal/resident-wizard/derived";
import { emptyAddPersonForm } from "@/components/portal/resident-wizard/state";
import {
  fillOnlyBlank,
  mapParsedFieldsToApplicationAnswers,
} from "@/lib/resident-document-import/apply-parsed-to-add-resident";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const derivedStub: ResidentWizardDerived = {
  roomOptions: [],
  bundleOptions: [],
  leaseTermOptions: [],
  leaseTermPresetValues: [],
  rentedByRoom: false,
  entireHome: true,
  showBundleSelect: false,
  showRoomSelect: false,
  rentalType: "standard",
  isShortTerm: false,
  isAirbnb: false,
  isMonthToMonth: false,
  applicationConfig: null,
  customQuestions: [],
  fieldEnabled: () => true,
  listingSays: null,
};

afterEach(() => cleanup());

describe("Application step: the step's Start from a file card", () => {
  const renderStep = (props: { onPickApplicationFile?: (file: File) => void }) =>
    render(<ApplicationStep form={emptyAddPersonForm("resident")} patch={() => {}} derived={derivedStub} propertyLabel="12 Elm" {...props} />);

  it("draws exactly one upload entry (the card, no inline icon) with the real formats and hands the file to the door", () => {
    const onPick = vi.fn();
    const { container } = renderStep({ onPickApplicationFile: onPick });
    expect(container.querySelectorAll('[data-attr="residents-wizard-application-upload"]')).toHaveLength(1);
    expect(screen.getByText("Start from a file")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload application" })).toBeNull();
    for (const chip of [".pdf", "images", "PDF up to 3.5 MB"]) expect(screen.getByText(chip)).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('[data-attr="residents-wizard-application-upload-input"]');
    expect(input).not.toBeNull();
    const file = new File(["%PDF"], "application.pdf", { type: "application/pdf" });
    fireEvent.change(input!, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith(file);
  });

  it("draws no card when the door passes no handler (edit mode)", () => {
    const { container } = renderStep({});
    expect(container.querySelector('[data-attr="residents-wizard-application-upload"]')).toBeNull();
  });

  it("the parsed fields it feeds land as application answers through the mapper, blanks only", () => {
    const fill = mapParsedFieldsToApplicationAnswers([
      { key: "employer", value: "Puget Sound Energy", confidence: "high" },
      { key: "monthlyIncome", value: "$5,400", confidence: "medium" },
    ]);
    const { next, filledKeys } = fillOnlyBlank({ employer: "Typed Co", monthlyIncome: "" }, fill.answers);
    expect(next).toMatchObject({ employer: "Typed Co", monthlyIncome: "5400" });
    expect(filledKeys).toEqual(["monthlyIncome"]);
  });

  it("add-resident wires that icon to readPdf(kind = application) -> applyParsed -> the mapper", () => {
    const wizard = read("src/components/portal/resident-wizard/index.tsx");
    expect(wizard).toContain("onPickApplicationFile");
    expect(wizard).toContain('readPdf(file, "application")');
    expect(wizard).toContain("mapParsedFieldsToApplicationAnswers(parsed.fields)");
    expect(wizard).toContain("onPickApplicationFile={mode === \"edit\" ? undefined : onPickApplicationFile}");
  });
});

describe("Add resident: every step with an upload path carries its own card", () => {
  it("Documents step: one card wired to the attach handler, no second '+ Add document' entry", () => {
    const onPick = vi.fn();
    const { container } = render(<DocumentsStep form={emptyAddPersonForm("resident")} patch={() => {}} onPickFile={onPick} busy={false} />);
    expect(container.querySelectorAll('[data-attr="residents-wizard-documents-upload"]')).toHaveLength(1);
    expect(container.querySelector('[data-attr="residents-wizard-documents-add"]')).toBeNull();
    const input = container.querySelector<HTMLInputElement>('[data-attr="residents-wizard-documents-input"]');
    const file = new File(["x"], "id.png", { type: "image/png" });
    fireEvent.change(input!, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith(file);
  });

  it("Lease step: a PDF-only card at the top replaces the inline dropzone and reads through the lease reader", () => {
    const onPick = vi.fn();
    const { container } = render(<LeaseStep form={emptyAddPersonForm("resident")} patch={() => {}} derived={derivedStub} onPickLeasePdf={onPick} busy={false} />);
    expect(container.querySelectorAll('[data-attr="residents-wizard-lease-upload"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-attr="residents-wizard-lease-pdf-input"]')).toHaveLength(1);
    expect(container.querySelector('[data-attr="residents-wizard-lease-pdf-choose"]')).toBeNull();
    expect(screen.getByText("up to 3.5 MB")).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('[data-attr="residents-wizard-lease-pdf-input"]');
    expect(input!.accept).toBe("application/pdf");
    const file = new File(["%PDF"], "lease.pdf", { type: "application/pdf" });
    fireEvent.change(input!, { target: { files: [file] } });
    expect(onPick).toHaveBeenCalledWith(file);
  });
});

describe("one header Upload icon on every step of each add pop-up", () => {
  it("the shared icon is inline-capable so a step heading can host one without the header portal", () => {
    const action = read("src/components/portal/add-workspace/upload-action.tsx");
    expect(action).toContain("inline = false");
    expect(action).toContain("target && !inline ? createPortal");
  });

  it("Add resident: header icon -> the Contact strip's reader, off in edit and for a plain prospect", () => {
    const wizard = read("src/components/portal/resident-wizard/index.tsx");
    expect(wizard).toMatch(/headerUpload=\{mode !== "edit" && \(form\.kind !== "prospect" \|\| mode === "application"\)/);
    expect(wizard).toContain("onPick: onPickStartFileFromHeader");
    expect(wizard).toContain('goTo("contact")');
    expect(wizard).toContain("onPickStartFile(file)");
  });

  it("Add lease: header icon -> the strip's handler (parseUploadedLeasePdf, staged for confirm), Add mode only", () => {
    const lease = read("src/components/portal/property-lease-form-modal.tsx");
    expect(lease).toContain('headerUpload={mode === "add" ?');
    expect(lease).toContain("onPick: onPickLeaseFromHeader");
    const handler = lease.slice(lease.indexOf("const onPickLeaseFromHeader"), lease.indexOf("const applyPendingLeaseImport"));
    expect(handler).toContain("setStepIdx(0)");
    expect(handler).toContain('setStartFrom("upload")');
    expect(handler).toContain("onPickLeaseTemplateDoc(file)");
    expect(lease).toContain("parseUploadedLeasePdf({ url: dataUrl");
    expect(lease).toContain("accept={LEASE_UPLOAD_ACCEPT}");
  });

  it("Add move-in form: header icon -> uploadMoveInFormPdf with Start from = Upload a PDF, Add mode only", () => {
    const form = read("src/components/portal/move-in-forms/move-in-form-editor-modal.tsx");
    expect(form).toContain('headerUpload={mode === "add" && canUploadPdf ?');
    expect(form).toContain("onPick: pickPdfFromHeader");
    const handler = form.slice(form.indexOf("const pickPdfFromHeader"), form.indexOf('/** "Start from"'));
    expect(handler).toContain("setStep(0)");
    expect(handler).toContain('changeStartsFrom("upload")');
    expect(handler).toContain("void pickPdf(file)");
    expect(form).toContain("uploadMoveInFormPdf(propertyId, draft.id, file)");
    // the inline drop zone stays
    expect(form).toContain('data-attr="move-in-form-pdf-drop"');
  });

  it("New promotion: header icon picks 'Upload your own' (through the switch confirm) and feeds the composer", () => {
    const modal = read("src/components/portal/promotion-new-modal.tsx");
    expect(modal).toContain("headerUpload={{ accept: PROMOTION_UPLOAD_ACCEPT");
    const handler = modal.slice(modal.indexOf("const pickUploadFromHeader"), modal.indexOf("const saveUpload"));
    expect(handler).toContain('requestSwitch("upload")');
    expect(handler).toContain("setUploadFile(file)");
    expect(handler).toContain("setStepIdx(1)");
    const composer = read("src/components/portal/promotion-upload-composer.tsx");
    expect(composer).toContain("export const PROMOTION_UPLOAD_ACCEPT");
    expect(composer).toContain("accept={PROMOTION_UPLOAD_ACCEPT}");
  });
});
