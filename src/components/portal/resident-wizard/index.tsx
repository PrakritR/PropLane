"use client";

/**
 * Add resident / Add prospect — the manager Residents tab's + button.
 *
 * Current resident: Resident · Home · Application · Lease · Payments ·
 * Documents · Review. Prospect: Prospect · Interested in · Tour · Review.
 * Both end with a message the manager previews before it sends.
 *
 * Plan: `.lavish/plans/PLAN-0916-1004-*`.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import type { FileStripState } from "@/components/portal/add-workspace/parts";
import { parseResidentDocumentPdfClient, readDataUrlFromFile } from "@/lib/resident-document-import.client";
import { mergeParsedFields } from "@/lib/resident-document-import/onboard-draft";
import { fillOnlyBlank, mapParsedFieldsToAddResidentForm, mapParsedFieldsToApplicationAnswers } from "@/lib/resident-document-import/apply-parsed-to-add-resident";
import type { ParsedResidentDocument } from "@/lib/resident-document-import/types";
import { EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT, buildExistingResidentWelcomeEmailBody } from "@/lib/existing-resident-welcome-email";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import { TOUR_CONFIRMED_TENANT_SUBJECT, buildTourConfirmedTenantBody, buildTourNotificationContext } from "@/lib/tour-notifications";
import { getPropertyById } from "@/lib/rental-application/data";
import type { WorkAssignee } from "@/lib/work-assignment";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { commitApplicationDraft, commitProspect, commitResident, sendApplicationStartedEmail, sendClosingMessage, type CommitOutcome } from "./commit";
import { useResidentWizardDerived } from "./derived";
import { ContactStep } from "./step-contact";
import { HomeStep, type PropertyOption } from "./step-home";
import { ApplicationStep } from "./step-application";
import { LeaseStep } from "./step-lease";
import { PaymentsStep } from "./step-payments";
import { DocumentsStep } from "./step-documents";
import { TourStep } from "./step-tour";
import { ReviewStep } from "./step-review";
import { ResidentSidePanel } from "./side-panel";
import {
  addPersonFormIsDirty,
  buildApplicationDraftRow,
  buildManualResidentRow,
  buildProspectRow,
  emptyAddPersonForm,
  formatMoney,
  thingsToFinish,
  type AddPersonForm,
  type FieldMarkKind,
} from "./state";

const RESIDENT_STEPS = ["contact", "home", "application", "lease", "payments", "documents", "review"] as const;
const PROSPECT_STEPS = ["contact", "home", "tour", "review"] as const;
const APPLICATION_STEPS = ["contact", "home", "application", "documents", "review"] as const;
const MAX_PDF_BYTES = 3.5 * 1024 * 1024;

function moneyOr0(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function AddResidentWizard({
  onClose,
  onAdded,
  managerUserId,
  propertyOptions,
  propertyTick,
  executedLeaseKeys,
  initialKind = "resident",
  mode = "person",
  defaultPropertyId,
}: {
  onClose: () => void;
  /** The row landed (and whatever else the wizard created). */
  onAdded: (outcome: CommitOutcome) => void;
  managerUserId: string | null;
  propertyOptions: PropertyOption[];
  propertyTick: number;
  executedLeaseKeys: { axisIds: Set<string>; emails: Set<string> };
  initialKind?: "resident" | "prospect";
  /**
   * "tour" is the Tours tab's door: the prospect flow with When first-class —
   * Guest · Home · When · Review, no kind switch, "Schedule tour" at the end.
   * "application" is the Application tab's door: Applicant · Home ·
   * Application · Documents · Review, landing as a pending in-progress draft.
   */
  mode?: "person" | "tour" | "application";
  defaultPropertyId?: string;
}) {
  const { showToast } = useAppUi();
  const [form, setForm] = useState<AddPersonForm>(() => ({ ...emptyAddPersonForm(mode === "tour" ? "prospect" : initialKind), propertyId: defaultPropertyId ?? "" }));
  const [stepIdx, setStepIdx] = useState(0);
  const [strip, setStrip] = useState<FileStripState>({ kind: "blank" });
  const [busy, setBusy] = useState(false);
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [preview, setPreview] = useState<{ row: DemoApplicantRow; subject: string; body: string } | null>(null);
  const parsesRef = useRef<{ application: ParsedResidentDocument | null; lease: ParsedResidentDocument | null }>({ application: null, lease: null });
  const undoRef = useRef<AddPersonForm | null>(null);

  const patch = useCallback((next: Partial<AddPersonForm>) => setForm((prev) => ({ ...prev, ...next })), []);
  // The commit reads the form through a ref so a callback captured on an
  // earlier render can never write a stale copy of what the manager typed.
  const formRef = useRef(form);
  useLayoutEffect(() => {
    formRef.current = form;
  }, [form]);
  const derived = useResidentWizardDerived(form, propertyTick, patch);
  const stepIds: readonly string[] = mode === "application" ? APPLICATION_STEPS : form.kind === "prospect" ? PROSPECT_STEPS : RESIDENT_STEPS;
  const current = Math.min(stepIdx, stepIds.length - 1);
  const stepId = stepIds[current]!;
  const goTo = useCallback((id: string) => setStepIdx(Math.max(0, stepIds.indexOf(id))), [stepIds]);
  const propertyLabel = useMemo(() => propertyOptions.find((p) => p.id === form.propertyId)?.label ?? null, [propertyOptions, form.propertyId]);
  const todo = useMemo(() => {
    const base = thingsToFinish(form, mode);
    if (mode === "tour" && !form.propertyId) base.push({ step: "home", label: "Property to show" });
    return base;
  }, [form, mode]);

  const steps = useMemo<AddWorkspaceStep[]>(() => {
    const missing = (id: string) => todo.some((t) => t.step === id);
    const rent = moneyOr0(form.rent);
    const paidMonths = Object.values(form.paymentMarks).filter((m) => m.status === "paid").length;
    if (mode === "application") {
      const appFilled = [form.application.employer ? "Employment" : null, form.application.currentStreet ? "address" : null, form.application.ref1Name ? "1 reference" : null].filter(Boolean).join(" · ");
      return [
        { id: "contact", label: "Applicant", incomplete: missing("contact"), summary: form.name.trim() ? [form.name.trim(), form.email.trim()].filter(Boolean).join(" · ") : "Who is applying" },
        { id: "home", label: "Home", incomplete: missing("home"), summary: propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "No property yet" },
        { id: "application", label: "Application", offPath: true, summary: appFilled || "The house's questions" },
        { id: "documents", label: "Documents", offPath: true, summary: form.documents.length ? `${form.documents.length} attached` : "None attached" },
        { id: "review", label: "Review", incomplete: todo.length > 0, summary: todo.length ? `${todo.length} to finish` : "Ready to add" },
      ];
    }
    if (form.kind === "prospect") {
      const tourMode = mode === "tour";
      return [
        { id: "contact", label: tourMode ? "Guest" : "Prospect", incomplete: missing("contact"), summary: form.name.trim() ? [form.name.trim(), form.phone.trim() || form.email.trim()].filter(Boolean).join(" · ") : "Who they are" },
        { id: "home", label: tourMode ? "Home" : "Interested in", incomplete: tourMode && !form.propertyId, summary: propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "No property yet" },
        { id: "tour", label: tourMode ? "When" : "Tour", incomplete: missing("tour"), summary: form.tourFormat === "none" ? "No tour yet" : form.tourDate ? `${form.tourDate} · ${form.tourStart} · ${form.tourFormat === "virtual" ? "virtual" : "in person"}` : "Pick a time" },
        { id: "review", label: "Review", incomplete: todo.length > 0, summary: todo.length ? `${todo.length} to finish` : tourMode ? "Ready to schedule" : "Ready to add" },
      ];
    }
    return [
      { id: "contact", label: "Resident", incomplete: missing("contact"), summary: form.name.trim() ? [form.name.trim(), form.email.trim()].filter(Boolean).join(" · ") : "Who they are" },
      { id: "home", label: "Home", incomplete: missing("home"), summary: propertyLabel ? `${propertyLabel}${derived.listingSays ? ` · ${derived.listingSays.split(" · ")[0]}` : ""}` : "No property yet" },
      { id: "application", label: "Application", offPath: true, summary: form.application.employer || form.application.currentStreet ? [form.application.employer ? "Employment" : null, form.application.currentStreet ? "address" : null, form.application.ref1Name ? "1 reference" : null].filter(Boolean).join(" · ") : "Optional · nothing yet" },
      { id: "lease", label: "Lease", incomplete: missing("lease"), summary: rent && form.moveInDate ? `${formatMoney(rent)}/${derived.isShortTerm ? "night" : "mo"} · ${form.moveInDate}${form.moveOutDate ? ` → ${form.moveOutDate}` : ""}` : "Rent not set" },
      { id: "payments", label: "Payments", offPath: true, summary: derived.isAirbnb ? "Nothing billed" : form.billingStart === "next_due" ? "From the next due date" : paidMonths ? `${paidMonths} paid` : "From move-in" },
      { id: "documents", label: "Documents", offPath: true, summary: form.documents.length ? `${form.documents.length} attached` : "None attached" },
      { id: "review", label: "Review", incomplete: todo.length > 0, summary: todo.length ? `${todo.length} to finish` : "Ready to add" },
    ];
  }, [form, todo, propertyLabel, derived.listingSays, derived.isShortTerm, derived.isAirbnb, mode]);

  /* ─────────── files ─────────── */

  const applyParsed = useCallback(
    (kind: "application" | "lease", parsed: ParsedResidentDocument, file: File, dataUrl: string) => {
      setForm((prev) => {
        if (!undoRef.current) undoRef.current = prev;
        const merged = mergeParsedFields(kind === "application" ? parsed : parsesRef.current.application, kind === "lease" ? parsed : parsesRef.current.lease);
        const mapped = mapParsedFieldsToAddResidentForm({ fields: merged, parse: parsed, leaseTermPresetValues: derived.leaseTermPresetValues });
        const marks: Record<string, FieldMarkKind> = { ...prev.marks };
        const fromFile = (k: string) => {
          const conf = parsed.fields.find((f) => f.key === k)?.confidence;
          return conf === "low" ? "check" : "fromFile";
        };
        const contactFill = fillOnlyBlank(
          { name: prev.name, email: prev.email, phone: prev.phone, propertyId: prev.propertyId, roomId: prev.roomId, leaseTerm: prev.leaseTerm, moveInDate: prev.moveInDate, moveOutDate: prev.moveOutDate, rent: prev.rent, utilities: prev.utilities, moveInFee: prev.moveInFee, securityDeposit: prev.securityDeposit },
          { name: mapped.name, email: mapped.email, phone: mapped.phone, propertyId: mapped.propertyId, roomId: mapped.roomId, leaseTerm: mapped.leaseTerm, moveInDate: mapped.moveInDate, moveOutDate: mapped.moveOutDate, rent: mapped.rent, utilities: mapped.utilities, moveInFee: mapped.moveInFee, securityDeposit: mapped.securityDeposit },
        );
        const keyMap: Record<string, string> = { name: "tenantName", email: "tenantEmail", phone: "tenantPhone", propertyId: "propertyId", roomId: "roomId", leaseTerm: "leaseTerm", moveInDate: "leaseStart", moveOutDate: "leaseEnd", rent: "monthlyRent", utilities: "monthlyUtilities", moveInFee: "moveInFee", securityDeposit: "securityDeposit" };
        for (const k of contactFill.filledKeys) marks[k] = fromFile(keyMap[k] ?? k);
        let application = prev.application;
        let appFilled = 0;
        if (kind === "application") {
          const fill = mapParsedFieldsToApplicationAnswers(parsed.fields);
          const res = fillOnlyBlank(prev.application as Record<string, unknown>, fill.answers);
          application = res.next as AddPersonForm["application"];
          for (const k of res.filledKeys) marks[k] = fill.marks[k] ?? "fromFile";
          appFilled = res.filledKeys.length;
        }
        const leaseTermCustomMode = contactFill.filledKeys.includes("leaseTerm") ? Boolean(mapped.leaseTermCustomMode) : prev.leaseTermCustomMode;
        const documents = prev.documents.some((d) => d.file === file)
          ? prev.documents
          : [...prev.documents, { id: `${Date.now()}-${file.name}`, file, kind: kind === "lease" ? (prev.leaseDocument === "draft" ? "lease_draft" : "lease_signed") : "application", note: `read · filled ${kind === "lease" ? "Lease" : "Contact + Application"}` }];
        const filled = contactFill.filledKeys.length + appFilled;
        const lowCount = Object.values(marks).filter((m) => m === "check").length;
        setStrip({ kind: "read", summary: `Read ${file.name} · ${filled} ${filled === 1 ? "field" : "fields"} filled${lowCount ? ` · ${lowCount} to check` : ""}`, canUndo: true });
        return {
          ...prev,
          ...contactFill.next,
          leaseTermCustomMode,
          application,
          marks,
          documents,
          ...(kind === "lease" ? { leaseFile: file, leaseDataUrl: dataUrl, leaseFileName: file.name } : {}),
        };
      });
    },
    [derived.leaseTermPresetValues],
  );

  const readPdf = useCallback(
    async (file: File, kind: "application" | "lease") => {
      const propertyId = form.propertyId || propertyOptions[0]?.id || "";
      if (!propertyId) {
        showToast("Add a property listing before reading a PDF.");
        return;
      }
      setBusy(true);
      setStrip({ kind: "reading", fileName: file.name });
      try {
        const url = await readDataUrlFromFile(file);
        const parsed = await parseResidentDocumentPdfClient({ dataUrl: url, fileName: file.name, kind, propertyId });
        parsesRef.current[kind] = parsed;
        applyParsed(kind, parsed, file, url);
        if (parsed.warnings[0]) showToast(parsed.warnings[0]);
      } catch (err) {
        setStrip(undoRef.current ? { kind: "read", summary: "Earlier fill kept", canUndo: true } : { kind: "blank" });
        showToast(err instanceof Error ? err.message : `Could not read ${file.name}.`);
      } finally {
        setBusy(false);
      }
    },
    [applyParsed, form.propertyId, propertyOptions, showToast],
  );

  const acceptFile = (file: File): boolean => {
    const isPdf = file.type === "application/pdf";
    const isImage = file.type.startsWith("image/");
    if (!isPdf && !isImage) {
      showToast("Choose a PDF or an image.");
      return false;
    }
    if (isPdf && file.size > MAX_PDF_BYTES) {
      showToast("PDF too large (max 3.5 MB).");
      return false;
    }
    return true;
  };

  const onPickStartFile = useCallback(
    (file: File) => {
      if (!acceptFile(file)) return;
      if (file.type !== "application/pdf") {
        patch({ documents: [...form.documents, { id: `${Date.now()}-${file.name}`, file, kind: "id_front" }] });
        showToast(`${file.name} attached — set what it is on Documents.`);
        return;
      }
      const looksLikeLease = /lease|rental agreement|tenancy/i.test(file.name);
      void readPdf(file, looksLikeLease ? "lease" : "application");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.documents, patch, readPdf, showToast],
  );

  const onPickLeasePdf = useCallback(
    (file: File) => {
      if (!acceptFile(file) || file.type !== "application/pdf") {
        if (file.type !== "application/pdf") showToast("Please choose a PDF file.");
        return;
      }
      void readPdf(file, "lease");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readPdf, showToast],
  );

  const onPickDocument = useCallback(
    (file: File) => {
      if (!acceptFile(file)) return;
      const kind = file.type === "application/pdf" ? "other" : "id_front";
      patch({ documents: [...form.documents, { id: `${Date.now()}-${file.name}`, file, kind }] });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form.documents, patch],
  );

  const onUndoFill = useCallback(() => {
    const snapshot = undoRef.current;
    if (!snapshot) return;
    undoRef.current = null;
    parsesRef.current = { application: null, lease: null };
    setForm((prev) => ({ ...snapshot, documents: prev.documents, kind: prev.kind }));
    setStrip({ kind: "blank" });
    showToast("Fill undone — your own entries are kept.");
  }, [showToast]);

  /* ─────────── finish ─────────── */

  const draftMessage = useCallback(
    (row: DemoApplicantRow): { subject: string; body: string } => {
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      if (mode === "application") {
        return {
          subject: `Your application for ${propertyLabel ?? "the property"} is ready to review`,
          body: `Hi ${form.name.trim().split(" ")[0] || "there"} — I started your application for ${propertyLabel ?? "the property"} from what you sent. Open it, check the details, and sign: {link}`,
        };
      }
      if (form.kind === "prospect") {
        const listing = form.propertyId ? getPropertyById(form.propertyId) : null;
        const start = form.tourDate && form.tourStart ? new Date(`${form.tourDate}T${form.tourStart}:00`).toISOString() : new Date().toISOString();
        const end = new Date(Date.parse(start) + Math.max(15, Number(form.tourDurationMinutes) || 30) * 60000).toISOString();
        const ctx = buildTourNotificationContext({
          origin,
          guestName: form.name.trim(),
          guestEmail: form.email.trim(),
          guestPhone: form.phone.trim() || null,
          propertyId: form.propertyId,
          propertyTitle: propertyLabel ?? listing?.title ?? "the property",
          propertyAddress: listing?.address ?? null,
          roomLabel: row.manualResidentDetails?.roomNumber ?? null,
          tourFormat: form.tourFormat === "virtual" ? "virtual" : "in_person",
          tourStartIso: start,
          tourEndIso: end,
          notes: form.tourNotes.trim() || null,
          managerLabel: "Property Manager",
        });
        return { subject: TOUR_CONFIRMED_TENANT_SUBJECT, body: buildTourConfirmedTenantBody(ctx) };
      }
      return {
        subject: EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT,
        body: buildExistingResidentWelcomeEmailBody({ residentName: row.name, axisId: row.id, signupUrl: residentAccountCreationUrl(origin, row.id), propertyLabel: row.property }),
      };
    },
    [form, propertyLabel, mode],
  );

  const buildRow = useCallback(() => {
    const ctx = { userId: managerUserId, propertyLabelFor: (id: string) => propertyOptions.find((p) => p.id === id)?.label };
    const questions = derived.customQuestions.map((q) => ({ key: q.key, label: q.label, type: q.type, section: q.section }));
    if (mode === "application") return buildApplicationDraftRow(form, ctx, questions);
    return form.kind === "prospect" ? buildProspectRow(form, ctx) : buildManualResidentRow(form, ctx, questions);
  }, [form, managerUserId, propertyOptions, derived.customQuestions, mode]);

  const finish = async (row: DemoApplicantRow, skipMessage: boolean, channels?: { viaEmail: boolean; viaSms: boolean }, draft?: { subject: string; body: string; scheduleAt?: string }) => {
    if (busy) return;
    const form = formRef.current;
    setBusy(true);
    try {
      const ctx = { userId: managerUserId, executedLeaseKeys, propertyLabelFor: (id: string) => propertyOptions.find((p) => p.id === id)?.label, assignee };
      const outcome =
        mode === "application" ? await commitApplicationDraft(row, form, ctx) : form.kind === "prospect" ? await commitProspect(row, form, ctx) : await commitResident(row, form, ctx);
      if (outcome.failures.row) {
        showToast(outcome.failures.row);
        setPreview(null);
        if (/bed|room|capacity|property/i.test(outcome.failures.row)) goTo("home");
        return;
      }
      const who = mode === "tour" ? "Tour" : mode === "application" ? "Application" : form.kind === "prospect" ? "Prospect" : "Resident";
      const problems = Object.entries(outcome.failures)
        .filter(([stage]) => stage !== "row")
        .map(([, msg]) => msg);
      if (!skipMessage && row.email && mode === "application") {
        // The email carries the applicant's secure link, so the server composes
        // it; the SMS reuses that text so both channels say the same thing.
        const viaEmail = channels?.viaEmail !== false;
        const viaSms = channels?.viaSms === true;
        if (viaEmail) {
          const sent = await sendApplicationStartedEmail(row.id);
          if (!sent.ok) problems.push(sent.error ?? "The application email could not be sent.");
          else showToast(sent.skipped ? "Application added. Sandbox account — email skipped." : `Application added. Review link emailed to ${row.email}.`);
        }
        if (viaSms) {
          const preview = await sendApplicationStartedEmail(row.id, { preview: true });
          const text = preview.preview?.text?.trim();
          if (!text) problems.push("The text could not be composed.");
          else {
            const sms = await sendClosingMessage({ toEmail: row.email, viaEmail: false, viaSms: true, subject: preview.preview?.subject ?? "", body: text, recipientName: row.name });
            if (!sms.ok) problems.push(sms.message);
          }
        }
        if (!viaEmail && !viaSms) showToast("Application added.");
      } else if (!skipMessage && row.email) {
        const sent = await sendClosingMessage({
          toEmail: row.email,
          viaEmail: channels?.viaEmail !== false,
          viaSms: channels?.viaSms === true,
          subject: draft?.subject?.trim() || form.message.subject || "",
          body: draft?.body?.trim() || form.message.body || "",
          scheduleAt: draft?.scheduleAt,
          recipientName: row.name,
        });
        if (!sent.ok) problems.push(sent.message);
        else showToast(`${who} added. ${sent.message}`);
      } else {
        showToast(`${who} ${mode === "tour" ? "scheduled" : "added"}.${outcome.notes.length ? ` ${outcome.notes.join(" · ")}.` : ""}`);
      }
      if (form.message.channels.includes("link") && form.kind === "resident") {
        try {
          await navigator.clipboard.writeText(residentAccountCreationUrl(window.location.origin, row.id));
          showToast("Their account link is on your clipboard.");
        } catch {
          /* clipboard blocked — the link is on their row */
        }
      }
      if (problems.length) showToast(`${who} added, but: ${problems.join(" · ")}`);
      setPreview(null);
      onAdded(outcome);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onFinish = useCallback(() => {
    if (todo.length) {
      showToast(`${todo.length} ${todo.length === 1 ? "thing" : "things"} to finish first.`);
      goTo("review");
      return;
    }
    const built = buildRow();
    if (!built.ok) {
      showToast(built.error);
      return;
    }
    const quiet = form.message.channels.includes("none") || form.message.channels.length === 0 || (form.message.channels.length === 1 && form.message.channels[0] === "link");
    const draft = draftMessage(built.row);
    const subject = form.message.subject.trim() || draft.subject;
    const body = form.message.body.trim() || draft.body;
    if (quiet) {
      void finish(built.row, true);
      return;
    }
    setPreview({ row: built.row, subject, body });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todo, buildRow, form.message, draftMessage, goTo, showToast]);

  const railHeader = (
    <button
      type="button"
      onClick={() => goTo(form.kind === "prospect" && mode !== "application" ? "contact" : "documents")}
      data-attr="residents-wizard-rail-documents"
      className="mb-3 grid w-full place-items-center rounded-xl border border-dashed border-border bg-white px-3 py-5 text-[12.5px] font-semibold text-muted transition hover:border-primary/50 hover:text-primary [html[data-theme=dark]_&]:bg-card"
    >
      <span className="flex flex-col items-center gap-1.5">
        <FolderOpen className="h-5 w-5" strokeWidth={1.7} aria-hidden />
        {form.documents.length ? `${form.documents.length} ${form.documents.length === 1 ? "document" : "documents"}` : form.kind === "prospect" && mode !== "application" ? "Contact and tour" : "Add documents"}
      </span>
    </button>
  );

  return (
    <>
      {/* The notification preview is a Modal below the workspace overlay's
          z-index, so the workspace steps aside while it is open; the form
          state stays put and comes back if the manager cancels. */}
      {preview ? null : (
      <AddWorkspace
        title={mode === "tour" ? "Schedule tour" : mode === "application" ? "Add application" : form.kind === "prospect" ? "Add prospect" : "Add resident"}
        subtitle={propertyLabel ?? undefined}
        steps={steps}
        current={current}
        onJump={setStepIdx}
        onClose={onClose}
        dirty={addPersonFormIsDirty(form)}
        discardTitle={mode === "tour" ? "Discard this tour?" : mode === "application" ? "Discard this application?" : form.kind === "prospect" ? "Discard this prospect?" : "Discard this resident?"}
        assistantContext={mode === "tour" ? "Schedule tour" : mode === "application" ? "Add application" : form.kind === "prospect" ? "Add prospect" : "Add resident"}
        assistantScopeKey={mode === "tour" ? "schedule-tour-wizard" : mode === "application" ? "add-application-wizard" : "add-resident-wizard"}
        railHeader={railHeader}
        sidePanel={<ResidentSidePanel form={form} derived={derived} propertyLabel={propertyLabel} mode={mode} />}
        lastLabel={mode === "tour" ? "Schedule tour" : mode === "application" ? "Add application" : form.kind === "prospect" ? "Add prospect" : "Add resident"}
        lastDisabled={todo.length > 0}
        finishCount={todo.length}
        busy={busy}
        onFinish={onFinish}
        dataAttrPrefix={mode === "tour" ? "tour-wizard" : mode === "application" ? "application-wizard" : "residents-wizard"}
      >
        {stepId === "contact" ? <ContactStep form={form} patch={patch} strip={strip} onPickFile={onPickStartFile} onUndoFill={onUndoFill} busy={busy} lockKind={mode !== "person"} mode={mode} /> : null}
        {stepId === "home" ? <HomeStep form={form} patch={patch} derived={derived} propertyOptions={propertyOptions} /> : null}
        {stepId === "application" ? <ApplicationStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} /> : null}
        {stepId === "lease" ? <LeaseStep form={form} patch={patch} derived={derived} onPickLeasePdf={onPickLeasePdf} busy={busy} /> : null}
        {stepId === "payments" ? <PaymentsStep form={form} patch={patch} derived={derived} /> : null}
        {stepId === "documents" ? <DocumentsStep form={form} patch={patch} onPickFile={onPickDocument} busy={busy} /> : null}
        {stepId === "tour" && managerUserId ? <TourStep form={form} patch={patch} derived={derived} managerUserId={managerUserId} assignee={assignee} onAssignee={setAssignee} /> : null}
        {stepId === "review" ? <ReviewStep form={form} patch={patch} derived={derived} propertyLabel={propertyLabel} goTo={goTo} mode={mode} /> : null}
      </AddWorkspace>
      )}
      {preview ? (
        <PortalNotificationPreviewModal
          open
          title={mode === "application" ? "Add application — review & sign email" : form.kind === "prospect" ? "Tour confirmation" : "Add resident — notification preview"}
          onClose={() => !busy && setPreview(null)}
          recipient={preview.row.email ?? ""}
          recipientPhone={preview.row.manualResidentDetails?.phone?.trim() || ""}
          subject={preview.subject}
          body={preview.body}
          showChannelPicker
          emailAvailable={Boolean(preview.row.email?.includes("@"))}
          smsAvailable={Boolean(preview.row.manualResidentDetails?.phone?.trim())}
          defaultViaEmail={form.message.channels.includes("email")}
          defaultViaSms={form.message.channels.includes("sms")}
          confirmLabel={mode === "tour" ? "Schedule & send" : mode === "application" ? "Add & send the link" : form.kind === "prospect" ? "Add prospect & send" : "Add resident & send notice"}
          confirmLabelWithoutMessage={mode === "tour" ? "Schedule only" : mode === "application" ? "Add application only" : form.kind === "prospect" ? "Add prospect only" : "Add resident only"}
          editableBody={mode !== "application"}
          editableSubject={mode !== "application"}
          confirmBusy={busy}
          showSkipMessage
          onConfirm={(skipMessage, channels, draft) => void finish(preview.row, skipMessage, channels, draft)}
        />
      ) : null}
    </>
  );
}
