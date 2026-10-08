"use client";

/**
 * Send lease — ONE screen.
 *
 *   Send lease · <resident>
 *   [ PropLane lease | Upload PDF ]
 *   Terms (Start · End · Rent · Deposit, prefilled)      — the PDF sits beside them for an upload
 *   the lease itself, and ☐ This is the lease I'm sending
 *   Payments schedule (read only; recomputes as the terms change)
 *   Ready to send — a row only for what is missing: Approve · Send invite · …
 *   Email · Your lease is ready to sign   ✎
 *   [ Send for signature ]
 *
 * It replaces the Add lease wizard, the AI-draft checkbox, the compare popup and the full
 * email compose. Nothing here computes money: the terms are the application's own, the
 * schedule is read off the billing snapshot the lease is rendered from, and the charges
 * themselves are created when the LAST signature lands (see `lease-signing-charges.client.ts`).
 *
 * Entry points all open this: the lease ⋯ and record header, a resident's Next step and
 * Lease tab, the toast after Approve, and the Leases list's + (which adds a resident picker).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Pencil } from "lucide-react";
import { WorkspaceFileCard } from "@/components/portal/add-workspace/upload-action";
import { ApproveApplicationDialog } from "@/components/portal/approve-application-dialog";
import { ImportedLeasePlacementReviewModal } from "@/components/portal/imported-lease-placement-review-modal";
import { LeaseDocumentPreview } from "@/components/portal/lease-document-preview";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DateField } from "@/components/ui/date-field";
import { Input, Textarea } from "@/components/ui/input";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { leaseRecordFingerprint } from "@/lib/lease-document-mismatch";
import { loadResidentAccountEmails } from "@/lib/manager-resident-account-emails";
import {
  appendLeaseThreadMessage,
  confirmUploadedLeaseParseOnServer,
  ensureManagerReviewLeaseForApplication,
  generateLeaseHtmlForRow,
  leaseAwaitsUploadedLeaseReview,
  leaseLandlordNameWarning,
  leaseMismatchAcknowledgementGapForRow,
  leasePipelineRowHasDocument,
  leaseRecordTerms,
  leaseApplicationSnapshotForRow,
  leaseSendGateBlocker,
  persistLeaseRowToServerAwait,
  readLeasePipeline,
  regenerateEditableLeasesForResident,
  sendLeaseToResident,
  syncLeasePipelineFromServer,
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  leaseSendSchedule,
  leaseSendTermsEqual,
  leaseSendTermsFor,
  leaseSendTermsPatch,
  pdfTermRows,
  resolvePdfTermPicks,
  validateLeaseSendTerms,
  type LeaseSendTerms,
  type PdfTermKey,
  type PdfTermPick,
  approvedResidentOptionLabel,
} from "@/lib/lease-send-terms";
import { roomForApplicationRow } from "@/lib/application-approval-slots";
import {
  confirmTemplatePlacementReviewForRow,
  leaseNeedsTemplatePlacementReview,
} from "@/lib/lease-template-placement-review.client";
import {
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServerAwait,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import { requestResidentWelcomeEmail } from "@/lib/application-review";
import { buildLeaseReadyForResidentMessage } from "@/lib/resident-portal-login-copy";
import { jointRoommateApplications, linkJointRoomLeases } from "@/lib/lease-joint-room.client";
import { leaseFeeForSend, leaseFormChoicesForApplication } from "@/lib/send-forms";
import { reinstateLeaseFeeForLease, waiveLeaseFeeForLease } from "@/lib/lease-fee-waiver.client";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { getPropertyById } from "@/lib/rental-application/data";
import { sharedRoomCardFor } from "@/lib/shared-room-card";
import { stripeSetupStateFromStatus } from "@/lib/stripe-setup-state";
import { uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { cn } from "@/lib/utils";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";

type Source = "lease" | "pdf";

function money(amount: number): string {
  return formatRoomPriceAmount(Math.round(amount * 100) / 100);
}

function applicationForLease(lease: LeasePipelineRow | null, apps: DemoApplicantRow[], applicationId?: string): DemoApplicantRow | null {
  if (applicationId) {
    const byId = apps.find((a) => a.id === applicationId);
    if (byId) return byId;
  }
  if (!lease) return null;
  const axis = lease.axisId?.trim().toUpperCase();
  if (axis) {
    const byAxis = apps.find((a) => a.id.trim().toUpperCase() === axis);
    if (byAxis) return byAxis;
  }
  const email = lease.residentEmail.trim().toLowerCase();
  return (email && apps.find((a) => a.email?.trim().toLowerCase() === email)) || null;
}

export type LeaseSendSheetProps = {
  open: boolean;
  /** An existing lease (Draft, or out for signature when re-sending is allowed). */
  leaseId?: string | null;
  /** An approved (or about-to-be-approved) application; its Draft lease is created when it has none. */
  applicationId?: string | null;
  /** Neither id: show a resident picker first (the Leases list +). */
  pickResident?: boolean;
  /** Open on the Upload PDF side. */
  initialSource?: Source;
  managerUserId: string | null;
  onClose: () => void;
  onSent?: (leaseId: string) => void;
};

export function LeaseSendSheet(props: LeaseSendSheetProps) {
  const { open, leaseId, applicationId } = props;
  // A fresh mount per lease so no terms, pick or note leaks from one resident to the next.
  return open ? <LeaseSendSheetBody key={`${leaseId ?? ""}|${applicationId ?? ""}`} {...props} /> : null;
}

