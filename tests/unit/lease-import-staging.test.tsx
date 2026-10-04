// @vitest-environment jsdom
//
// F016: uploading a lease file on the property lease editor stages a diff
// (N found / N changed) instead of silently replacing the document — nothing
// changes until "Apply changes from the file", "Discard" leaves the lease
// exactly as it was, and applying is refused for anything that looks like an
// already-executed lease.
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

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

vi.mock("@/lib/lease-template-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-template-storage")>();
  return {
    ...actual,
    uploadLeaseTemplateFile: vi.fn(async (file: File) => ({ url: "https://storage.example/lease-templates/lease.pdf", name: file.name })),
  };
});

const parseUploadedLeasePdf = vi.fn();
vi.mock("@/lib/lease-template-parse.client", () => ({ parseUploadedLeasePdf: (...args: unknown[]) => parseUploadedLeasePdf(...args) }));

// Redesign (studio-redesign-0929, property-lease-apps): a new lease picks "Upload PDF"
// in the "Start from" row (which reveals the strip); a saved lease re-imports through
// the row's Replace action (hidden input).
async function chooseUploadPdf() {
  const trigger = document.querySelector('[data-attr="property-form-start-from"]') as HTMLElement;
  expect(trigger).not.toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByText("Upload a PDF"));
}

function pickLeaseFile(dataAttr = "property-lease-name-upload") {
  const input = (document.querySelector(`[data-attr="${dataAttr}"] input[type="file"]`) ??
    document.querySelector('[data-attr="property-lease-replace-upload-input"]')) as HTMLInputElement;
  expect(input).not.toBeNull();
  const file = new File(["%PDF-1.4"], "lease.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

const TEMPLATE: PropertyLeaseTemplate = {
  ...createPropertyLeaseTemplate({ kind: "long-term", label: "Standard lease", source: { kind: "proplane_default" } as never }),
};

beforeEach(() => {
  parseUploadedLeasePdf.mockReset();
  parseUploadedLeasePdf.mockResolvedValue({
    html: "<h2>Pets</h2><p>No pets allowed.</p>",
    inferredKind: "long-term",
    sectionCount: 1,
    sections: [{ title: "Pets", body: "No pets allowed." }],
    sourceSha256: "a".repeat(64),
    sourceIssues: [],
    coverage: { extractedCharacters: 10, representedCharacters: 10, complete: true },
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("F016: lease upload stages a diff before applying", () => {
  it("does not replace the lease document until Apply is clicked, on a brand-new lease", async () => {
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
    await chooseUploadPdf();

    pickLeaseFile();
    await waitFor(() => expect(parseUploadedLeasePdf).toHaveBeenCalled());
    expect(await screen.findByText(/section.*found/)).toBeTruthy();
    expect(document.querySelector('[data-attr="property-lease-pending-import"]')).not.toBeNull();

    // Nothing applied yet — the html preview never shows the parsed content.
    expect(screen.queryByText("No pets allowed.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Apply changes from the file" }));
    expect(document.querySelector('[data-attr="property-lease-pending-import"]')).toBeNull();
    await waitFor(() => expect(screen.getAllByText(/No pets allowed\./).length).toBeGreaterThan(0));
  });

  it("Discard leaves an already-saved lease's document untouched", async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={{
          ...TEMPLATE,
          applicationLeaseTerms: ["Long-term"],
          // Already in "upload" document mode (no separate document URL yet)
          // so picking a file does not ALSO trigger the pre-existing
          // document-mode switch, which itself clears `htmlOverride` —
          // isolating exactly the staging behavior under test.
          leaseConfigMode: "custom",
          leaseCustomKind: "document",
          leaseTemplateHtmlOverride: "<h2>Fees</h2><p>Rent is $1,000.</p>",
        }}
        templates={[TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={onSave}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });
    // This existing lease has real content already (no separate document
    // upload URL is set, so the Sections-step card is reachable directly).
    expect(screen.getAllByText(/Rent is \$1,000\./).length).toBeGreaterThan(0);

    pickLeaseFile();
    await waitFor(() => expect(parseUploadedLeasePdf).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-attr="property-lease-pending-import"]')).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(document.querySelector('[data-attr="property-lease-pending-import"]')).toBeNull();

    // The original content is exactly as it was.
    expect(screen.getAllByText(/Rent is \$1,000\./).length).toBeGreaterThan(0);
    expect(screen.queryByText("No pets allowed.")).toBeNull();
  });

  it("refuses to apply onto something that looks like an already-executed lease", async () => {
    const executedLikeTemplate = { ...TEMPLATE, applicationLeaseTerms: ["Long-term"], fullySignedAt: "2026-01-01T00:00:00.000Z" } as unknown as PropertyLeaseTemplate;
    render(
      <PropertyLeaseFormModal
        open
        mode="edit"
        sub={createDefaultListingSubmission()}
        template={executedLikeTemplate}
        templates={[TEMPLATE]}
        propertyId="mgr-house-1"
        onClose={() => {}}
        onSave={async () => true}
        showToast={() => {}}
      />,
    );
    await screen.findByRole("dialog", { name: "Edit lease" });

    pickLeaseFile();
    // The parse never even starts — the picker refuses up front.
    expect(parseUploadedLeasePdf).not.toHaveBeenCalled();
    expect(await screen.findByText("This lease has already been signed and cannot be edited here.")).toBeTruthy();
  });
});
