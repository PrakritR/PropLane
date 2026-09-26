// @vitest-environment jsdom
//
// The manager's attestation must never survive a change in WHAT is being
// attested to.
//
// The regression this exists for: `attested` was seeded once from
// `useState(uploadedLeaseReviewIsConfirmed(parse))` and never reset when the
// `parse` prop changed. Both call sites — `manager-residents.tsx` and
// `manager-leases-pipeline-panel.tsx` — render this modal WITHOUT a `key` at a
// stable position, so `onRetryRead` turning a `failed` parse into a `parsed`
// one re-renders the component rather than remounting it, and the tick stayed.
//
// That matters because the two branches ask for materially different things:
//
//   failed → "I have read the original PDF myself."
//   parsed → "I have compared this against the original PDF. The terms above
//             are correct."
//
// A manager who ticked the weaker statement on a failed read and then retried
// successfully arrived at the STRONGER attestation already ticked, having never
// agreed to it — on a lease. These tests drive the real component through the
// real prop transition and assert the box comes back unticked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import {
  buildUploadedLeaseParse,
  failedUploadedLeaseParse,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import { leaseRecordTerms } from "@/lib/lease-pipeline-storage";

const PAGES = [
  [
    "RESIDENTIAL LEASE AGREEMENT",
    "1. PARTIES",
    "This Lease is between Northgate Holdings LLC (Landlord) and Dana Reyes (Tenant).",
    "2. RENT",
    "Tenant shall pay rent of $2,400.00 per month.",
  ].join("\n"),
];

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function parsedParse(sha: string = SHA_A, extractedAtIso = "2026-08-01T10:00:00.000Z"): UploadedLeaseParse {
  return buildUploadedLeaseParse({
    pages: PAGES,
    fileName: "northgate-lease.pdf",
    sourceSha256: sha,
    extractedAtIso,
  });
}

function row(uploadedAt = "2026-08-01T09:00:00.000Z", fileName = "northgate-lease.pdf"): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Dana Reyes",
    residentEmail: "dana@example.com",
    unit: "Unit 4B",
    stageLabel: "Manager review",
    updated: "today",
    bucket: "review" as LeasePipelineRow["bucket"],
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T10:00:00.000Z",
    thread: [],
    managerUploadedPdf: {
      dataUrl: "data:application/pdf;base64,JVBERi0xLjcK",
      fileName,
      uploadedAt,
    },
  };
}

function renderModal(parse: UploadedLeaseParse, r: LeasePipelineRow = row()) {
  return render(
    <UploadedLeaseReviewModal open row={r} parse={parse} onClose={() => {}} onConfirm={() => {}} onRetryRead={() => {}} />,
  );
}

/** Re-render at the same position with no `key`, exactly like both call sites. */
function rerenderModal(
  rerender: (ui: React.ReactElement) => void,
  parse: UploadedLeaseParse,
  r: LeasePipelineRow = row(),
) {
  rerender(
    <UploadedLeaseReviewModal open row={r} parse={parse} onClose={() => {}} onConfirm={() => {}} onRetryRead={() => {}} />,
  );
}

// The modal is a Radix dialog, so it portals to `document.body` rather than
// into RTL's `container`.
const attestBox = () => document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-attest"]');
const confirmBtn = () => document.body.querySelector<HTMLButtonElement>('[data-attr="uploaded-lease-confirm"]');
const rentInput = () =>
  document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-field-monthlyRent"]');
