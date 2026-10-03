// @vitest-environment jsdom
//
// A lease page headed "Diego Morales / Cascade Lofts · Unit 2A" rendered a PDF
// naming a different tenant, that person's real personal email, a different
// property, a different room and a different rent — with Send fully enabled and
// no warning anywhere. The PDF's content was seeded data; the product bug was
// that nothing objected.
//
// The refusal itself is pinned in `lease-send-guards.test.ts`. This drives the
// real review modal, which is where the manager is told WHAT disagrees and
// where confirming becomes the explicit acknowledgement rather than a reflex.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { UploadedLeaseReviewModal } from "@/components/portal/uploaded-lease-review-modal";
import {
  buildUploadedLeaseParse,
  unreadUploadedLeaseParse,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";
import { leaseRecordTerms, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import {
  resetManagerApplicationRowsToDemo,
  seedDemoManagerApplicationRows,
} from "@/lib/manager-applications-storage";

const WRONG_PARTY_PAGES = [
  [
    "RESIDENTIAL LEASE AGREEMENT",
    "This Lease is between The Pioneer (Landlord) and Shivansh Nikhra (Tenant).",
    "Tenant shall pay rent of $1,450.00 per month.",
  ].join("\n"),
];

const RIGHT_PARTY_PAGES = [
  [
    "RESIDENTIAL LEASE AGREEMENT",
    "This Lease is between Cascade Holdings LLC (Landlord) and Diego Morales (Tenant).",
    "Tenant shall pay rent of $1,050.00 per month.",
  ].join("\n"),
];

function parseOf(pages: string[]): UploadedLeaseParse {
  return buildUploadedLeaseParse({
    pages,
    fileName: "lease.pdf",
    sourceSha256: "a".repeat(64),
    extractedAtIso: "2026-08-01T10:00:00.000Z",
  });
}

function row(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentName: "Diego Morales",
    residentEmail: "diego.morales@example.com",
    unit: "Cascade Lofts · Unit 2A",
    stageLabel: "Manager review",
    updated: "today",
    bucket: "manager",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-08-01T10:00:00.000Z",
    thread: [],
    signedRentLabel: "$1,050.00 / month",
    managerUploadedPdf: {
      dataUrl: "data:application/pdf;base64,JVBERi0xLjcK",
      fileName: "lease.pdf",
      uploadedAt: "2026-08-01T09:00:00.000Z",
    },
    ...overrides,
  };
}

function renderModal(parse: UploadedLeaseParse, r: LeasePipelineRow = row()) {
  return render(
    <UploadedLeaseReviewModal open row={r} parse={parse} onClose={() => {}} onConfirm={() => {}} onRetryRead={() => {}} />,
  );
}

// Radix portals the dialog to `document.body`, not RTL's container.
const panel = () => document.body.querySelector('[data-attr="uploaded-lease-mismatch"]');
const attestBox = () => document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-attest"]');
const rentInput = () =>
  document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-field-monthlyRent"]');
const shownText = () => document.body.textContent ?? "";

afterEach(() => {
  cleanup();
  resetManagerApplicationRowsToDemo();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("the review names what the document disagrees with", () => {
  it("shows each disagreeing term beside the record's own value", () => {
    renderModal(parseOf(WRONG_PARTY_PAGES));

    expect(panel()).not.toBeNull();
    const text = panel()!.textContent ?? "";
    expect(text).toContain("Shivansh Nikhra");
    expect(text).toContain("Diego Morales");
    expect(text).toContain("1,450.00");
    expect(text).toContain("$1,050.00 / month");
    // Named per term, not one lumped warning.
    expect(document.body.querySelector('[data-attr="uploaded-lease-mismatch-tenantName"]')).not.toBeNull();
    expect(document.body.querySelector('[data-attr="uploaded-lease-mismatch-monthlyRent"]')).not.toBeNull();
  });

  it("does not ask for a separate attestation checkbox when terms disagree", () => {
    renderModal(parseOf(WRONG_PARTY_PAGES));

    expect(attestBox()).toBeNull();
    expect(shownText()).toContain("Review imported terms");
    expect(document.body.querySelector('[data-attr="uploaded-lease-confirm"]')).not.toBeNull();
  });

  it("says nothing when the document agrees with the record", () => {
    renderModal(parseOf(RIGHT_PARTY_PAGES));

    expect(panel()).toBeNull();
    expect(shownText()).toContain("Review imported terms");
  });

  it("updates the mismatch panel when the manager edits a disagreeing term", () => {
    renderModal(parseOf(RIGHT_PARTY_PAGES));

    fireEvent.change(rentInput()!, { target: { value: "$4,000.00" } });

    expect(panel()).not.toBeNull();
    expect(rentInput()!.value).toBe("$4,000.00");
  });

  it("keeps edited values while correcting a term to match the record", () => {
    renderModal(parseOf(RIGHT_PARTY_PAGES));

    fireEvent.change(rentInput()!, { target: { value: "$1,050.00" } });

    expect(panel()).toBeNull();
    expect(rentInput()!.value).toBe("$1,050.00");
  });

  it("clears a term from the warning as soon as the manager corrects it", () => {
    renderModal(parseOf(WRONG_PARTY_PAGES));

    expect(panel()!.textContent).toContain("1,450.00");
    fireEvent.change(rentInput()!, { target: { value: "$1,050.00" } });

    // The rent now agrees; the tenant still does not, so the panel stays.
    expect(panel()!.textContent).not.toContain("1,450.00");
    expect(panel()!.textContent).toContain("Shivansh Nikhra");
  });

  it("refreshes the mismatch panel when the record side changes under review", () => {
    const { rerender } = render(
      <UploadedLeaseReviewModal
        open
        row={row()}
        parse={parseOf(WRONG_PARTY_PAGES)}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(panel()).not.toBeNull();

    rerender(
      <UploadedLeaseReviewModal
        open
        row={row({ residentName: "Shivansh Nikhra" })}
        parse={parseOf(WRONG_PARTY_PAGES)}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain("Monthly rent");
  });
});

/**
 * The banner makes a claim, so it must read the predicate for that claim. A
 * green "Confirmed … can be sent for signature" over a lease every send path
 * refuses is the failure the one-predicate rule exists for.
 */
describe("the modal never claims a lease is sendable when it is not", () => {
  const SHA = "a".repeat(64);

  function confirmedParse(fingerprint: string | null) {
    const base = parseOf(RIGHT_PARTY_PAGES);
    return {
      ...base,
      review: {
        ...base.review,
        status: "confirmed" as const,
        confirmedByName: "Pat Manager",
        confirmedAtIso: "2026-08-01T12:00:00.000Z",
        confirmedDocumentSha256: SHA,
        confirmedRecordFingerprint: fingerprint,
      },
    };
  }

  it("shows the sendable banner for a confirmed lease still awaiting signature", () => {
    const r = row();
    renderModal(confirmedParse(leaseRecordFingerprint(leaseRecordTerms(r))), r);

    expect(shownText()).toContain("Confirmed by Pat Manager");
    expect(shownText()).toContain("can be sent for signature");
  });

  it("keeps the attribution but drops the sendability claim on a finalized lease", () => {
    const finalized = row({
      bucket: "signed",
      status: "Fully Signed",
      residentSignature: { role: "resident", name: "Diego Morales", signedAtIso: "2026-08-05T00:00:00.000Z" },
      managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-08-06T00:00:00.000Z" },
    });
    renderModal(confirmedParse(leaseRecordFingerprint(leaseRecordTerms(finalized))), finalized);

    expect(shownText()).toContain("Confirmed by Pat Manager");
    expect(shownText()).not.toContain("can be sent for signature");
  });

  it("says the record changed only when it can actually tell that it did", () => {
    // Confirmed against a different rent — PropLane knows exactly what moved.
    const r = row();
    renderModal(
      { ...parseOf(WRONG_PARTY_PAGES), review: confirmedParse("Someone Else~~~$99.00 / month").review },
      r,
    );

    expect(document.body.querySelector('[data-attr="uploaded-lease-superseded"]')).not.toBeNull();
    expect(shownText()).toContain("Confirmed by Pat Manager");
    expect(shownText()).toContain("The lease record has changed since");
  });

  it("does not blame a record change for a confirmation that predates the fingerprint", () => {
    // The legacy cohort: every confirmation made before the field existed. For
    // them nothing changed — PropLane simply cannot tell what was confirmed.
    renderModal({ ...parseOf(WRONG_PARTY_PAGES), review: confirmedParse(null).review }, row());

    expect(shownText()).toContain("cannot tell which record it was confirmed against");
    expect(shownText()).not.toContain("The lease record has changed since");
  });

  it("names the move-back step when the lease is already out for signature", () => {
    const sent = row({ bucket: "resident", status: "Resident Signature Pending" });
    renderModal({ ...parseOf(WRONG_PARTY_PAGES), review: confirmedParse(null).review }, sent);

    expect(shownText()).toContain("Move this lease back to manager review");
    expect(shownText()).not.toContain("can be sent for signature");
  });

  /**
   * The review half of the gate is not the whole gate. A confirmed,
   * mismatch-free import whose applicant was moved back to Pending is refused by
   * every send path, so the banner must not claim otherwise — reading a subset
   * of `leaseSendGateBlocker` is exactly how this drifted before.
   */
  it("drops the sendability claim while the applicant is not approved", () => {
    const r = row();
    seedDemoManagerApplicationRows(
      [
        {
          id: "AXIS-MODAL-1",
          name: "Diego Morales",
          email: r.residentEmail,
          property: "Cascade Lofts",
          stage: "Submitted",
          bucket: "pending",
          detail: "",
        },
      ],
      "manager-modal-gate",
    );
    renderModal(confirmedParse(leaseRecordFingerprint(leaseRecordTerms(r))), r);

    expect(shownText()).toContain("Confirmed by Pat Manager");
    expect(shownText()).not.toContain("can be sent for signature");
  });
});

/**
 * The banner, the footer and the tick answer to the STORED reading — the same
 * thing `leaseSendGateBlocker` reads. Deriving them from the manager's unsaved
 * typing let a correction that was never persisted flip the modal into
 * "Confirmed … can be sent for signature" with the Confirm button gone, while
 * every send path still refused: a dead end recoverable only by reloading.
 */
describe("unsaved typing never settles the review", () => {
  const SHA = "a".repeat(64);
  // Tenant agrees, rent does not — so correcting the rent empties the
  // draft-aware list while the STORED parse still disagrees.
  const WRONG_RENT_PAGES = [
    [
      "RESIDENTIAL LEASE AGREEMENT",
      "This Lease is between Cascade Holdings LLC (Landlord) and Diego Morales (Tenant).",
      "Tenant shall pay rent of $1,450.00 per month.",
    ].join("\n"),
  ];

  function supersededParse(fingerprint: string | null): UploadedLeaseParse {
    const base = parseOf(WRONG_RENT_PAGES);
    return {
      ...base,
      review: {
        ...base.review,
        status: "confirmed" as const,
        confirmedByName: "Pat Manager",
        confirmedAtIso: "2026-08-01T12:00:00.000Z",
        confirmedDocumentSha256: SHA,
        confirmedRecordFingerprint: fingerprint,
      },
    };
  }

  function rowWith(parse: UploadedLeaseParse) {
    return row({ uploadedLeaseParse: parse });
  }

  it("keeps the Confirm affordance when a stored mismatch is corrected but not confirmed", () => {
    const parse = supersededParse(null);
    renderModal(parse, rowWith(parse));

    expect(document.body.querySelector('[data-attr="uploaded-lease-superseded"]')).not.toBeNull();
    fireEvent.change(rentInput()!, { target: { value: "$1,050.00" } });

    // The panel is draft-aware, so the corrected term stops being listed...
    expect(panel()).toBeNull();
    // ...but nothing was saved, so the review is still unsettled: Confirm stays
    // reachable and the modal does not claim the lease is sendable.
    expect(document.body.querySelector('[data-attr="uploaded-lease-confirm"]')).not.toBeNull();
    expect(attestBox()).toBeNull();
    expect(document.body.querySelector('[data-attr="uploaded-lease-superseded"]')).not.toBeNull();
    expect(shownText()).not.toContain("can be sent for signature");
  });

  it("keeps save disabled while required terms are missing on a superseded review", () => {
    const parse = supersededParse(null);
    renderModal(parse, rowWith(parse));

    expect(shownText()).toContain("cannot tell which record it was confirmed against");
    const confirmButton = document.body.querySelector<HTMLButtonElement>(
      '[data-attr="uploaded-lease-confirm"]',
    );
    expect(confirmButton!.disabled).toBe(true);

    fireEvent.change(rentInput()!, { target: { value: "$1,050.00" } });
    fireEvent.change(
      document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-field-tenantName"]')!,
      { target: { value: "Diego Morales" } },
    );
    fireEvent.change(
      document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-field-leaseStart"]')!,
      { target: { value: "March 1, 2026" } },
    );
    fireEvent.change(
      document.body.querySelector<HTMLInputElement>('[data-attr="uploaded-lease-field-leaseEnd"]')!,
      { target: { value: "February 28, 2027" } },
    );
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-attr="uploaded-lease-confirm"]')!.disabled,
    ).toBe(false);
  });

  it("keeps save disabled when the record changed until required terms are filled", () => {
    const parse = supersededParse("Someone Else~~~99.00");
    renderModal(parse, rowWith(parse));

    expect(shownText()).toContain("The lease record has changed since");
    expect(
      document.body.querySelector<HTMLButtonElement>('[data-attr="uploaded-lease-confirm"]')!.disabled,
    ).toBe(true);
  });
});

describe("an upload nobody has read says so", () => {
  it("does not claim the document could not be structured", () => {
    renderModal(unreadUploadedLeaseParse("lease.pdf"));

    expect(document.body.querySelector('[data-attr="uploaded-lease-never-read"]')).not.toBeNull();
    expect(document.body.querySelector('[data-attr="uploaded-lease-unreadable"]')).toBeNull();
    expect(shownText()).toContain("Nobody has reviewed this document yet");
    expect(shownText()).not.toContain("could not be structured");
  });

  it("offers a way through — read it now without a separate attestation checkbox", () => {
    renderModal(unreadUploadedLeaseParse("lease.pdf"));

    expect(document.body.querySelector('[data-attr="uploaded-lease-retry-read"]')?.textContent).toContain(
      "Read it now",
    );
    expect(attestBox()).toBeNull();
  });
});
