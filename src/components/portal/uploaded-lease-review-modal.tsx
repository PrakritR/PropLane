"use client";

import { useMemo, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  resolvedFieldValue,
  uploadedLeaseReviewIsConfirmed,
  uploadedLeaseWasNeverRead,
  type UploadedLeaseField,
  type UploadedLeaseFieldKey,
  type UploadedLeaseParse,
} from "@/lib/uploaded-lease-extraction";
import { leaseDocumentMismatches, leaseMismatchAcknowledgementGap } from "@/lib/lease-document-mismatch";
import {
  LEASE_MOVE_BACK_TO_REVIEW_MESSAGE,
  leaseAllowsManagerDocumentEdits,
  leaseCanBeSentForSignature,
  leaseRecordTerms,
} from "@/lib/lease-pipeline-storage";
import { buildUploadedLeaseProplaneHtml } from "@/lib/uploaded-lease-proplane-format";

/**
 * Manager review of a parsed upload — the human step between machine extraction
 * and a signable lease.
 *
 * Three things it has to make obvious, because the gate is worthless otherwise:
 * where each value came from (page + the surrounding sentence), which values
 * are machine-read versus manager-entered, and that a blank is deliberate
 * rather than a bug. Nothing here pre-fills an empty field with a guess.
 */

const STATUS_COPY: Record<UploadedLeaseField["status"], { label: string; tone: string; help: string }> = {
  extracted: {
    label: "Extracted",
    tone: "border-amber-300 text-amber-700 dark:text-amber-400",
    help: "Read from the document. Check it against the original.",
  },
  ambiguous: {
    label: "Conflicting",
    tone: "border-rose-300 text-rose-700 dark:text-rose-400",
    help: "The document states this more than once, differently. Left blank — pick or type the right value.",
  },
  not_found: {
    label: "Not found",
    tone: "border-rose-300 text-rose-700 dark:text-rose-400",
    help: "Not found in the document. Left blank rather than assumed.",
  },
};

function placementFor(row: LeasePipelineRow) {
  return {
    residentName: row.residentName,
    residentEmail: row.residentEmail,
    unit: row.unit,
    leaseTerm: row.application?.leaseTerm ?? null,
    leaseStart: row.application?.leaseStart ?? null,
    leaseEnd: row.application?.leaseEnd ?? null,
    rentLabel: row.signedRentLabel ?? null,
  };
}

/**
 * A stable description of WHAT the manager is being asked to attest to.
 *
 * The attestation is a legal statement about one document and one reading of
 * it, so the tick must not survive either changing. Both call sites
 * (`manager-residents.tsx`, `manager-leases-pipeline-panel.tsx`) render this
 * modal without a `key` at a stable position, so a new `parse` prop re-renders
 * rather than remounts — nothing resets on its own.
 *
 * Every part earns its place, and the two branches fail differently:
 *
 * - `status` — the branches ask for materially different things. `failed` says
 *   "I have read the original PDF myself"; `parsed` says "I have compared this
 *   against the original PDF. The terms above are correct." A retry that turns
 *   one into the other must not arrive pre-ticked.
 * - `sourceFileName` + the row's uploaded-PDF identity — a `failed` (or
 *   `pending`) parse carries `sourceSha256: null`, no `extractedAtIso` and no
 *   fields, so every failed parse otherwise looks alike and a tick made against
 *   one unreadable document would carry onto a different one.
 * - `sourceSha256` — which bytes the reading describes.
 * - `extractedAtIso` — a re-read of the SAME bytes keeps the digest, so the
 *   digest alone would miss a new reading of the same PDF.
 * - the resolved field values — what "the terms above are correct" actually
 *   points at, including stored overrides, since those change the value shown.
 * - the record side of the parties comparison — the mismatch panel and the
 *   wording of the attestation itself are derived from it, so a manager who
 *   ticked "I accept the differences listed above" must not keep that tick
 *   after the differences change (or disappear, which would silently upgrade a
 *   narrow acceptance into "the terms above are correct").
 *
 * Deliberately derived from CONTENT rather than object identity: the pipeline
 * re-syncs on a cadence and hands back an equal-but-new `parse` object, and
 * clearing the box under a manager's fingers on a background refresh would be
 * its own bug.
 */
