// @vitest-environment jsdom
//
// Application, Lease and Move-in each take an uploaded PDF from the wizard (captain, Oct 3: "be able to upload
// applications, leases, move-in forms"). The step's round + offers the same choices the property tabs' + offer,
// "Upload a PDF" runs the EXISTING upload for that step (mocked here), and a brand-new draft with no saved
// property is saved first through the editor's `ensureSaved`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
  readAdminPropertyRows: vi.fn(() => []),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

const importApplicationPdf = vi.fn();
const importLeasePdf = vi.fn();
const uploadMoveInFormPdf = vi.fn();
vi.mock("@/components/portal/listing-wizard-v2/inline-application-upload", () => ({
  importApplicationPdf: (...args: unknown[]) => importApplicationPdf(...args),
}));
vi.mock("@/components/portal/listing-wizard-v2/inline-lease-upload", () => ({
  importLeasePdf: (...args: unknown[]) => importLeasePdf(...args),
}));
vi.mock("@/lib/move-in-forms/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/move-in-forms/client")>();
  return { ...actual, uploadMoveInFormPdf: (...args: unknown[]) => uploadMoveInFormPdf(...args) };
});

import { ListingEditorV2 } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { readPropertyApplicationTemplates } from "@/lib/property-application-templates";
import { readPropertyLeaseTemplates } from "@/lib/property-lease-templates";
import { MOVE_IN_FORM_STARTERS, readMoveInFormTemplates } from "@/lib/move-in-forms/templates";

const showToast = vi.fn();
const ensureSaved = vi.fn(async () => "prop-1");

function sub() {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "400 Pike Street",
    rooms: [{ ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1100 }],
  };
}

function mountLive(props: Partial<React.ComponentProps<typeof ListingEditorV2>> = {}) {
  let latest = sub() as ReturnType<typeof sub>;
  function Harness() {
    const [value, setValue] = React.useState(latest);
    return (
      <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
        <ListingEditorV2
          title="400 Pike Street"
          submission={value}
          onChange={(next) => {
            latest = next as ReturnType<typeof sub>;
            setValue(next as ReturnType<typeof sub>);
          }}
          onClose={() => {}}
          onPublish={() => {}}
          managerUserId="manager-1"
          showToast={showToast}
          ensureSaved={ensureSaved}
          {...props}
        />
      </PortalAssistantConfigProvider>
    );
  }
  render(<Harness />);
  return { latest: () => latest };
}

const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
const qa = (selector: string) => Array.from(document.querySelectorAll(selector)) as HTMLElement[];
const go = (id: string) => fireEvent.click(q(`[data-attr='listing-v2-rail-${id}']`)!);

async function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return screen.findAllByRole("menuitem");
}

const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const choose = (fileSelector: string, file: File) => fireEvent.change(q(fileSelector)!, { target: { files: [file] } });

beforeEach(() => {
  showToast.mockReset();
  ensureSaved.mockClear();
  importApplicationPdf.mockReset();
  importLeasePdf.mockReset();
  uploadMoveInFormPdf.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ leasingPipeline: { applicationBeforeTour: "required" } }) })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Application: Upload a PDF", () => {
  it("saves the draft first, runs the existing application import, and adds a card with a PDF fact", async () => {
    importApplicationPdf.mockImplementation(async (args: { templateId: string }) => ({
      draft: {
        version: 0,
        applicationConfigMode: "custom",
        disabledStandardApplicationKeys: [],
        customApplicationFields: [],
        questionDisplayOrder: [],
        importProvenance: { sourceName: "Pike Application.pdf", sourcePath: `u/application-import/${args.templateId}/x.pdf`, sourceSha256: "abc", importedAt: "2026-10-03T00:00:00Z", unresolvedCount: 0, issues: [] },
      },
      issues: [],
      sourcePath: `u/application-import/${args.templateId}/x.pdf`,
    }));
    const live = mountLive();
    go("application");
    const choices = await openMenu(q("[data-attr='listing-v2-add-application-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Build from PropLane standard", "Upload a PDF"]);
    fireEvent.click(choices[1]!);
    choose("[data-attr='listing-v2-application-file']", pdf("Pike Application.pdf"));
    await waitFor(() => expect(importApplicationPdf).toHaveBeenCalledTimes(1));
    // A brand-new draft has no saved property: it is saved first, and the import runs against that id.
    expect(ensureSaved).toHaveBeenCalledTimes(1);
    expect(ensureSaved.mock.invocationCallOrder[0]!).toBeLessThan(importApplicationPdf.mock.invocationCallOrder[0]!);
    expect(importApplicationPdf.mock.calls[0]![0]).toMatchObject({ propertyId: "prop-1" });
    await waitFor(() =>
      expect(readPropertyApplicationTemplates(live.latest()).some((row) => row.draftQuestionConfig?.importProvenance?.sourceName)).toBe(true),
    );
    const created = readPropertyApplicationTemplates(live.latest()).at(-1)!;
    expect(created.draftQuestionConfig?.importProvenance?.sourceName).toBe("Pike Application.pdf");
    const card = qa("[data-attr='listing-v2-application-card']").at(-1)!;
    expect(card.querySelector(".pr9-facts")!.textContent).toContain("PDF");
  });

  it("does not import when the draft cannot be saved", async () => {
    ensureSaved.mockResolvedValueOnce(null as unknown as string);
    mountLive();
    go("application");
    choose("[data-attr='listing-v2-application-file']", pdf("a.pdf"));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not save. Nothing was kept."));
    expect(importApplicationPdf).not.toHaveBeenCalled();
  });

  it("skips the save when the property already exists", async () => {
    importApplicationPdf.mockResolvedValue(null);
    mountLive({ propertyId: "existing-1" });
    go("application");
    choose("[data-attr='listing-v2-application-file']", pdf("a.pdf"));
    await waitFor(() => expect(importApplicationPdf).toHaveBeenCalledTimes(1));
    expect(ensureSaved).not.toHaveBeenCalled();
    expect(importApplicationPdf.mock.calls[0]![0]).toMatchObject({ propertyId: "existing-1" });
  });
});

