"use client";

/**
 * Send new lease — a signed lease's replacement, in the standard pop-up shell (the New property wizard's:
 * header, the one "Start from a file" card on the first step, step rail, the "Resident sees" preview flush right, centred step count,
 * primary on the right).
 *
 *   Lease  →  Terms  →  Review & send
 *
 * Lease: generate it from the property's lease template, or upload a lease PDF (the "Start from a file" card).
 * Terms: term, start, end and rent, prefilled from the current lease. Review & send: what the resident gets.
 *
 * Nothing here is a new server path. The terms go through the existing amend route (`postLeaseRenewal`, the
 * `mode: "renew"` write that resets the lease to Manager Review with a regenerated document and stashes the
 * terms as `pendingRenewal`), an uploaded PDF goes through the existing uploaded-lease reader
 * (`uploadAndParseLeasePdf`) and `leaseSendGateBlocker`, and the send is `sendLeaseToResident`. Payments
 * update only once the new lease is signed by both parties, exactly as before. When the gate has something
 * left to settle (an uploaded PDF's reading, an unconfirmed difference), the one Send lease screen opens on
 * this lease instead of sending past it. `resolveStayPricing` stays the one price decision: the rent here is
 * only the typed override the amend route has always accepted, with the same payment preview.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WorkspacePreviewTitle } from "@/components/portal/add-workspace/frame";
import { WizardLine, WizardSection, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  LeaseRenewalFormFields,
  RenewalPaymentPreviewCard,
  dayAfter,
  postLeaseRenewal,
  renewalTermsReady,
  resolveRenewalLeaseEnd,
} from "@/components/portal/lease-amend-move-out-modal";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import { renewalLeaseTermOptionsForProperty } from "@/lib/lease-renewal-terms";
import { listingAdvertisedRentLabelForLease } from "@/lib/lease-renewal-preview";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";
import { uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import {
  appendLeaseThreadMessage,
  leaseSendGateBlocker,
  readLeasePipeline,
  sendLeaseToResident,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

type Source = "lease" | "pdf";

const MAX_PDF_BYTES = 3.5 * 1024 * 1024;
const PDF_ACCEPT = "application/pdf,.pdf";

/** The term a new lease starts on: the current one when the property still offers it, else the first on offer. */
function initialTermFor(row: LeasePipelineRow, propertyId: string): string {
  const terms = renewalLeaseTermOptionsForProperty(propertyId);
  const preferred = (row.application?.leaseTerm ?? "").trim();
  if (preferred && terms.includes(preferred)) return preferred;
  // A retired fixed length ("12-Month") is still on signed leases; today's offer for it is Long-term.
  if (/^\d+-Month$/.test(preferred) && terms.includes(LONG_TERM_LEASE_TERM)) return LONG_TERM_LEASE_TERM;
  if (row.application?.rentalType === "short_term" && terms.includes(SHORT_TERM_LEASE_TERM)) return SHORT_TERM_LEASE_TERM;
  return terms[0] ?? preferred;
}

/** The new start plus the current lease's own length: the end a manager usually wants for "the same again". */
function sameLengthEnd(currentStart: string, currentEnd: string, newStart: string): string {
  const a = Date.parse(`${currentStart}T00:00:00Z`);
  const b = Date.parse(`${currentEnd}T00:00:00Z`);
  const c = Date.parse(`${newStart}T00:00:00Z`);
  if (![a, b, c].every(Number.isFinite) || b <= a) return "";
  return new Date(c + (b - a)).toISOString().slice(0, 10);
}