function LeaseSendSheetBody({
  leaseId: leaseIdProp,
  applicationId: applicationIdProp,
  pickResident = false,
  initialSource,
  managerUserId,
  onClose,
  onSent,
}: LeaseSendSheetProps) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const { channelsFor } = useManagerCommunicationDeliverVia();
  const channels = channelsFor("leases");
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const [pickedApplicationId, setPickedApplicationId] = useState<string>(applicationIdProp ?? "");
  const [leaseId, setLeaseId] = useState<string | null>(leaseIdProp ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>(initialSource ?? "lease");
  const [terms, setTerms] = useState<LeaseSendTerms | null>(null);
  const [savedTerms, setSavedTerms] = useState<LeaseSendTerms | null>(null);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [picks, setPicks] = useState<Partial<Record<PdfTermKey, PdfTermPick>>>({});
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveRow, setApproveRow] = useState<DemoApplicantRow | null>(null);
  const [placementReviewRow, setPlacementReviewRow] = useState<LeasePipelineRow | null>(null);
  const [accountEmails, setAccountEmails] = useState<Set<string> | null>(null);
  const [invited, setInvited] = useState(false);
  const [payoutsMissing, setPayoutsMissing] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const generatedForRef = useRef<string | null>(null);

  /* ───────────── load: fresh applications + leases, then resolve the lease row ───────────── */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!isDemoModeActive()) {
        await Promise.all([
          syncManagerApplicationsFromServer({ force: true, managerUserId: managerUserId ?? undefined }).catch(() => undefined),
          syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined),
        ]);
      }
      if (!cancelled) bump();
    })();
    return () => {
      cancelled = true;
    };
  }, [managerUserId, bump]);

  const apps = useMemo(() => {
    void tick;
    return readManagerApplicationRows();
  }, [tick]);

  // Resolve the lease row once the application is known to be approved.
  useEffect(() => {
    if (leaseId || !pickedApplicationId) return;
    const app = apps.find((a) => a.id === pickedApplicationId);
    if (!app) return;
    if (app.bucket !== "approved") {
      setLoadError(null);
      return;
    }
    const ensured = ensureManagerReviewLeaseForApplication(pickedApplicationId, managerUserId);
    if (ensured.ok) {
      setLeaseId(ensured.row.id);
      setLoadError(null);
      bump();
    } else {
      setLoadError(ensured.error);
    }
  }, [leaseId, pickedApplicationId, apps, managerUserId, bump]);

  const lease = useMemo(() => {
    void tick;
    return leaseId ? readLeasePipeline(managerUserId).find((r) => r.id === leaseId) ?? null : null;
  }, [leaseId, managerUserId, tick]);
  const app = useMemo(
    () => applicationForLease(lease, apps, pickedApplicationId || undefined),
    [lease, apps, pickedApplicationId],
  );

  /* Roommates on one joint shared-room lease: one send covers them all. */
  const jointMates = useMemo(() => (app ? jointRoommateApplications(app, apps) : []), [app, apps]);
  const jointCard = useMemo(() => (app && jointMates.length > 0 ? sharedRoomCardFor(app, apps, null) : null), [app, apps, jointMates]);

  /* The property's lease forms: the lease the application maps to is first (the default); a picker
     appears only when there is a real choice. */
  const leaseChoices = useMemo(() => {
    void tick;
    if (!lease?.propertyId) return [];
    const property = getPropertyById(lease.propertyId);
    if (!property?.listingSubmission || property.listingSubmission.v !== 1) return [];
    try {
      return leaseFormChoicesForApplication(
        normalizeManagerListingSubmissionV1(property.listingSubmission),
        { ...(leaseApplicationSnapshotForRow(lease) ?? {}), applicationTemplateId: app?.application?.applicationTemplateId ?? leaseApplicationSnapshotForRow(lease)?.applicationTemplateId },
        lease.leaseKind === "joint_bundle" ? "joint_bundle" : "individual",
      ).choices;
    } catch {
      return [];
    }
  }, [lease, app, tick]);
  const selectedChoiceId = leaseChoices.find((c) => c.id === lease?.leaseGenerationTemplateId)?.id ?? leaseChoices[0]?.id ?? "";

  /* The four terms, seeded from the application once. */
  useEffect(() => {
    if (terms || !app) return;
    const next = leaseSendTermsFor(app);
    setTerms(next);
    setSavedTerms(next);
  }, [app, terms]);

  // The uploaded side opens by default when the lease already IS an uploaded PDF.
  const leaseHasPdf = Boolean(lease?.managerUploadedPdf);
  useEffect(() => {
    if (initialSource || !lease) return;
    if (leaseHasPdf && !lease.generatedHtml) setSource("pdf");
    // Only decides the first view; the segmented control owns it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lease?.id]);

  const residentName = app ? applicantDisplayName(app) : lease?.residentName || "";
  const residentEmail = (app?.email || lease?.residentEmail || "").trim();
  const firstName = residentName.split(/\s+/)[0] || "there";

  /* Resident account + payouts readiness (informational reads; the server decides at send). */
  useEffect(() => {
    if (!residentEmail) return;
    let cancelled = false;
    const check = () => {
      if (isDemoModeActive()) {
        setAccountEmails(new Set([residentEmail.toLowerCase()]));
        return;
      }
      // Forced: this screen asks BECAUSE the account may have just been created,
      // and the force also drops the page's other cached answers.
      void loadResidentAccountEmails([residentEmail.toLowerCase()], { force: true }).then((withAccount) => {
        if (!cancelled && withAccount) setAccountEmails(new Set(withAccount));
      });
    };
    check();
    // After an invite goes out the resident may create the account while this screen is open.
    const timer = invited ? window.setInterval(check, 8000) : null;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [residentEmail, invited]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/stripe/connect/status", { credentials: "include" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        const state = stripeSetupStateFromStatus(body);
        setPayoutsMissing(state === "unlinked" || state === "incomplete");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* ───────────── the document ───────────── */
  const pdfParse = lease?.uploadedLeaseParse ?? null;
  const hasDocument = lease ? leasePipelineRowHasDocument(lease) : false;
  const docIsPdf = Boolean(lease?.managerUploadedPdf) && !lease?.generatedHtml;

  /** Make the PropLane lease from the saved terms. Replaces nothing the manager wrote: only a lease with no document is made automatically. */
  const generateDocument = useCallback(
    async (rowId: string): Promise<boolean> => {
      setWorking("Preparing the lease…");
      try {
        const made = generateLeaseHtmlForRow(rowId, managerUserId, { persist: false });
        if (!made.ok) {
          setError(made.error);
          return false;
        }
        const row = readLeasePipeline(managerUserId).find((r) => r.id === rowId);
        const saved = row ? await persistLeaseRowToServerAwait(row) : ({ ok: false, error: "Lease not found." } as const);
        if (!saved.ok) {
          setError(saved.error);
          return false;
        }
        bump();
        return true;
      } finally {
        setWorking(null);
      }
    },
    [managerUserId, bump],
  );

  const chooseLeaseType = useCallback(
    async (choiceId: string) => {
      if (!lease) return;
      const choice = leaseChoices.find((c) => c.id === choiceId);
      if (!choice) return;
      setWorking("Preparing the lease…");
      setError(null);
      try {
        const made = generateLeaseHtmlForRow(lease.id, managerUserId, { templateId: choice.id, persist: false });
        if (!made.ok) {
          setError(made.error);
          return;
        }
        const row = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
        const saved = row ? await persistLeaseRowToServerAwait(row) : ({ ok: false, error: "Lease not found." } as const);
        if (!saved.ok) setError(saved.error);
        setConfirmed(false);
        bump();
      } finally {
        setWorking(null);
      }
    },
    [lease, leaseChoices, managerUserId, bump],
  );

  useEffect(() => {
    if (!lease || source !== "lease" || hasDocument) return;
    if (generatedForRef.current === lease.id) return;
    generatedForRef.current = lease.id;
    void generateDocument(lease.id);
  }, [lease, source, hasDocument, generateDocument]);

  /* ───────────── terms: saved on the application (and the draft lease) when the field is left ───────────── */
  const commitTerms = useCallback(
    async (next: LeaseSendTerms, opts: { regenerate: boolean }): Promise<boolean> => {
      if (!app || !lease) return false;
      const check = validateLeaseSendTerms(next);
      if (!check.ok) {
        setTermsError(check.message);
        return false;
      }
      setTermsError(null);
      if (savedTerms && leaseSendTermsEqual(next, savedTerms)) return true;
      setWorking("Updating the terms…");
      try {
        const patch = leaseSendTermsPatch(next);
        const current = readManagerApplicationRows().find((r) => r.id === app.id) ?? app;
        const updatedApp: DemoApplicantRow = { ...current, application: { ...(current.application ?? {}), ...patch } as DemoApplicantRow["application"] };
        writeManagerApplicationRows(
          readManagerApplicationRows().map((r) => (r.id === app.id ? updatedApp : r)),
          { serverConfirmed: true, skipLeaseSeed: true },
        );
        const saved = await upsertApplicationRowToServerAwait(updatedApp);
        if (!saved.ok && saved.error) {
          setTermsError(saved.error);
          return false;
        }
        if (opts.regenerate) {
          regenerateEditableLeasesForResident(lease.residentEmail, managerUserId, patch);
        } else {
          updateLeasePipelineRow(
            lease.id,
            {
              application: { ...(lease.application ?? {}), ...patch },
              signedRentLabel: `$${parseFloat(next.rent).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / month`,
            },
            managerUserId,
          );
        }
        const row = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
        const persisted = row ? await persistLeaseRowToServerAwait(row) : ({ ok: true } as const);
        if (!persisted.ok) {
          setTermsError(persisted.error);
          return false;
        }
        setSavedTerms(next);
        setConfirmed(false);
        bump();
        return true;
      } finally {
        setWorking(null);
      }
    },
    [app, lease, managerUserId, savedTerms, bump],
  );

  const schedule = useMemo(() => {
    void tick;
    const fresh = app ? readManagerApplicationRows().find((r) => r.id === app.id) ?? app : null;
    if (!fresh) return [];
    try {
      return leaseSendSchedule(fresh, managerUserId);
    } catch {
      return [];
    }
  }, [app, managerUserId, tick, savedTerms]);

  /* The lease fee and the one-resident waiver (the existing per-lease waiver route does the audited work). */
  const feeInfo = useMemo(() => {
    void tick;
    const fresh = app ? readManagerApplicationRows().find((r) => r.id === app.id) ?? app : null;
    if (!fresh) return { fee: 0, waived: false };
    try {
      return leaseFeeForSend(fresh, managerUserId);
    } catch {
      return { fee: 0, waived: false };
    }
  }, [app, managerUserId, tick, savedTerms]);
  const [waiveBusy, setWaiveBusy] = useState(false);
  const toggleLeaseFeeWaiver = async (next: boolean) => {
    if (!lease || waiveBusy) return;
    setWaiveBusy(true);
    setError(null);
    try {
      // The waiver route loads the lease from the server, so the draft has to be there first.
      const row = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
      if (row) {
        const saved = await persistLeaseRowToServerAwait(row);
        if (!saved.ok) {
          setError(saved.error);
          return;
        }
      }
      const result = next ? await waiveLeaseFeeForLease(lease.id, "Waived when sending the lease") : await reinstateLeaseFeeForLease(lease.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined);
      // The document and the schedule read the waiver: rebuild the PropLane lease so neither shows the fee.
      if (source === "lease" && !docIsPdf) await generateDocument(lease.id);
      setConfirmed(false);
      bump();
    } finally {
      setWaiveBusy(false);
    }
  };

  /* ───────────── the PDF beside the terms ───────────── */
  const pdfRows = useMemo(
    () => (source === "pdf" && terms ? pdfTermRows(pdfParse, terms) : []),
    [source, pdfParse, terms],
  );
  const unresolvedPdfTerms = pdfRows.filter((r) => r.differs && !picks[r.key]);

  const onPickPdf = async (file: File | null | undefined) => {
    if (!file || !lease) return;
    setError(null);
    setWorking("Reading the PDF…");
    try {
      const res = await uploadAndParseLeasePdf(lease.id, file, managerUserId);
      if (!res.ok) {
        setError(res.error ?? "Upload failed.");
        return;
      }
      if (res.saveError) setError(`PDF saved, but its reading was not stored: ${res.saveError}`);
      setPicks({});
      setConfirmed(false);
      generatedForRef.current = lease.id;
      await syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined);
      bump();
    } finally {
      setWorking(null);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  /* ───────────── what stands between this lease and a signature ───────────── */
  const hasAccount = Boolean(residentEmail) && (accountEmails?.has(residentEmail.toLowerCase()) ?? false);
  const needsApproval = Boolean(app && app.bucket !== "approved");
  const needsPlacementReview = Boolean(lease && leaseNeedsTemplatePlacementReview(lease));
  const landlordWarning = lease && source === "lease" ? leaseLandlordNameWarning(lease) : null;
  const gate = lease && !needsApproval && !needsPlacementReview ? leaseSendGateBlocker(lease) : null;
  // The uploaded PDF's own review (confirm the reading, settle a disagreement with the record) is satisfied by
  // this very screen — the checkbox and the taps — so it is not a row; anything else the gate reports is.
  const pdfSelfResolving = Boolean(
    lease && source === "pdf" && lease.uploadedLeaseParse && (leaseAwaitsUploadedLeaseReview(lease) || leaseMismatchAcknowledgementGapForRow(lease) !== null),
  );
  const otherGate = gate && !pdfSelfResolving && gate !== "Generate or upload a lease document first." ? gate : null;
  const termsBlocked = !terms || !validateLeaseSendTerms(terms).ok;
  const documentReady = source === "lease" ? hasDocument && !docIsPdf : Boolean(lease?.managerUploadedPdf);
  const blockedBy: string[] = [];
  if (needsApproval) blockedBy.push("approve");
  if (residentEmail && !hasAccount) blockedBy.push("invite");
  if (needsPlacementReview) blockedBy.push("review");
  if (otherGate) blockedBy.push("gate");
  if (unresolvedPdfTerms.length > 0) blockedBy.push("terms");
  const canSend = Boolean(
    lease && terms && !termsBlocked && documentReady && confirmed && blockedBy.length === 0 && !busy && !working,
  );

  /* ───────────── the message ───────────── */
  const unit = lease?.unit?.trim() || "your unit";
  const defaultBody = buildLeaseReadyForResidentMessage({
    residentName: residentName || "there",
    residentEmail,
    unit,
    variant: "send",
  });
  const message = note ?? defaultBody;
  const sendsMessage = channels.viaEmail || channels.viaSms;
  const channelWord = channels.viaEmail && channels.viaSms ? "Email and text" : channels.viaSms ? "Text" : channels.viaEmail ? "Email" : "No message";

  /* ───────────── send ───────────── */
  const send = async () => {
    if (!lease || !terms || !app || busy) return;
    setBusy(true);
    setError(null);
    try {
      let nextTerms = terms;
      let overrides: ReturnType<typeof resolvePdfTermPicks>["overrides"] = {};
      if (source === "pdf") {
        const resolved = resolvePdfTermPicks(pdfRows, picks, terms);
        nextTerms = resolved.terms;
        overrides = resolved.overrides;
        if (resolved.unresolved.length > 0) {
          setError("Tap the right value for each term the PDF and the record disagree on.");
          return;
        }
      }
      const committed = await commitTerms(nextTerms, { regenerate: source === "lease" });
      if (!committed) return;
      setTerms(nextTerms);

      if (source === "lease") {
        // Terms may have moved the schedule or the document; the document is rebuilt from the saved terms above.
        const row = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
        if (!row || !leasePipelineRowHasDocument(row)) {
          if (!(await generateDocument(lease.id))) return;
        }
      } else {
        const row = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
        if (row?.uploadedLeaseParse) {
          if (!isDemoModeActive()) {
            // The terms just saved may have moved the review revision; read it fresh.
            await syncLeasePipelineFromServer(managerUserId, { force: true }).catch(() => undefined);
            const reviewRow = readLeasePipeline(managerUserId).find((r) => r.id === lease.id) ?? row;
            const confirmedReview = await confirmUploadedLeaseParseOnServer(reviewRow.id, {
              managerUserId,
              overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
              useConverted: false,
              expectedRevision: reviewRow.reviewRevision,
              viewedSourceSha256: (reviewRow.uploadedLeaseParse ?? row.uploadedLeaseParse)?.sourceSha256 ?? undefined,
              viewedConvertedHtmlSha256: null,
              viewedRecordFingerprint: leaseRecordFingerprint(leaseRecordTerms(reviewRow)),
            });
            if (!confirmedReview.ok) {
              setError(confirmedReview.error);
              return;
            }
          }
        }
      }

      // A joint shared-room lease goes to every roommate at once: link their leases, give them the same
      // dates, rebuild each document so it names the roommates, then send them all.
      let targets: Array<{ row: LeasePipelineRow; name: string; email: string }> = [];
      if (source === "lease" && jointMates.length > 0) {
        const linked = linkJointRoomLeases(app, readManagerApplicationRows(), managerUserId);
        if (!linked.ok) {
          setError(linked.error);
          return;
        }
        setWorking("Preparing the joint lease…");
        const datePatch = { leaseStart: nextTerms.start, leaseEnd: nextTerms.end };
        for (const mate of jointMates.slice(1)) {
          const current = readManagerApplicationRows().find((r) => r.id === mate.id) ?? mate;
          const updated: DemoApplicantRow = { ...current, application: { ...(current.application ?? {}), ...datePatch } as DemoApplicantRow["application"] };
          writeManagerApplicationRows(readManagerApplicationRows().map((r) => (r.id === mate.id ? updated : r)), { serverConfirmed: true, skipLeaseSeed: true });
          const savedMate = await upsertApplicationRowToServerAwait(updated);
          if (!savedMate.ok && savedMate.error) {
            setError(savedMate.error);
            return;
          }
        }
        for (const row of linked.rows) {
          regenerateEditableLeasesForResident(row.residentEmail, managerUserId, row.id === lease.id ? undefined : datePatch);
          const regenerated = readLeasePipeline(managerUserId).find((r) => r.id === row.id);
          const persisted = regenerated ? await persistLeaseRowToServerAwait(regenerated) : ({ ok: false, error: "Lease not found." } as const);
          if (!persisted.ok) {
            setError(persisted.error);
            return;
          }
          const mate = jointMates.find((m) => m.email?.trim().toLowerCase() === row.residentEmail.trim().toLowerCase());
          if (regenerated) targets.push({ row: regenerated, name: mate ? applicantDisplayName(mate) : row.residentName, email: row.residentEmail });
        }
      } else {
        const fresh = readLeasePipeline(managerUserId).find((r) => r.id === lease.id);
        if (fresh) targets = [{ row: fresh, name: residentName, email: residentEmail }];
      }
      if (targets.length === 0) {
        setError("Lease not found.");
        return;
      }

      for (const target of targets) {
        const blocker = leaseSendGateBlocker(target.row);
        if (blocker) {
          setError(targets.length > 1 ? `${target.name}: ${blocker}` : blocker);
          bump();
          return;
        }
      }
      setWorking("Sending…");
      let toastMessage = targets.length > 1 ? `Joint lease sent · ${targets.length} roommates` : `Lease sent · ${residentName}`;
      for (const target of targets) {
        const sent = await sendLeaseToResident(target.row.id, managerUserId);
        if (!sent.ok) {
          setError(sent.error ?? "Could not send the lease.");
          return;
        }
        appendLeaseThreadMessage(target.row.id, "manager", "Sent lease to resident for review and signature.", managerUserId);
        if (sendsMessage && target.email) {
          const own = target.row.id === lease.id;
          const delivered = await deliverPortalInboxMessage({
            eventCategory: "leases",
            fromName: "Property Manager",
            toEmails: [target.email],
            subject: `Your lease for ${target.row.unit?.trim() || "your unit"} is ready to sign`,
            text: own
              ? message
              : buildLeaseReadyForResidentMessage({ residentName: target.name || "there", residentEmail: target.email, unit: target.row.unit?.trim() || "your unit", variant: "send" }),
            deliverViaEmail: channels.viaEmail,
            deliverViaSms: channels.viaSms,
          }).catch(() => ({ ok: false as const }));
          if (!delivered.ok) toastMessage = `${toastMessage}. A message could not be delivered.`;
        }
      }
      showToast(toastMessage);
      onSent?.(lease.id);
      onClose();
    } finally {
      setWorking(null);
      setBusy(false);
    }
  };

  /* ───────────── candidates for the picker (the Leases list +) ───────────── */
  const candidates = useMemo(() => {
    void tick;
    if (!pickResident) return [];
    const leases = readLeasePipeline(managerUserId);
    return apps
      .filter((a) => a.bucket === "approved" && !a.withdrawnAt && a.email?.trim().includes("@"))
      .filter((a) => {
        const email = a.email!.trim().toLowerCase();
        const existing = leases.find((l) => l.residentEmail.trim().toLowerCase() === email);
        return !existing || existing.status === "Manager Review" || existing.status === "Draft";
      })
      .sort((a, b) => applicantDisplayName(a).localeCompare(applicantDisplayName(b)));
  }, [pickResident, apps, managerUserId, tick]);

  /* ───────────── render ───────────── */
  const title = residentName ? `Send lease · ${residentName}` : "Send lease";
  const showPicker = pickResident && !applicationIdProp && !leaseIdProp;

  const primary = {
    label: "Send for signature",
    loading: busy,
    disabled: !canSend,
    dataAttr: "lease-send-confirm",
    onClick: () => void send(),
  };

  return (
    <>
      <PortalDialog open title={title} onClose={() => !busy && onClose()} dismissBlocked={busy} size="wizard" dataAttr="lease-send-sheet" primaryAction={primary} className="lease-send-sheet">
        <div className="space-y-5" data-attr="lease-send-body">
          {/* The pop-up's one upload entry: the Start from a file card (the Leases list has no Upload of its own). Reads the lease PDF you pick in place of the PropLane lease. */}
          {!lease?.managerUploadedPdf ? (
            <WorkspaceFileCard
              accept="application/pdf,.pdf"
              chips={[".pdf", "up to 3.5 MB"]}
              dataAttr="lease-send-header-upload"
              disabled={busy || !(lease && app && terms)}
              onPick={(file) => {
                setSource("pdf");
                setConfirmed(false);
                setError(null);
                void onPickPdf(file);
              }}
            />
          ) : null}
          {showPicker ? (
            <FieldSingleSelect
              label="Resident"
              value={pickedApplicationId}
              onChange={(next) => {
                setPickedApplicationId(next);
                setLeaseId(null);
                setTerms(null);
                setSavedTerms(null);
                setConfirmed(false);
                setPicks({});
              }}
              placeholder="Choose a resident"
              options={candidates.map((a) => ({ value: a.id, label: approvedResidentOptionLabel({ residentName: applicantDisplayName(a), roomLabel: roomForApplicationRow(a)?.name ?? a.property ?? "" }) }))}
              dataAttr="lease-send-resident"
            />
          ) : null}

          {loadError ? <p className="text-sm text-danger" role="alert">{loadError}</p> : null}

          {lease && app && terms ? (
            <>
              <SegmentedTwo<Source>
                value={source}
                onChange={(next) => {
                  setSource(next);
                  setConfirmed(false);
                  setError(null);
                }}
                left={{ id: "lease", label: "PropLane lease" }}
                right={{ id: "pdf", label: "Upload PDF" }}
              />

              <div className={cn("grid gap-5", source === "pdf" && lease.managerUploadedPdf ? "lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]" : "")}>
                {source === "pdf" && lease.managerUploadedPdf ? (
                  <div className="min-w-0 space-y-2" data-attr="lease-send-pdf">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[13px] font-semibold">{lease.managerUploadedPdf.fileName || "Lease.pdf"}</p>
                      <PortalIconAction icon={FileUp} label="Replace PDF" data-attr="lease-send-replace-pdf" onClick={() => uploadRef.current?.click()} />
                    </div>
                    <div className="h-[28rem] overflow-hidden rounded-xl border border-border bg-card">
                      <LeaseDocumentPreview row={lease} fill />
                    </div>
                  </div>
                ) : null}

                <div className="min-w-0 space-y-4">
                  {source === "lease" && !docIsPdf && leaseChoices.length > 1 ? (
                    <FieldSingleSelect
                      label="Lease form"
                      value={selectedChoiceId}
                      onChange={(next) => void chooseLeaseType(next)}
                      options={leaseChoices.map((c) => ({ value: c.id, label: c.label }))}
                      disabled={busy || Boolean(working)}
                      dataAttr="lease-send-lease-type"
                    />
                  ) : null}
                  <TermsCard
                    terms={terms}
                    disabled={busy}
                    error={termsError}
                    rows={pdfRows}
                    picks={picks}
                    onPick={(key, pick) => {
                      setPicks((p) => ({ ...p, [key]: pick }));
                      setConfirmed(false);
                    }}
                    onChange={(next) => {
                      setTerms(next);
                      setConfirmed(false);
                    }}
                    onCommit={(next) => void commitTerms(next, { regenerate: source === "lease" })}
                  />

                  {source === "lease" && docIsPdf ? (
                    <div className="space-y-2 rounded-xl border border-border p-4">
                      <p className="text-sm text-foreground">This lease is currently an uploaded PDF.</p>
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-full"
                        data-attr="lease-send-use-proplane"
                        disabled={busy || Boolean(working)}
                        onClick={() => void generateDocument(lease.id)}
                      >
                        Use the PropLane lease instead
                      </Button>
                    </div>
                  ) : null}

                  {source === "lease" && !docIsPdf ? (
                    <div className="h-72 overflow-hidden rounded-xl border border-border bg-card" data-attr="lease-send-document">
                      {hasDocument ? (
                        <LeaseDocumentPreview row={lease} fill />
                      ) : (
                        <p className="p-4 text-sm text-muted">{working ?? "Preparing the lease…"}</p>
                      )}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={confirmed}
                    disabled={!documentReady}
                    onClick={() => setConfirmed((v) => !v)}
                    data-attr="lease-send-confirm-box"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-bold disabled:opacity-50",
                      confirmed ? "border-primary bg-primary/5" : "border-border",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-md border",
                        confirmed ? "border-primary bg-primary text-white" : "border-border",
                      )}
                      aria-hidden
                    >
                      {confirmed ? "✓" : null}
                    </span>
                    This is the lease I&apos;m sending
                  </button>

                  {schedule.length > 0 ? (
                    <div data-attr="lease-send-schedule">
                      <p className="mb-1 text-[13px] font-bold text-foreground">Payments schedule</p>
                      <div className="divide-y divide-border/60 rounded-xl border border-border px-4">
                        {schedule.map((row) => (
                          <div key={row.key} className="flex min-h-11 items-center justify-between gap-3 py-2.5 text-sm">
                            <span className="text-muted">{row.label}</span>
                            <span className="font-bold text-foreground">{money(row.amount)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {feeInfo.fee > 0 || feeInfo.waived ? (
                    <div
                      className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border px-4 py-1.5 text-sm"
                      data-attr="lease-send-fee"
                    >
                      <span className="min-w-0 font-semibold text-foreground">
                        Waive the lease fee{feeInfo.fee > 0 ? ` · ${money(feeInfo.fee)}` : ""}
                      </span>
                      <PortalSettingsToggle
                        checked={feeInfo.waived}
                        onChange={(next) => void toggleLeaseFeeWaiver(next)}
                        label="Waive the lease fee"
                        disabled={busy || waiveBusy || Boolean(working)}
                        dataAttr="lease-send-waive-fee"
                      />
                    </div>
                  ) : null}

                  {jointCard && source === "lease" ? (
                    <div data-attr="lease-send-roommates">
                      <p className="mb-1 text-[13px] font-bold text-foreground">Roommates on this lease</p>
                      <div className="divide-y divide-border/60 rounded-xl border border-border px-4">
                        {jointCard.roommates.map((m) => (
                          <div key={m.id} className="flex min-h-11 items-center justify-between gap-3 py-2.5 text-sm" data-attr="lease-send-roommate">
                            <span className="min-w-0 truncate font-semibold text-foreground">{m.name}</span>
                            <span className="shrink-0 text-muted">
                              {[m.bedLabel, m.rentLabel].filter(Boolean).join(" · ")}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <ReadyRows
                    show={{
                      approve: needsApproval,
                      invite: Boolean(residentEmail) && !hasAccount,
                      review: needsPlacementReview,
                      gate: otherGate,
                      payouts: payoutsMissing,
                      landlord: landlordWarning,
                    }}
                    firstName={firstName}
                    invited={invited}
                    onApprove={() => app && setApproveRow(app)}
                    onInvite={async () => {
                      const res = await requestResidentWelcomeEmail(app);
                      if (res.status === "sent" || isDemoModeActive()) {
                        setInvited(true);
                        showToast(`Invite sent · ${residentName}`);
                      } else {
                        showToast(res.error ?? "Could not send the invite.");
                      }
                    }}
                    onReview={() => lease && setPlacementReviewRow(lease)}
                    onPayouts={() => navigate("/portal/profile?tab=payments")}
                    onLandlord={() => navigate("/portal/profile?tab=profile")}
                  />

                  {sendsMessage ? (
                    <div>
                      <div className="flex min-h-11 items-center justify-between gap-3 border-t border-border/60 py-2.5">
                        <span className="min-w-0 text-sm font-semibold text-foreground">
                          {channelWord} · Your lease for {unit} is ready to sign
                        </span>
                        <PortalIconAction
                          icon={Pencil}
                          label={noteOpen ? "Hide message" : "Edit message"}
                          active={noteOpen}
                          data-attr="lease-send-edit-message"
                          onClick={() => setNoteOpen((v) => !v)}
                        />
                      </div>
                      {noteOpen ? (
                        <Textarea
                          aria-label="Message to the resident"
                          rows={5}
                          value={message}
                          disabled={busy}
                          onChange={(e) => setNote(e.target.value)}
                          data-attr="lease-send-message"
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {working ? <p className="text-sm text-muted" role="status">{working}</p> : null}
                  {error ? <p className="text-sm text-danger" role="alert" data-attr="lease-send-error">{error}</p> : null}
                </div>
              </div>
            </>
          ) : needsApproval && app ? (
            <ReadyRows
              show={{ approve: true, invite: false, review: false, gate: null, payouts: false, landlord: null }}
              firstName={firstName}
              invited={false}
              onApprove={() => setApproveRow(app)}
              onInvite={() => undefined}
              onReview={() => undefined}
              onPayouts={() => undefined}
              onLandlord={() => undefined}
            />
          ) : !showPicker && !loadError ? (
            <p className="text-sm text-muted" role="status">Loading…</p>
          ) : null}
        </div>
        <input
          ref={uploadRef}
          type="file"
          accept="application/pdf"
          className="sr-only"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => void onPickPdf(e.target.files?.[0])}
        />
      </PortalDialog>

      <ApproveApplicationDialog
        row={approveRow}
        userId={managerUserId}
        onClose={() => setApproveRow(null)}
        onApproved={() => {
          setApproveRow(null);
          bump();
        }}
        onSendLease={() => undefined}
      />

      <ImportedLeasePlacementReviewModal
        row={placementReviewRow}
        onClose={() => setPlacementReviewRow(null)}
        onConfirm={async () => {
          if (!placementReviewRow) return;
          const res = await confirmTemplatePlacementReviewForRow(placementReviewRow, managerUserId);
          if (!res.ok) {
            showToast(res.error);
            return;
          }
          setPlacementReviewRow(null);
          bump();
        }}
      />
    </>
  );
}

/* ───────────────────────────────── pieces ───────────────────────────────── */

function TermsCard({
  terms,
  rows,
  picks,
  disabled,
  error,
  onChange,
  onCommit,
  onPick,
}: {
  terms: LeaseSendTerms;
  rows: ReturnType<typeof pdfTermRows>;
  picks: Partial<Record<PdfTermKey, PdfTermPick>>;
  disabled: boolean;
  error: string | null;
  onChange: (next: LeaseSendTerms) => void;
  onCommit: (next: LeaseSendTerms) => void;
  onPick: (key: PdfTermKey, pick: PdfTermPick) => void;
}) {
  const conflictFor = (key: PdfTermKey) => rows.find((r) => r.key === key && r.differs);
  const field = (label: string, key: PdfTermKey, control: React.ReactNode) => {
    const conflict = conflictFor(key);
    return (
      <div className="min-w-0 space-y-1.5" data-attr={`lease-send-term-${key}`}>
        <p className="text-xs font-bold text-muted">{label}</p>
        {conflict ? (
          <div className="flex gap-2" data-attr={`lease-send-conflict-${key}`}>
            <PickChip
              active={picks[key] === "pdf"}
              caption="In the PDF"
              value={key === "monthlyRent" || key === "securityDeposit" ? `$${conflict.pdfValue?.replace(/^\$/, "")}` : conflict.pdfValue ?? ""}
              onClick={() => onPick(key, "pdf")}
            />
            <PickChip
              active={picks[key] === "record"}
              caption="On the record"
              value={key === "monthlyRent" || key === "securityDeposit" ? `$${conflict.recordValue}` : conflict.recordValue}
              onClick={() => onPick(key, "record")}
            />
          </div>
        ) : (
          control
        )}
      </div>
    );
  };
  return (
    <div className="space-y-2" data-attr="lease-send-terms">
      <div className="grid grid-cols-2 gap-x-3.5 gap-y-3 max-sm:grid-cols-1">
        {field(
          "Start",
          "leaseStart",
          <DateField value={terms.start} disabled={disabled} onChange={(v) => { const next = { ...terms, start: v }; onChange(next); onCommit(next); }} aria-label="Lease start" />,
        )}
        {field(
          "End",
          "leaseEnd",
          <DateField value={terms.end} disabled={disabled} onChange={(v) => { const next = { ...terms, end: v }; onChange(next); onCommit(next); }} aria-label="Lease end" />,
        )}
        {field(
          "Rent",
          "monthlyRent",
          <MoneyInput value={terms.rent} disabled={disabled} label="Monthly rent" suffix="/ month" onChange={(v) => onChange({ ...terms, rent: v })} onCommit={(v) => onCommit({ ...terms, rent: v })} />,
        )}
        {field(
          "Deposit",
          "securityDeposit",
          <MoneyInput value={terms.deposit} disabled={disabled} label="Security deposit" onChange={(v) => onChange({ ...terms, deposit: v })} onCommit={(v) => onCommit({ ...terms, deposit: v })} />,
        )}
      </div>
      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

function PickChip({ active, caption, value, onClick }: { active: boolean; caption: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-start rounded-xl border px-3 py-1.5 text-left",
        active ? "border-primary bg-primary/5" : "border-amber-300 bg-amber-50/60",
      )}
    >
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{caption}</span>
      <span className="max-w-full truncate text-sm font-bold text-foreground">{value}</span>
    </button>
  );
}

function MoneyInput({
  value,
  label,
  suffix,
  disabled,
  onChange,
  onCommit,
}: {
  value: string;
  label: string;
  suffix?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  return (
    <span className="flex items-center gap-1.5 font-bold text-muted">
      <span>$</span>
      <Input
        aria-label={label}
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit((e.target as HTMLInputElement).value);
        }}
      />
      {suffix ? <span className="shrink-0 text-[13px] font-semibold">{suffix}</span> : null}
    </span>
  );
}

function ReadyRows({
  show,
  firstName,
  invited,
  onApprove,
  onInvite,
  onReview,
  onPayouts,
  onLandlord,
}: {
  show: { approve: boolean; invite: boolean; review: boolean; gate: string | null; payouts: boolean; landlord: string | null };
  firstName: string;
  invited: boolean;
  onApprove: () => void;
  onInvite: () => void | Promise<void>;
  onReview: () => void;
  onPayouts: () => void;
  onLandlord: () => void;
}) {
  const rows: { id: string; label: string; action?: { label: string; onClick: () => void | Promise<void>; disabled?: boolean } }[] = [];
  if (show.approve) rows.push({ id: "approve", label: `Approve ${firstName}`, action: { label: "Approve", onClick: onApprove } });
  if (show.invite) {
    rows.push({
      id: "invite",
      label: invited ? `Invite sent · waiting for ${firstName} to create an account` : `${firstName} has no PropLane account yet`,
      action: invited ? undefined : { label: "Send invite", onClick: onInvite },
    });
  }
  if (show.review) rows.push({ id: "review", label: "Compare the lease with the original", action: { label: "Review", onClick: onReview } });
  if (show.gate) rows.push({ id: "gate", label: show.gate });
  if (show.payouts) rows.push({ id: "payouts", label: "Payouts are not set up", action: { label: "Set up payouts", onClick: onPayouts } });
  if (show.landlord) rows.push({ id: "landlord", label: "Your name is missing from the lease", action: { label: "Add name", onClick: onLandlord } });
  if (rows.length === 0) return null;
  return (
    <div data-attr="lease-send-ready">
      <p className="mb-1 text-[13px] font-bold text-foreground">Ready to send</p>
      <div className="divide-y divide-border/60 rounded-xl border border-border px-4">
        {rows.map((row) => (
          <div key={row.id} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm" data-attr={`lease-send-ready-${row.id}`}>
            <span className="min-w-0 text-foreground">{row.label}</span>
            {row.action ? (
              <Button type="button" variant="outline" className="shrink-0 rounded-full" disabled={row.action.disabled} onClick={() => void row.action!.onClick()}>
                {row.action.label}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