describe("Lease: Upload a PDF", () => {
  it("offers Add PropLane standard and Upload a PDF; Upload saves the draft, runs the existing lease import and marks the card PDF", async () => {
    importLeasePdf.mockResolvedValue({
      leaseConfigMode: "custom",
      leaseCustomKind: "document",
      leaseTemplateDocUrl: "https://files.example/lease.pdf",
      leaseTemplateDocName: "Pike lease.pdf",
      leaseTemplateHtmlOverride: "",
      leaseTemplateImportReview: undefined,
    });
    const live = mountLive();
    go("lease");
    const choices = await openMenu(q("[data-attr='listing-v2-add-lease-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Add PropLane standard", "Upload a PDF"]);
    fireEvent.click(choices[1]!);
    // The standard lease the upload belongs to is added first.
    expect(readPropertyLeaseTemplates(live.latest()).length).toBe(1);
    choose("[data-attr='listing-v2-lease-file']", pdf("Pike lease.pdf"));
    await waitFor(() => expect(importLeasePdf).toHaveBeenCalledTimes(1));
    expect(ensureSaved).toHaveBeenCalledTimes(1);
    expect(ensureSaved.mock.invocationCallOrder[0]!).toBeLessThan(importLeasePdf.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(readPropertyLeaseTemplates(live.latest())[0]!.leaseTemplateDocName).toBe("Pike lease.pdf"));
    const card = qa("[data-attr='listing-v2-lease-card']")[0]!;
    expect(card.querySelector(".pr9-facts")!.textContent).toContain("PDF");
  });
});

describe("Move-in: Upload a PDF", () => {
  it("offers Build a form, Upload a PDF and Start from a template; Upload saves the draft, runs the existing move-in upload and adds a PDF card", async () => {
    uploadMoveInFormPdf.mockResolvedValue({ pdf: { storagePath: "u/p/form.pdf", fileName: "Intake Form.pdf", pageCount: 2, sha256: "a".repeat(64) } });
    const live = mountLive();
    go("movein");
    const choices = await openMenu(q("[data-attr='listing-v2-add-movein-icon']")!);
    expect(choices.map((item) => item.textContent)).toEqual(["Build a form", "Upload a PDF", "Start from a template"]);
    fireEvent.click(choices[1]!);
    choose("[data-attr='listing-v2-movein-file']", pdf("Pike_Intake Form.pdf"));
    await waitFor(() => expect(uploadMoveInFormPdf).toHaveBeenCalledTimes(1));
    expect(ensureSaved).toHaveBeenCalledTimes(1);
    expect(ensureSaved.mock.invocationCallOrder[0]!).toBeLessThan(uploadMoveInFormPdf.mock.invocationCallOrder[0]!);
    const [propertyId, formId, file] = uploadMoveInFormPdf.mock.calls[0]!;
    expect(propertyId).toBe("prop-1");
    expect((file as File).name).toBe("Pike_Intake Form.pdf");
    await waitFor(() => expect(readMoveInFormTemplates(live.latest()).some((form) => form.source === "upload")).toBe(true));
    const stored = readMoveInFormTemplates(live.latest()).find((form) => form.source === "upload")!;
    expect(stored.id).toBe(formId);
    expect(stored.pdf?.fileName).toBe("Intake Form.pdf");
    expect(stored.trigger).toBe("manual");
    const card = qa("[data-attr='listing-v2-movein-card']").find((node) => node.textContent?.includes("PDF"));
    expect(card).toBeTruthy();
  });

  it("Start from a template adds that starter as the manager's own form", async () => {
    const live = mountLive();
    go("movein");
    const choices = await openMenu(q("[data-attr='listing-v2-add-movein-icon']")!);
    const template = choices.find((item) => item.textContent === "Start from a template")!;
    fireEvent.keyDown(template, { key: "ArrowRight" });
    const starter = MOVE_IN_FORM_STARTERS.find((item) => item.starterKey)!;
    const item = await screen.findByRole("menuitem", { name: starter.name });
    const before = readMoveInFormTemplates(live.latest()).length;
    fireEvent.click(item);
    const forms = readMoveInFormTemplates(live.latest());
    expect(forms.length).toBe(before + 1);
    expect(forms.at(-1)!.starterKey).toBe(starter.starterKey);
    expect(forms.at(-1)!.trigger).toBe("manual");
    expect(uploadMoveInFormPdf).not.toHaveBeenCalled();
  });
});