const shownText = () => document.body.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("uploaded lease attestation carryover", () => {
  it("submits the exact displayed source, revision, and record terms for confirmation", async () => {
    const onConfirm = vi.fn();
    const r = { ...row(), reviewRevision: "2026-09-24T00:00:00.000Z" };
    render(<UploadedLeaseReviewModal open row={r} parse={parsedParse()} onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(attestBox()!);
    fireEvent.click(confirmBtn()!);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
    expect(onConfirm.mock.calls[0]![0]).toMatchObject({
      expectedRevision: r.reviewRevision,
      viewedSourceSha256: SHA_A,
      viewedConvertedHtmlSha256: null,
      viewedRecordFingerprint: leaseRecordFingerprint(leaseRecordTerms(r)),
    });
  });
  it("unticks the attestation when a failed parse is retried into a parsed one", () => {
    const { rerender } = renderModal(failedUploadedLeaseParse("northgate-lease.pdf", "Scanned image only."));

    const failedBox = attestBox();
    expect(failedBox).not.toBeNull();
    fireEvent.click(failedBox!);
    expect(attestBox()!.checked).toBe(true);
    expect(shownText()).toContain("I have read the original PDF myself");

    // What `onRetryRead` + `syncLeasePipelineFromServer` does: same component
    // instance, new parse prop.
    rerenderModal(rerender, parsedParse());

    // The stronger statement is now on screen...
    expect(shownText()).toContain("I have compared this against the original PDF");
    // ...and the manager has not agreed to it.
    expect(attestBox()!.checked).toBe(false);
    expect(confirmBtn()!.disabled).toBe(true);
  });

  it("unticks the attestation when the underlying document changes", () => {
    const { rerender } = renderModal(parsedParse(SHA_A));

    fireEvent.click(attestBox()!);
    expect(attestBox()!.checked).toBe(true);

    // A different document swapped in under an open review.
    rerenderModal(rerender, parsedParse(SHA_B));

    expect(attestBox()!.checked).toBe(false);
    expect(confirmBtn()!.disabled).toBe(true);
  });

  it("unticks the attestation when the same bytes are re-read into a new reading", () => {
    const { rerender } = renderModal(parsedParse(SHA_A, "2026-08-01T10:00:00.000Z"));

    fireEvent.click(attestBox()!);
    expect(attestBox()!.checked).toBe(true);

    // A re-read of the SAME PDF: the digest is unchanged, so a digest-only
    // identity would miss this. The reading is new, so the tick must clear.
    rerenderModal(rerender, parsedParse(SHA_A, "2026-08-01T11:30:00.000Z"));

    expect(attestBox()!.checked).toBe(false);
  });

  it("keeps the tick across a re-render that does not change what is attested to", () => {
    // A background `syncLeasePipelineFromServer` hands back an equal-but-new
    // parse object on a cadence. Keying the reset on object identity would clear
    // the box under the manager's fingers, so this pins content-based identity.
    const { rerender } = renderModal(parsedParse(SHA_A));

    fireEvent.click(attestBox()!);
    expect(attestBox()!.checked).toBe(true);

    rerenderModal(rerender, parsedParse(SHA_A));

    expect(attestBox()!.checked).toBe(true);
    expect(confirmBtn()!.disabled).toBe(false);
  });

  it("unticks the attestation when a different unreadable document replaces the first", () => {
    // Both parses are `failed`, so both carry `sourceSha256: null`, no
    // `extractedAtIso` and no fields — every failed parse looks alike. The
    // weaker statement is still about ONE specific PDF ("I have read the
    // original PDF myself"), so a tick made against one unreadable document
    // must not carry onto another.
    const first = failedUploadedLeaseParse("northgate-lease.pdf", "Scanned image only.");
    const { rerender } = renderModal(first, row("2026-08-01T09:00:00.000Z", "northgate-lease.pdf"));

    fireEvent.click(attestBox()!);
    expect(attestBox()!.checked).toBe(true);

    const second = failedUploadedLeaseParse("harborview-lease.pdf", "Scanned image only.");
    rerenderModal(rerender, second, row("2026-08-02T14:00:00.000Z", "harborview-lease.pdf"));

    expect(attestBox()!.checked).toBe(false);
    expect(confirmBtn()!.disabled).toBe(true);
  });

  it("resets without tripping a React warning", () => {
    // The reset runs DURING render. That is legal only for the component's own
    // state — updating another component from render logs "Cannot update a
    // component while rendering a different component" and, if the subject were
    // ever unstable, would loop until React threw "Too many re-renders". Both
    // would be invisible to the assertions above, so pin them here.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { rerender } = renderModal(failedUploadedLeaseParse("northgate-lease.pdf", "Scanned image only."));
    fireEvent.click(attestBox()!);
    rerenderModal(rerender, parsedParse());
    rerenderModal(rerender, parsedParse());

    expect(attestBox()!.checked).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not carry manager-typed overrides onto a different document", () => {
    // `onConfirm` submits `drafts` as human-confirmed overrides, and the table
    // badges them "Manager entered". Carrying them across a document change
    // would attribute a value to the manager that they never typed for THIS
    // lease.
    const { rerender } = renderModal(parsedParse(SHA_A));

    expect(rentInput()).not.toBeNull();
    fireEvent.change(rentInput()!, { target: { value: "$9,999.00" } });
    expect(rentInput()!.value).toBe("$9,999.00");

    rerenderModal(rerender, parsedParse(SHA_B));

    expect(rentInput()!.value).not.toBe("$9,999.00");
  });
});