export function SendNewLeaseModal({
  row,
  managerUserId,
  onClose,
  onCreated,
  onNeedsSendScreen,
}: {
  /** The signed lease being replaced. Mounted only while open. */
  row: LeasePipelineRow;
  managerUserId: string | null;
  onClose: () => void;
  /** The new lease exists on the server (sent or waiting in Manager Review): refresh the list. */
  onCreated: () => void;
  /** The gate has something left to settle: open the one Send lease screen on this lease. */
  onNeedsSendScreen: (leaseId: string, source: Source) => void;
}) {
  const { showToast } = useAppUi();
  const { channelsFor } = useManagerCommunicationDeliverVia();
  const propertyId = row.propertyId ?? row.application?.propertyId ?? "";
  const currentEnd = row.application?.leaseEnd ?? "";
  const currentRentLabel = row.signedRentLabel ?? row.application?.managerRentOverride ?? "";
  const listingRentLabel = listingAdvertisedRentLabelForLease(propertyId, row.roomChoice ?? row.application?.roomChoice1 ?? "");
  const termOptions = useMemo(() => renewalLeaseTermOptionsForProperty(propertyId), [propertyId]);

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source>("lease");
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [term, setTerm] = useState(() => initialTermFor(row, propertyId));
  const [start, setStart] = useState(() => (currentEnd ? dayAfter(currentEnd) : new Date().toISOString().slice(0, 10)));
  const [customEnd, setCustomEnd] = useState(() => {
    const first = currentEnd ? dayAfter(currentEnd) : "";
    return first ? sameLengthEnd(row.application?.leaseStart ?? "", currentEnd, first) : "";
  });
  const [rent, setRent] = useState(() => currentRentLabel.replace(/[^\d.]/g, ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);

  // Release the blob a picked PDF previews through.
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  const end = resolveRenewalLeaseEnd(term, start, customEnd);
  const termsReady = renewalTermsReady({ leaseTerm: term, leaseStart: start, leaseEnd: end, rent });
  const leaseReady = source === "lease" || Boolean(file);

  const pickPdf = (next: File) => {
    if (next.type !== "application/pdf" && !/\.pdf$/i.test(next.name)) {
      showToast("Choose a PDF file.");
      return;
    }
    if (next.size > MAX_PDF_BYTES) {
      showToast("PDF too large (max 3.5 MB).");
      return;
    }
    setFile(next);
    setFileUrl(URL.createObjectURL(next));
    setSource("pdf");
    setError(null);
  };

  const finish = async () => {
    if (busy || !termsReady || !leaseReady) return;
    setBusy(true);
    setError(null);
    try {
      // 1. The existing amend write: the lease re-enters Manager Review with the new terms and a fresh document.
      const created = await postLeaseRenewal({ renewUrl: "/api/manager/amend-lease", leaseId: row.id, leaseTerm: term, leaseStart: start, leaseEnd: end, rent });
      if (!created.ok) {
        setError(created.error);
        return;
      }
      await syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined);

      // 2. An uploaded lease goes through the existing uploaded-lease reader (the amend write cleared the prior PDF).
      if (source === "pdf" && file) {
        const uploaded = await uploadAndParseLeasePdf(row.id, file, managerUserId);
        if (!uploaded.ok) {
          setError(`The new terms are saved, but the PDF could not be read: ${uploaded.error ?? "Upload failed."}`);
          onCreated();
          return;
        }
        await syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined);
      }
      onCreated();

      // 3. Send through the existing path when nothing is left to settle; otherwise the Send lease screen names it.
      const fresh = readLeasePipeline(managerUserId).find((r) => r.id === row.id);
      const blocker = fresh ? leaseSendGateBlocker(fresh) : "Lease not found.";
      if (source === "pdf" || blocker || !fresh) {
        showToast("New lease ready. Review it, then send. Payments update once it's signed.");
        onClose();
        onNeedsSendScreen(row.id, source);
        return;
      }
      const sent = await sendLeaseToResident(row.id, managerUserId);
      if (!sent.ok) {
        showToast(sent.error ?? "Could not send the lease.");
        onClose();
        onNeedsSendScreen(row.id, source);
        return;
      }
      appendLeaseThreadMessage(row.id, "manager", "Sent lease to resident for review and signature.", managerUserId);
      const channels = channelsFor("leases");
      let toast = `New lease sent · ${row.residentName}`;
      if ((channels.viaEmail || channels.viaSms) && row.residentEmail) {
        const delivered = await deliverPortalInboxMessage({
          eventCategory: "leases",
          fromName: "Property Manager",
          toEmails: [row.residentEmail],
          subject: `Your lease for ${row.unit?.trim() || "your unit"} is ready to sign`,
          text: buildLeaseReadyForResidentMessage({ residentName: row.residentName || "there", residentEmail: row.residentEmail, unit: row.unit?.trim() || "your unit", variant: "send" }),
          deliverViaEmail: channels.viaEmail,
          deliverViaSms: channels.viaSms,
        }).catch(() => ({ ok: false as const }));
        if (!delivered.ok) toast = `${toast}. A message could not be delivered.`;
      }
      showToast(`${toast}. Payments update once it's signed.`);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const steps = useMemo<AddWorkspaceStep[]>(
    () => [
      { id: "lease", label: "Lease", incomplete: !leaseReady, summary: source === "pdf" ? file?.name ?? "Upload a PDF" : "From the property's template" },
      { id: "terms", label: "Terms", incomplete: !termsReady, summary: term ? `${term}${start ? ` · ${start}` : ""}` : "Set the terms" },
      { id: "review", label: "Review & send", summary: row.residentName },
    ],
    [leaseReady, termsReady, source, file, term, start, row.residentName],
  );
  const stepId = steps[Math.min(step, steps.length - 1)]!.id;

  const place = row.unit?.trim() || row.propertyId || "Your home";
  const preview = (
    <section aria-label="What the resident sees" data-attr="lease-send-new-preview">
      <WorkspacePreviewTitle>Resident sees</WorkspacePreviewTitle>
      <div className="space-y-3 rounded-2xl border border-border bg-card p-3.5">
        <h4 className="min-w-0 truncate text-sm font-bold text-foreground">{`Lease · ${place}`}</h4>
        {source === "pdf" && fileUrl ? (
          <div className="max-h-[300px] overflow-y-auto rounded-lg border border-border bg-white">
            <UploadedLeasePdfPreview dataUrl={fileUrl} title={file?.name ?? "Lease"} documentFlow />
          </div>
        ) : source === "pdf" ? (
          <div className="grid h-40 place-items-center rounded-lg border border-dashed border-border text-xs text-muted">The PDF shows here</div>
        ) : null}
        <dl className="space-y-1.5 text-[13px]">
          {[
            ["Term", term || "—"],
            ["Starts", start || "—"],
            ["Ends", term === "Month-to-Month" ? "Open-ended" : end || "—"],
            ["Rent", rent.trim() ? `$${rent.replace(/[^\d.]/g, "")}` : currentRentLabel || "—"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <dt className="text-muted">{label}</dt>
              <dd className="min-w-0 truncate font-semibold text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );

  return (
    <AddWorkspace
      title="Send new lease"
      subtitle={row.residentName}
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={onClose}
      dirty={Boolean(file) || rent !== currentRentLabel.replace(/[^\d.]/g, "")}
      discardTitle="Discard this lease?"
      discardBody="Nothing has been sent yet. Close and lose what you set?"
      assistantContext="Send new lease"
      assistantScopeKey="lease-send-new"
      headerUpload={{ accept: PDF_ACCEPT, chips: [".pdf", "up to 3.5 MB"], onPick: pickPdf, disabled: busy, dataAttr: "lease-send-new-header-upload", label: "Upload lease PDF" }}
      dataAttrPrefix="lease-send-new"
      finishDataAttr="lease-send-new-confirm"
      lastLabel="Send new lease"
      lastDisabled={!termsReady || !leaseReady}
      nextDisabled={(stepId === "lease" && !leaseReady) || (stepId === "terms" && !termsReady)}
      busy={busy}
      onBeforeNext={() => {
        if (stepId === "lease" && !leaseReady) {
          showToast("Upload the lease PDF first.");
          return false;
        }
        if (stepId === "terms" && !termsReady) {
          showToast("Set the term, dates and rent first.");
          return false;
        }
        return true;
      }}
      onFinish={() => void finish()}
      footerNote={
        error ? (
          <span className="text-sm text-rose-600" role="alert" data-attr="lease-send-new-error">
            {error}
          </span>
        ) : null
      }
      sidePanel={preview}
    >
      <div className="min-w-0">
        {stepId === "lease" ? (
          <StepColumn>
            <StepHeading title="Lease" />
            <WizardSection title="Start from" dataAttr="lease-send-new-source">
              <SegmentedTwo<Source>
                value={source}
                onChange={(next) => {
                  setSource(next);
                  setError(null);
                }}
                left={{ id: "lease", label: "PropLane lease" }}
                right={{ id: "pdf", label: "Upload a PDF" }}
              />
              {source === "lease" ? (
                <div className="mt-3">
                  <WizardLine label="Lease form" control={<span className="text-[13px] text-muted">The property&apos;s lease template</span>} />
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <button
                    type="button"
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-4 py-10 text-center text-sm font-semibold text-foreground transition hover:border-primary/40"
                    onClick={() => pickRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const dropped = e.dataTransfer.files?.[0];
                      if (dropped) pickPdf(dropped);
                    }}
                    data-attr="lease-send-new-drop"
                  >
                    <FileUp className="size-6 text-primary" aria-hidden />
                    {file ? file.name : "Drop the lease PDF here or click to choose"}
                  </button>
                </div>
              )}
            </WizardSection>
          </StepColumn>
        ) : null}

        {stepId === "terms" ? (
          <StepColumn>
            <StepHeading title="Terms" />
            <WizardSection title="Term" dataAttr="lease-send-new-terms">
              <div className="mb-4">
                <WizardSelect
                  label="Term"
                  value={term}
                  onChange={(next) => setTerm(next)}
                  options={termOptions.map((option) => ({ value: option, label: option }))}
                  dataAttr="lease-send-new-term"
                  required
                />
              </div>
              <LeaseRenewalFormFields
                leaseTerm={term}
                leaseStart={start}
                customEnd={customEnd}
                rent={rent}
                currentRentLabel={currentRentLabel}
                listingRentLabel={listingRentLabel}
                hideRentHint
                onLeaseStartChange={setStart}
                onCustomEndChange={setCustomEnd}
                onRentChange={setRent}
              />
            </WizardSection>
          </StepColumn>
        ) : null}

        {stepId === "review" ? (
          <StepColumn>
            <StepHeading title="Review & send" />
            <WizardSection title="New lease" dataAttr="lease-send-new-review">
              <WizardLine label="Resident" control={<span className="text-[13px] text-foreground">{row.residentName}</span>} />
              <WizardLine label="Lease" control={<span className="text-[13px] text-foreground">{source === "pdf" ? file?.name ?? "Uploaded PDF" : "PropLane lease"}</span>} />
              <WizardLine label="Term" control={<span className="text-[13px] text-foreground">{term}</span>} />
              <WizardLine label="Starts" control={<span className="text-[13px] text-foreground">{start || "—"}</span>} />
              <WizardLine label="Ends" control={<span className="text-[13px] text-foreground">{term === "Month-to-Month" ? "Open-ended" : end || "—"}</span>} />
              <WizardLine label="Rent" control={<span className="text-[13px] text-foreground">{rent.trim() ? `$${rent.replace(/[^\d.]/g, "")}` : currentRentLabel || "—"}</span>} />
            </WizardSection>
            <RenewalPaymentPreviewCard leaseTerm={term} leaseStart={start} leaseEnd={end} rent={rent} currentRentLabel={currentRentLabel} listingRentLabel={listingRentLabel} />
          </StepColumn>
        ) : null}
      </div>
      <input
        ref={pickRef}
        type="file"
        accept={PDF_ACCEPT}
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const next = e.target.files?.[0];
          if (next) pickPdf(next);
          e.target.value = "";
        }}
      />
    </AddWorkspace>
  );
}