function attestationSubject(parse: UploadedLeaseParse, row: LeasePipelineRow): string {
  return [
    parse.status,
    parse.sourceFileName,
    row.managerUploadedPdf?.fileName ?? "",
    row.managerUploadedPdf?.uploadedAt ?? "",
    parse.sourceSha256 ?? "",
    parse.extractedAtIso ?? "",
    parse.fields.map((f) => `${f.key}:${f.status}:${resolvedFieldValue(f, parse.review).value}`).join("|"),
    row.residentName ?? "",
    row.application?.leaseStart ?? "",
    row.application?.leaseEnd ?? "",
    row.signedRentLabel ?? "",
  ].join("~");
}

/** PropLane's own value for a field, so the manager can spot a disagreement. */
function proplaneValueFor(key: UploadedLeaseFieldKey, row: LeasePipelineRow): string {
  switch (key) {
    case "tenantName":
      return row.residentName ?? "";
    case "leaseStart":
      return row.application?.leaseStart ?? "";
    case "leaseEnd":
      return row.application?.leaseEnd ?? "";
    case "monthlyRent":
      return row.signedRentLabel ?? "";
    default:
      return "";
  }
}

export function UploadedLeaseReviewModal({
  open,
  row,
  parse,
  onClose,
  onConfirm,
  onRetryRead,
}: {
  open: boolean;
  row: LeasePipelineRow;
  parse: UploadedLeaseParse;
  onClose: () => void;
  onConfirm: (args: { overrides: Partial<Record<UploadedLeaseFieldKey, string>>; note: string }) => Promise<void> | void;
  /** Re-read the PDF already on the row. Never confirms; the review stays open. */
  onRetryRead?: () => Promise<void> | void;
}) {
  /**
   * Three different questions, three different predicates — a surface reads the
   * one for the claim IT makes:
   *
   * - `storedConfirmed` — did a human confirm this reading at all? Owns the
   *   "Confirmed by X on Y" attribution, which stays true even once the
   *   confirmation stops covering the record.
   * - `supersededCause` — does that confirmation still cover the record's
   *   current disagreements? Owns whether the Confirm affordance comes back.
   * - `sendable` — could this lease be sent at all? Owns the SENDABILITY claim,
   *   read whole from `leaseCanBeSentForSignature` rather than recomposed here,
   *   because a hand-composed subset is how this drifted three times. That
   *   predicate covers the row's own state AND all three ordered reasons
   *   `leaseSendGateBlocker` answers, so an unapproved application, a parties
   *   mismatch and an unread import all suppress the claim identically.
   *
   * All of them are judged against the STORED reading — never the manager's
   * unsaved drafts — because that is what the send gate reads. Typing a
   * correction into a mismatched field without confirming it must not flip this
   * modal into "can be sent for signature" with the Confirm button gone while
   * `leaseSendGateBlocker` still refuses the send: that state is unrecoverable
   * without a reload, and it is the UI denying the reason the send is dead.
   */
  const storedConfirmed = uploadedLeaseReviewIsConfirmed(parse);
  const storedMismatches = leaseDocumentMismatches(parse, leaseRecordTerms(row));
  const supersededCause =
    storedConfirmed && storedMismatches.length > 0
      ? leaseMismatchAcknowledgementGap(parse, leaseRecordTerms(row))
      : null;
  /** The review is settled for THIS record: nothing here for the manager to act on. */
  const confirmed = storedConfirmed && !supersededCause;
  // Keyed on the row, which carries the STORED parse the gate reads, and never
  // on `drafts`. The gate reads stored state only, so keying it on unsaved
  // typing would re-read the whole applications store on every keystroke AND
  // quietly re-couple the banner to typing the send gate cannot see.
  const sendable = useMemo(() => leaseCanBeSentForSignature(row), [row]);
  /** A superseded row out for signature cannot be confirmed where it stands. */
  const needsMoveBackFirst = Boolean(supersededCause) && !leaseAllowsManagerDocumentEdits(row);

  const [drafts, setDrafts] = useState<Partial<Record<UploadedLeaseFieldKey, string>>>(
    () => ({ ...(parse.review.overrides ?? {}) }),
  );
  const [note, setNote] = useState(parse.review.note ?? "");
  // Seeded from "is the review settled for THIS record", never from the bare
  // stored confirmation. A superseded confirmation — including the legacy
  // `record_unknown` cohort, which is every confirmation predating the
  // fingerprint field — must open UNTICKED, or the re-acknowledgement that
  // `confirmedRecordFingerprint` exists to force is satisfied by one Confirm
  // click with nothing re-affirmed.
  const [attested, setAttested] = useState(confirmed);
  const [tab, setTab] = useState<"terms" | "document">("terms");

  // Reset everything the manager staged whenever what they are attesting to
  // changes. Done during render (React's documented "adjust state when props
  // change" pattern) rather than in an effect on purpose: an effect runs after
  // paint, so the stronger attestation would render ticked for a frame before
  // clearing — on the gate whose entire job is to stop an un-agreed
  // attestation. React re-runs this component immediately without committing.
  const subject = attestationSubject(parse, row);
  const [attestedSubject, setAttestedSubject] = useState(subject);
  if (attestedSubject !== subject) {
    setAttestedSubject(subject);
    setAttested(confirmed);
    // `drafts` are submitted by `onConfirm` as overrides and badged "Manager
    // entered", so carrying them would attribute a value to the manager that
    // they never typed for this document; `note` is recorded as part of the
    // confirmation. Both re-seed from the new parse, exactly like mount.
    setDrafts({ ...(parse.review.overrides ?? {}) });
    setNote(parse.review.note ?? "");
  }

  /** Kept visible in every confirmed state — the confirmation happened, whatever else changed. */
  const confirmationAttribution = `Confirmed${parse.review.confirmedByName ? ` by ${parse.review.confirmedByName}` : ""}${
    parse.review.confirmedAtIso ? ` on ${new Date(parse.review.confirmedAtIso).toLocaleString()}` : ""
  }.`;

  const previewHtml = useMemo(() => {
    const withDrafts: UploadedLeaseParse = {
      ...parse,
      review: { ...parse.review, overrides: { ...(parse.review.overrides ?? {}), ...drafts } },
    };
    return buildUploadedLeaseProplaneHtml({ parse: withDrafts, placement: placementFor(row) });
  }, [parse, drafts, row]);

  const setDraft = (key: UploadedLeaseFieldKey, value: string) =>
    setDrafts((d) => ({ ...d, [key]: value }));

  /**
   * Terms this document states that disagree with the record the manager opened.
   *
   * The one draft-aware value in this component, and deliberately so: this list
   * is what the manager is editing against, so correcting a value clears its row
   * here immediately rather than after a save. It drives the PANEL and the
   * wording of the attestation — never the banner, the footer, or any claim
   * about whether the lease can be sent, all of which read the stored parse the
   * send gate reads.
   */
  const mismatches = useMemo(
    () =>
      leaseDocumentMismatches(
        { ...parse, review: { ...parse.review, overrides: { ...(parse.review.overrides ?? {}), ...drafts } } },
        leaseRecordTerms(row),
      ),
    [parse, drafts, row],
  );

  /**
   * Untick when the manager's OWN edits change which statement they are being
   * asked to sign — the checkbox reads "The terms above are correct" with no
   * disagreements and "I accept the differences listed above" with them, and a
   * tick on the first must never be counted as agreement to the second.
   *
   * Deliberately separate from `attestationSubject`: that value also drives the
   * `setDrafts` / `setNote` re-seed, so folding drafts into it would wipe the
   * manager's typing on every keystroke. This one resets ONLY `attested`.
   */
  const attestationWording = mismatches.length > 0 ? "accepts-differences" : "terms-correct";
  const [attestedWording, setAttestedWording] = useState(attestationWording);
  if (attestedWording !== attestationWording) {
    setAttestedWording(attestationWording);
    setAttested(confirmed);
  }

  if (parse.status !== "parsed") {
    // A read that is still running has no result to attest to, and confirming
    // now would make the parse that lands a moment later unstorable — leaving
    // the row on an empty reading of a document that structured fine. So the
    // confirm affordance exists only once the read has finished and failed.
    const stillReading = parse.status === "pending";
    // "Never read" and "read and failed" are different facts about the same
    // document, and telling a manager PropLane could not structure a PDF it
    // never opened sends them looking for a problem with the file.
    const neverRead = uploadedLeaseWasNeverRead(parse);
    // `pending` is written before any text is read, so a manager who closed the
    // tab mid-read owns a row that can never be sent. Re-reading the bytes
    // already on the row is the way out — no re-upload, so the executed
    // artifact is untouched.
    const canRetry = Boolean(onRetryRead) && !confirmed && Boolean(row.managerUploadedPdf?.dataUrl);
    const retryAction = canRetry
      ? {
          label: stillReading ? "Retry read" : neverRead ? "Read it now" : "Read it again",
          onClick: () => onRetryRead?.(),
          dataAttr: "uploaded-lease-retry-read",
        }
      : null;
    const confirmAction = {
      label: "Confirm and allow signing",
      onClick: () => onConfirm({ overrides: {}, note }),
      disabled: !attested,
      dataAttr: "uploaded-lease-confirm",
    };
    // Nothing left to attest to (still reading, or already confirmed): the
    // only possible action is the retry, or — with none available — a plain
    // acknowledgement close (PortalDialog always names its one primary).
    const readOnly = stillReading || confirmed;
    return (
      <PortalDialog
        open={open}
        title={`Imported lease · ${parse.sourceFileName}`}
        onClose={onClose}
        size="wizard"
        dataAttr="uploaded-lease-review-modal"
        primaryAction={readOnly ? retryAction ?? { label: "Done", onClick: onClose } : confirmAction}
        secondaryAction={readOnly ? null : retryAction}
      >
        <div className="space-y-4 text-sm">
          <div
            className={
              stillReading
                ? "rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                : "rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3 text-rose-800 dark:bg-rose-950/30 dark:text-rose-300"
            }
            data-attr={
              stillReading
                ? "uploaded-lease-still-reading"
                : neverRead
                  ? "uploaded-lease-never-read"
                  : "uploaded-lease-unreadable"
            }
          >
            <p className="font-semibold">
              {stillReading
                ? "Still reading this document…"
                : neverRead
                  ? "Nobody has reviewed this document yet."
                  : "This document could not be structured."}
            </p>
            {parse.failureReason ? <p className="mt-1">{parse.failureReason}</p> : null}
            <p className="mt-2">
              The uploaded PDF is stored unchanged and is still the document that gets signed.
              {stillReading
                ? " This lease stays held until the read finishes."
                : neverRead
                  ? " It cannot be sent for signature until you have read it and said it is the right lease."
                  : " Nothing was shortened or rewritten — PropLane simply could not read it into sections."}
              {canRetry
                ? neverRead
                  ? " Read it now to have PropLane pull out its terms for you to check — the PDF is not re-uploaded or altered."
                  : " Read it again to run the same document through PropLane once more — the PDF is not re-uploaded or altered."
                : null}
            </p>
          </div>
          {stillReading || confirmed ? null : (
            <>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={attested}
                  data-attr="uploaded-lease-attest"
                  onChange={(e) => setAttested(e.target.checked)}
                />
                <span>I have read the original PDF myself and it is the lease I intend to send for signature.</span>
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Optional note recorded with your confirmation"
                className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              />
            </>
          )}
        </div>
      </PortalDialog>
    );
  }

  return (
    <PortalDialog
      open={open}
      title={`Review imported lease · ${parse.sourceFileName} · ${parse.pageCount} page${parse.pageCount === 1 ? "" : "s"}`}
      onClose={onClose}
      size="wizard"
      dataAttr="uploaded-lease-review-modal"
      primaryAction={
        confirmed
          ? { label: "Done", onClick: onClose }
          : {
              label: "Confirm and allow signing",
              onClick: () => onConfirm({ overrides: drafts, note }),
              disabled: !attested,
              dataAttr: "uploaded-lease-confirm",
            }
      }
      secondaryAction={null}
    >
      <div className="space-y-4">
        {supersededCause ? (
          <p
            className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
            data-attr="uploaded-lease-superseded"
          >
            <strong className="font-semibold">Needs confirming again.</strong>{" "}
            {confirmationAttribution}{" "}
            {/*
              Two different facts, and only one of them is "the record changed".
              Every confirmation made before this branch shipped carries no
              record fingerprint, so that cohort is the common case today —
              telling those managers the record changed states a cause that is
              false, in a module whose rule is that the UI must not misstate
              what the gate does.
            */}
            {supersededCause === "record_changed"
              ? "The lease record has changed since, so the differences below are not the ones that were accepted."
              : "PropLane cannot tell which record it was confirmed against, so the differences below have to be accepted again."}
            {needsMoveBackFirst ? ` ${LEASE_MOVE_BACK_TO_REVIEW_MESSAGE}` : ""}
          </p>
        ) : confirmed && sendable ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
            {confirmationAttribution} This lease can be sent for signature.
          </p>
        ) : confirmed ? (
          // Confirmed, but finalized or already signed: the attestation is still
          // a true fact about this lease; "can be sent for signature" is not.
          <p
            className="rounded-xl border border-border bg-accent/20 px-4 py-3 text-sm text-foreground"
            data-attr="uploaded-lease-confirmed-not-sendable"
          >
            {confirmationAttribution}
          </p>
        ) : (
          <p className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
            <strong className="font-semibold">Not signable yet.</strong> Every value below was read by machine.
            Blanks are deliberate — PropLane leaves a term empty rather than guessing it. Check them against the
            original PDF, fill in what is missing, then confirm.
          </p>
        )}

        {/*
          The parties-mismatch guard, stated. A lease page headed with one
          tenant once rendered a PDF naming an entirely different person, their
          real personal email address, another property and another rent, with
          Send fully enabled and nothing anywhere objecting. Naming each
          disagreement — document value beside record value — is what makes
          confirming it a decision rather than an accident.
        */}
        {mismatches.length > 0 ? (
          <div
            className="rounded-xl border border-rose-300 bg-rose-50/70 px-4 py-3 text-sm text-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
            data-attr="uploaded-lease-mismatch"
          >
            <p className="font-semibold">
              This document disagrees with the PropLane record for {row.residentName}
              {row.unit && row.unit !== "—" ? ` · ${row.unit}` : ""}.
            </p>
            <ul className="mt-2 space-y-1.5">
              {mismatches.map((m) => (
                <li key={m.key} data-attr={`uploaded-lease-mismatch-${m.key}`}>
                  <span className="font-semibold">{m.label}</span> — document says “{m.documentValue}”, this record
                  says “{m.recordValue}”.
                </li>
              ))}
            </ul>
            <p className="mt-2">
              Check you uploaded the right PDF onto the right lease. Correct a value below if the document is right
              and PropLane misread it; otherwise upload the correct document. Confirming sends this document, as it
              is, to {row.residentEmail || "the resident"} for signature.
            </p>
          </div>
        ) : null}

        <div className="flex gap-1.5">
          {(["terms", "document"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              data-attr={`uploaded-lease-review-tab-${id}`}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition ${
                tab === id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-muted hover:bg-accent/30"
              }`}
            >
              {id === "terms" ? "Extracted terms" : "PropLane format"}
            </button>
          ))}
        </div>

        {tab === "terms" ? (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-accent/20 text-xs uppercase tracking-[0.1em] text-muted">
                  <th className="px-3 py-2 font-semibold">Term</th>
                  <th className="px-3 py-2 font-semibold">From the document</th>
                  <th className="px-3 py-2 font-semibold">Value used</th>
                  <th className="px-3 py-2 font-semibold">PropLane record</th>
                </tr>
              </thead>
              <tbody>
                {parse.fields.map((field) => {
                  const status = STATUS_COPY[field.status];
                  const stored = resolvedFieldValue(field, parse.review);
                  const draft = drafts[field.key];
                  const value = draft !== undefined ? draft : stored.value;
                  const humanValue = draft !== undefined ? draft.trim() !== field.value.trim() : stored.confirmedByHuman;
                  const proplane = proplaneValueFor(field.key, row);
                  return (
                    <tr key={field.key} className="border-b border-border/60 align-top last:border-0">
                      <td className="px-3 py-3">
                        <div className="font-semibold text-foreground">{field.label}</div>
                        <span
                          className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
                            humanValue ? "border-emerald-300 text-emerald-700 dark:text-emerald-400" : status.tone
                          }`}
                        >
                          {humanValue ? "Manager entered" : status.label}
                        </span>
                        {!field.mapsTo ? (
                          <div className="mt-1 text-[11px] text-muted">No PropLane field — review only</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-muted">
                        {field.source ? (
                          <>
                            <div className="text-foreground">{field.value}</div>
                            <div className="mt-1 text-[11px]">
                              Page {field.source.page} · “{field.source.snippet}”
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[13px]">{status.help}</div>
                            {field.candidates.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {field.candidates.map((c) => (
                                  <button
                                    key={`${c.value}-${c.source.charStart}`}
                                    type="button"
                                    disabled={confirmed}
                                    onClick={() => setDraft(field.key, c.value)}
                                    className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent/30 disabled:opacity-60"
                                  >
                                    {c.value} <span className="text-muted">p.{c.source.page}</span>
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="text"
                          value={value}
                          disabled={confirmed}
                          data-attr={`uploaded-lease-field-${field.key}`}
                          placeholder="—"
                          onChange={(e) => setDraft(field.key, e.target.value)}
                          className="w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-70"
                        />
                      </td>
                      <td className="px-3 py-3 text-[13px] text-muted">{proplane || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <iframe
            title="Imported lease in PropLane format"
            srcDoc={previewHtml}
            sandbox="allow-same-origin"
            className="h-[52vh] w-full rounded-xl border border-border bg-white"
          />
        )}

        {row.managerUploadedPdf?.dataUrl ? (
          <a
            href={row.managerUploadedPdf.originalDataUrl ?? row.managerUploadedPdf.dataUrl}
            download={parse.sourceFileName}
            data-attr="uploaded-lease-open-original"
            className="inline-block text-sm font-semibold text-primary underline"
          >
            Download the original PDF — unchanged, and still the document that gets signed
          </a>
        ) : null}

        {confirmed ? null : (
          <>
            <label className="flex items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={attested}
                data-attr="uploaded-lease-attest"
                onChange={(e) => setAttested(e.target.checked)}
              />
              <span>
                {mismatches.length > 0
                  ? "I have compared this against the original PDF. I accept the differences listed above, and this is the lease I intend to send for signature."
                  : "I have compared this against the original PDF. The terms above are correct and this is the lease I intend to send for signature."}
              </span>
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="Optional note recorded with your confirmation"
              className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            />
          </>
        )}
      </div>
    </PortalDialog>
  );
}
