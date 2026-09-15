"use client";

/**
 * Portfolio import — the five-step manager wizard.
 *
 * Upload → Match columns → Review → Import → Invite residents. Every step
 * reads and writes the same `PortfolioImportDraft` through
 * `src/lib/portfolio-import.client.ts`; this file owns layout and step
 * transitions only — parsing, mapping, and commit all happen server-side.
 * See `src/lib/portfolio-import/types.ts` for the draft contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  FileSpreadsheet,
  FileText,
  Table as TableIcon,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  commitPortfolioImport,
  createPortfolioImport,
  getPortfolioImport,
  invitePortfolioImportResidents,
  patchPortfolioImport,
  pollPortfolioImportCommit,
  buildPortfolioImportSampleCsv,
  type PortfolioImportMessagingStatus,
} from "@/lib/portfolio-import.client";
import {
  parseResidentDocumentPdfClient,
  readDataUrlFromFile,
} from "@/lib/resident-document-import.client";
import { downloadOrShareFile } from "@/lib/native/download-or-share";
import {
  PORTFOLIO_IMPORT_CANONICAL_KEYS,
  PORTFOLIO_IMPORT_MAX_BYTES,
  type PortfolioImportBalance,
  type PortfolioImportCanonicalKey,
  type PortfolioImportColumnMapping,
  type PortfolioImportDraft,
  type PortfolioImportInviteResult,
  type PortfolioImportIssue,
  type PortfolioImportProperty,
  type PortfolioImportResident,
  type PortfolioImportSourcePreset,
  type PortfolioImportStageProgress,
  type PortfolioImportSummary,
  type PortfolioImportUnit,
} from "@/lib/portfolio-import/types";

const STEP_LABELS = ["Upload", "Match columns", "Review", "Import", "Invite residents"] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4;

const CANONICAL_KEY_LABELS: Record<PortfolioImportCanonicalKey, string> = {
  propertyName: "Property name",
  address: "Address",
  city: "City",
  state: "State",
  zip: "ZIP",
  unitLabel: "Unit",
  beds: "Beds",
  baths: "Baths",
  sqft: "Sq ft",
  residentName: "Resident name",
  residentEmail: "Resident email",
  residentPhone: "Resident phone",
  monthlyRent: "Monthly rent",
  securityDeposit: "Security deposit",
  leaseStart: "Lease start",
  leaseEnd: "Lease end",
  moveIn: "Move-in",
  moveOut: "Move-out",
  occupancyStatus: "Occupancy status",
  balance: "Balance",
  notes: "Notes",
};

const SOURCE_CARDS: Array<{
  key: PortfolioImportSourcePreset;
  title: string;
  subtitle: string;
  icon: typeof FileSpreadsheet;
}> = [
  { key: "appfolio", title: "AppFolio", subtitle: "Rent Roll → Export .xlsx", icon: FileSpreadsheet },
  { key: "buildium", title: "Buildium", subtitle: "Rent roll report → Export", icon: FileSpreadsheet },
  { key: "generic", title: "Spreadsheet", subtitle: ".csv or .xlsx, any columns", icon: TableIcon },
  { key: "pdf", title: "PDF rent roll", subtitle: "We read it; you confirm every row", icon: FileText },
];

const MATCH_CONFIDENCE_LABEL: Record<PortfolioImportColumnMapping["confidence"], string> = {
  exact: "exact",
  synonym: "synonym",
  ai: "AI",
  manual: "manual",
  unmapped: "unmapped",
};

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

type UploadErrorState = { status: number; message: string; code?: string; importId?: string };

function uploadErrorTitle(err: UploadErrorState): string {
  if (err.status === 409) return "This file was already imported";
  if (err.status === 413) return "That file is too large";
  if (err.code === "row_limit") return "That file has too many rows";
  if (err.code === "no_rows") return "We didn't find any rows";
  if (err.code === "unreadable") return "We couldn't read that file";
  return "Something went wrong";
}

/** Which welcome channels a resident can receive, folding in whether this account can text at all. */
function residentChannels(
  resident: PortfolioImportResident,
  canText: boolean,
): { email: boolean; text: boolean; noPhone: boolean; noEmail: boolean; needsNumber: boolean } {
  return {
    email: resident.inviteChannels.email,
    text: resident.inviteChannels.text && canText,
    noPhone: !resident.inviteChannels.text,
    noEmail: !resident.inviteChannels.email,
    needsNumber: resident.inviteChannels.text && !canText,
  };
}

function isResidentExcluded(
  resident: PortfolioImportResident,
  draft: PortfolioImportDraft,
): boolean {
  if (resident.excluded) return true;
  const unit = draft.units.find((u) => u.key === resident.unitKey);
  if (unit?.excluded) return true;
  const property = draft.properties.find((p) => p.key === resident.propertyKey);
  return Boolean(property?.excluded);
}

export function PortfolioImportWizard({ resumeImportId }: { resumeImportId?: string }) {
  const router = useRouter();
  const [step, setStep] = useState<StepIndex>(0);
  const [importId, setImportId] = useState<string | null>(resumeImportId ?? null);
  const [presetHint, setPresetHint] = useState<PortfolioImportSourcePreset | undefined>(undefined);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsing, setParsing] = useState(Boolean(resumeImportId));
  const [uploadError, setUploadError] = useState<UploadErrorState | null>(null);

  const [summary, setSummary] = useState<PortfolioImportSummary | null>(null);
  const [draft, setDraft] = useState<PortfolioImportDraft | null>(null);
  const [messaging, setMessaging] = useState<PortfolioImportMessagingStatus | null>(null);
  const [columns, setColumns] = useState<PortfolioImportColumnMapping[]>([]);
  const [savingColumns, setSavingColumns] = useState(false);

  const [reviewTab, setReviewTab] = useState<"properties" | "units" | "residents" | "issues" | "tasks">("issues");
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [emailDraftByResident, setEmailDraftByResident] = useState<Record<string, string>>({});

  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<
    { status: string; propertyIds: string[]; residentApplicationIds: string[]; failures: Array<{ recordKind: string; sourceKey: string; message: string }> } | null
  >(null);
  const [progress, setProgress] = useState<PortfolioImportStageProgress[]>([]);

  const [inviteSelected, setInviteSelected] = useState<Set<string>>(new Set());
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteResults, setInviteResults] = useState<PortfolioImportInviteResult[] | null>(null);

  const commitStartedRef = useRef(false);
  const leaseInputRef = useRef<HTMLInputElement>(null);
  const attachTargetRef = useRef<string | null>(null);

  const close = useCallback(() => {
    router.push("/portal/properties");
  }, [router]);

  // ---- Resume an existing draft (?importId=) ----------------------------
  useEffect(() => {
    if (!resumeImportId) return;
    let cancelled = false;
    void (async () => {
      const res = await getPortfolioImport(resumeImportId);
      if (cancelled) return;
      setParsing(false);
      if (!res.ok) {
        setUploadError({ status: res.status, message: res.error, code: res.code });
        return;
      }
      setImportId(res.importId);
      setSummary(res.summary);
      setDraft(res.draft);
      setColumns(res.draft.columns);
      setMessaging(res.messaging ?? null);
      setFileName(res.draft.fileName);
      if (res.status === "committing") {
        setStep(3);
      } else if (res.status === "completed") {
        setStep(4);
      } else {
        setStep(1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumeImportId]);

  // ---- Step 1: Upload -----------------------------------------------------

  async function handleFile(file: File) {
    setUploadError(null);
    if (file.size > PORTFOLIO_IMPORT_MAX_BYTES) {
      setUploadError({ status: 413, message: "That file is too large. The limit is 5 MB." });
      return;
    }
    setFileName(file.name);
    setParsing(true);
    const res = await createPortfolioImport(file, presetHint);
    setParsing(false);
    if (!res.ok) {
      setUploadError({ status: res.status, message: res.error, code: res.code, importId: res.importId });
      return;
    }
    setImportId(res.importId);
    setSummary(res.summary);
    setDraft(res.draft);
    setColumns(res.draft.columns);
    setStep(1);
  }

  async function openExisting(id: string | undefined) {
    if (!id) return;
    setParsing(true);
    const res = await getPortfolioImport(id);
    setParsing(false);
    if (!res.ok) {
      setUploadError({ status: res.status, message: res.error, code: res.code });
      return;
    }
    setUploadError(null);
    setImportId(res.importId);
    setSummary(res.summary);
    setDraft(res.draft);
    setColumns(res.draft.columns);
    setMessaging(res.messaging ?? null);
    setFileName(res.draft.fileName);
    setStep(res.status === "committing" ? 3 : res.status === "completed" ? 4 : 1);
  }

  async function downloadSample() {
    await downloadOrShareFile({
      fileName: "proplane-portfolio-import-template.csv",
      mimeType: "text/csv",
      content: buildPortfolioImportSampleCsv(),
      title: "PropLane portfolio import template",
    });
  }

  // ---- Step 2: Match columns ---------------------------------------------

  const matchedCount = columns.filter((c) => c.confidence !== "unmapped").length;

  function setColumnKey(index: number, key: PortfolioImportCanonicalKey | null) {
    setColumns((prev) =>
      prev.map((c) =>
        c.index === index
          ? { ...c, key, confidence: key === c.key ? c.confidence : key ? "manual" : "unmapped" }
          : c,
      ),
    );
  }

  async function continueFromMatchColumns() {
    if (!importId) return;
    setSavingColumns(true);
    const changed = draft ? columns.some((c, i) => c.key !== draft.columns[i]?.key) : true;
    const res = changed
      ? await patchPortfolioImport(importId, { columns: columns.map((c) => ({ index: c.index, key: c.key })) })
      : null;
    setSavingColumns(false);
    if (res && !res.ok) {
      setUploadError({ status: res.status, message: res.error });
      return;
    }
    if (res) {
      setDraft(res.draft);
      setSummary(res.summary);
      setColumns(res.draft.columns);
    }
    const activeSummary = res ? res.summary : summary;
    setReviewTab(activeSummary && activeSummary.blockingIssueCount > 0 ? "issues" : "properties");
    setStep(2);
  }

  // ---- Step 3: Review ------------------------------------------------------

  async function applyPatch(patch: Parameters<typeof patchPortfolioImport>[1], rowKey: string) {
    if (!importId) return;
    setRowBusy(rowKey);
    const res = await patchPortfolioImport(importId, patch);
    setRowBusy(null);
    if (!res.ok) return;
    setDraft(res.draft);
    setSummary(res.summary);
  }

  function excludeIssueRow(issue: PortfolioImportIssue) {
    if (issue.residentKey) return applyPatch({ residents: [{ key: issue.residentKey, excluded: true }] }, issue.id);
    if (issue.unitKey) return applyPatch({ units: [{ key: issue.unitKey, excluded: true }] }, issue.id);
    if (issue.propertyKey) return applyPatch({ properties: [{ key: issue.propertyKey, excluded: true }] }, issue.id);
  }

  function saveResidentEmail(issue: PortfolioImportIssue) {
    const email = emailDraftByResident[issue.id]?.trim();
    if (!issue.residentKey || !email) return;
    return applyPatch({ residents: [{ key: issue.residentKey, email }] }, issue.id);
  }

  function resolveIssue(issue: PortfolioImportIssue) {
    return applyPatch({ issues: [{ id: issue.id, resolved: true }] }, issue.id);
  }

  function toggleBalanceCreate(balance: PortfolioImportBalance) {
    return applyPatch({ balances: [{ key: balance.key, create: !balance.create }] }, balance.key);
  }

  async function saveAndFinishLater() {
    close();
  }

  async function startImport() {
    if (!importId || !summary) return;
    setStep(3);
    setImportError(null);
    setImportBusy(true);
    commitStartedRef.current = true;
    const res = await commitPortfolioImport(importId);
    setImportBusy(false);
    if (!res.ok) {
      if (res.status === 409) {
        setImportError("Some rows still need attention before this can be imported.");
        setStep(2);
        setReviewTab("issues");
      } else {
        setImportError(res.error);
      }
      return;
    }
    setCommitResult(res.result);
    setSummary(res.summary);
    setProgress(res.result.progress);
  }

  // ---- Step 4: Import progress polling -------------------------------------

  useEffect(() => {
    if (step !== 3 || !importId) return;
    if (commitResult && commitResult.status !== "committing") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const res = await pollPortfolioImportCommit(importId);
      if (cancelled) return;
      if (res.ok) {
        setProgress(res.progress);
        if (res.status !== "committing") {
          const refreshed = await getPortfolioImport(importId);
          if (cancelled) return;
          if (refreshed.ok) {
            setDraft(refreshed.draft);
            setSummary(refreshed.summary);
            setMessaging(refreshed.messaging ?? null);
            if (refreshed.result) {
              setCommitResult({
                status: refreshed.result.status,
                propertyIds: refreshed.result.propertyIds,
                residentApplicationIds: refreshed.result.residentApplicationIds,
                failures: refreshed.result.failures,
              });
            }
          }
          return;
        }
      }
      timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, importId, commitResult]);

  async function retryCommit() {
    setImportError(null);
    setCommitResult(null);
    await startImport();
  }

  function goInvite() {
    setInviteSelected(
      new Set(
        (draft?.residents ?? [])
          .filter((r) => !isResidentExcluded(r, draft!) && (r.inviteChannels.email || r.inviteChannels.text))
          .map((r) => r.key),
      ),
    );
    setStep(4);
  }

  // ---- Step 5: Invite residents --------------------------------------------

  const invitableResidents = useMemo(
    () => (draft ? draft.residents.filter((r) => !isResidentExcluded(r, draft)) : []),
    [draft],
  );

  function toggleInvite(key: string) {
    setInviteSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function sendInvites() {
    if (!importId) return;
    setInviteBusy(true);
    const res = await invitePortfolioImportResidents(
      importId,
      Array.from(inviteSelected),
      messaging?.canText ? "both" : "email",
    );
    setInviteBusy(false);
    if (!res.ok) return;
    setInviteResults(res.results);
  }

  async function refreshMessaging() {
    if (!importId) return;
    const res = await getPortfolioImport(importId);
    if (res.ok) setMessaging(res.messaging ?? null);
  }

  async function attachLeasePdf(file: File) {
    const residentKey = attachTargetRef.current;
    if (!residentKey || !importId || !draft) return;
    const resident = draft.residents.find((r) => r.key === residentKey);
    if (!resident) return;
    setRowBusy(residentKey);
    try {
      const dataUrl = await readDataUrlFromFile(file);
      const parsed = await parseResidentDocumentPdfClient({
        dataUrl,
        fileName: file.name,
        kind: "lease",
        propertyId: resident.propertyKey,
      });
      const fullyExecuted =
        parsed.suggestedLeaseBucket === "signed" || parsed.leaseSignatures?.fullyExecuted === true;
      await applyPatch(
        { residents: [{ key: residentKey, leasePdf: { fileName: file.name, dataUrl, fullyExecuted } }] },
        residentKey,
      );
    } catch {
      /* the row keeps its previous state; the manager can retry the attach */
    } finally {
      setRowBusy(null);
      attachTargetRef.current = null;
    }
  }

  // ---------------------------------------------------------------------

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6" data-attr="portfolio-import-wizard">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">Import your portfolio</h1>
          <p className="mt-0.5 text-sm text-muted">
            Properties, units and residents come in together, in the right order.
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          data-attr="portfolio-import-close"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-foreground/5 hover:text-foreground"
        >
          <X className="h-5 w-5" aria-hidden />
        </button>
      </div>

      <Stepper step={step} />

      {step === 0 ? (
        <UploadStep
          presetHint={presetHint}
          onPresetHint={setPresetHint}
          fileName={fileName}
          parsing={parsing}
          summary={summary}
          uploadError={uploadError}
          onFile={handleFile}
          onOpenExisting={openExisting}
          onDownloadSample={() => void downloadSample()}
        />
      ) : null}

      {step === 1 && draft ? (
        <MatchColumnsStep
          columns={columns}
          matchedCount={matchedCount}
          totalCount={columns.length}
          saving={savingColumns}
          onSetKey={setColumnKey}
          onBack={() => setStep(0)}
          onContinue={() => void continueFromMatchColumns()}
        />
      ) : null}

      {step === 2 && draft && summary ? (
        <ReviewStep
          draft={draft}
          summary={summary}
          tab={reviewTab}
          onTab={setReviewTab}
          rowBusy={rowBusy}
          emailDraftByResident={emailDraftByResident}
          onEmailDraftChange={(issueId, value) => setEmailDraftByResident((prev) => ({ ...prev, [issueId]: value }))}
          onSaveEmail={saveResidentEmail}
          onExcludeIssueRow={excludeIssueRow}
          onResolveIssue={resolveIssue}
          onToggleBalance={toggleBalanceCreate}
          onEditProperty={(key, edits) => applyPatch({ properties: [{ key, ...edits }] }, key)}
          onEditUnit={(key, edits) => applyPatch({ units: [{ key, ...edits }] }, key)}
          onEditResident={(key, edits) => applyPatch({ residents: [{ key, ...edits }] }, key)}
          onExcludeResident={(key) => applyPatch({ residents: [{ key, excluded: true }] }, key)}
          onAttachLease={(residentKey) => {
            attachTargetRef.current = residentKey;
            leaseInputRef.current?.click();
          }}
          onBack={() => setStep(1)}
          onSaveLater={() => void saveAndFinishLater()}
          onImport={() => void startImport()}
        />
      ) : null}

      {step === 3 ? (
        <ImportStep
          summary={summary}
          progress={progress}
          busy={importBusy}
          error={importError}
          commitResult={commitResult}
          onViewProperties={close}
          onInviteResidents={goInvite}
          onRetry={() => void retryCommit()}
        />
      ) : null}

      {step === 4 && draft ? (
        <InviteStep
          residents={invitableResidents}
          selected={inviteSelected}
          onToggle={toggleInvite}
          messaging={messaging}
          busy={inviteBusy}
          results={inviteResults}
          onRefreshMessaging={() => void refreshMessaging()}
          onSend={() => void sendInvites()}
          onDone={close}
        />
      ) : null}

      <input
        ref={leaseInputRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void attachLeasePdf(file);
          if (leaseInputRef.current) leaseInputRef.current.value = "";
        }}
      />
    </div>
  );
}

// ===========================================================================
// Stepper
// ===========================================================================

function Stepper({ step }: { step: StepIndex }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-attr="portfolio-import-stepper" role="list">
      {STEP_LABELS.map((label, i) => (
        <span key={label} className="flex items-center gap-1.5">
          <span
            role="listitem"
            aria-current={i === step ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-semibold",
              i === step
                ? "bg-primary text-white"
                : i < step
                  ? "bg-accent text-primary"
                  : "bg-[var(--secondary)] text-muted",
            )}
          >
            <span aria-hidden>{i + 1}</span>
            {label}
          </span>
          {i < STEP_LABELS.length - 1 ? <span className="text-muted" aria-hidden>·</span> : null}
        </span>
      ))}
    </div>
  );
}

// ===========================================================================
// Step 1 — Upload
// ===========================================================================

function UploadStep({
  presetHint,
  onPresetHint,
  fileName,
  parsing,
  summary,
  uploadError,
  onFile,
  onOpenExisting,
  onDownloadSample,
}: {
  presetHint: PortfolioImportSourcePreset | undefined;
  onPresetHint: (v: PortfolioImportSourcePreset) => void;
  fileName: string | null;
  parsing: boolean;
  summary: PortfolioImportSummary | null;
  uploadError: UploadErrorState | null;
  onFile: (file: File) => void;
  onOpenExisting: (importId: string | undefined) => void;
  onDownloadSample: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SOURCE_CARDS.map((card) => {
          const Icon = card.icon;
          const active = presetHint === card.key;
          return (
            <button
              key={card.key}
              type="button"
              onClick={() => onPresetHint(card.key)}
              data-attr={`portfolio-import-source-${card.key}`}
              className={cn(
                "flex flex-col items-start gap-1.5 rounded-2xl border-2 px-3.5 py-3 text-left transition",
                active ? "border-primary/50 bg-primary/[0.05]" : "border-border bg-card hover:border-primary/30",
              )}
            >
              <Icon className="h-5 w-5 text-primary" aria-hidden />
              <span className="text-sm font-semibold text-foreground">{card.title}</span>
              <span className="text-xs text-muted">{card.subtitle}</span>
            </button>
          );
        })}
      </div>

      <div
        className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-accent/10 px-5 py-8 text-center"
        data-attr="portfolio-import-dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
      >
        <UploadIcon className="h-7 w-7 text-primary" aria-hidden />
        <p className="text-sm font-semibold text-foreground">Drop your export here</p>
        <p className="text-xs text-muted">.csv, .xlsx or .pdf · up to 5 MB · up to 2,000 rows</p>
        <Button
          type="button"
          variant="outline"
          className="mt-1"
          onClick={() => inputRef.current?.click()}
          data-attr="portfolio-import-choose-file"
        >
          Choose file
        </Button>
        <button
          type="button"
          onClick={onDownloadSample}
          data-attr="portfolio-import-download-sample"
          className="text-xs font-semibold text-primary hover:underline"
        >
          Download sample template
        </button>
        {fileName && !uploadError ? (
          <p className="mt-2 text-sm font-medium text-foreground" data-attr="portfolio-import-file-picked">
            {parsing
              ? `Reading ${fileName}…`
              : summary
                ? `${fileName} · ${summary.propertyCount} propert${summary.propertyCount === 1 ? "y" : "ies"}, ${summary.residentCount} residents · ${summary.preset}`
                : fileName}
          </p>
        ) : null}
        {parsing ? (
          <div className="mt-2 w-full max-w-sm space-y-1.5" role="status" aria-label="Reading file">
            <div className="h-3 w-2/3 animate-pulse rounded bg-accent/60 motion-reduce:animate-none" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-accent/60 motion-reduce:animate-none" />
          </div>
        ) : null}
      </div>

      {uploadError ? (
        <div
          role="alert"
          data-attr="portfolio-import-upload-error"
          className="rounded-2xl border border-border bg-card p-5 text-center"
        >
          <p className="text-sm font-semibold text-foreground">{uploadErrorTitle(uploadError)}</p>
          <p className="mt-1 text-sm text-muted">{uploadError.message}</p>
          {uploadError.status === 409 && uploadError.importId ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              data-attr="portfolio-import-open-existing"
              onClick={() => onOpenExisting(uploadError.importId)}
            >
              Open that import
            </Button>
          ) : null}
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        aria-hidden
        data-attr="portfolio-import-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
    </div>
  );
}

// ===========================================================================
// Step 2 — Match columns
// ===========================================================================

function MatchColumnsStep({
  columns,
  matchedCount,
  totalCount,
  saving,
  onSetKey,
  onBack,
  onContinue,
}: {
  columns: PortfolioImportColumnMapping[];
  matchedCount: number;
  totalCount: number;
  saving: boolean;
  onSetKey: (index: number, key: PortfolioImportCanonicalKey | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        We matched {matchedCount} of {totalCount} columns.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[560px] table-fixed">
          <thead>
            <tr className="border-b border-border bg-[var(--secondary)]/50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
              <th className="px-4 py-2.5">Your column</th>
              <th className="px-4 py-2.5">Sample</th>
              <th className="px-4 py-2.5">Becomes</th>
              <th className="px-4 py-2.5">Match</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((col) => (
              <tr key={col.index} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5 text-sm font-medium text-foreground">{col.header}</td>
                <td className="px-4 py-2.5 text-xs text-muted">{col.samples.join(", ") || "—"}</td>
                <td className="px-4 py-2.5">
                  <Select
                    aria-label={`Column "${col.header}" becomes`}
                    value={col.key ?? ""}
                    onChange={(e) => onSetKey(col.index, (e.target.value || null) as PortfolioImportCanonicalKey | null)}
                    data-attr={`portfolio-import-column-${col.index}`}
                  >
                    <option value="">Keep as note</option>
                    {PORTFOLIO_IMPORT_CANONICAL_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {CANONICAL_KEY_LABELS[key]}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-4 py-2.5">
                  <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[11px] font-semibold text-muted">
                    {MATCH_CONFIDENCE_LABEL[col.confidence]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onBack} data-attr="portfolio-import-match-back">
          Back
        </Button>
        <Button type="button" loading={saving} onClick={onContinue} data-attr="portfolio-import-match-continue">
          Continue
        </Button>
      </div>
    </div>
  );
}

// ===========================================================================
// Step 3 — Review
// ===========================================================================

const ISSUE_SEVERITY_LABEL: Record<string, string> = {
  block: "Fix to import",
  review: "Review",
  info: "Review",
};

function issuePillLabel(issue: PortfolioImportIssue): string {
  if (issue.resolved) return "Ignored";
  return ISSUE_SEVERITY_LABEL[issue.severity] ?? "Review";
}

function ReviewStep({
  draft,
  summary,
  tab,
  onTab,
  rowBusy,
  emailDraftByResident,
  onEmailDraftChange,
  onSaveEmail,
  onExcludeIssueRow,
  onResolveIssue,
  onToggleBalance,
  onEditProperty,
  onEditUnit,
  onEditResident,
  onExcludeResident,
  onAttachLease,
  onBack,
  onSaveLater,
  onImport,
}: {
  draft: PortfolioImportDraft;
  summary: PortfolioImportSummary;
  tab: "properties" | "units" | "residents" | "issues" | "tasks";
  onTab: (tab: "properties" | "units" | "residents" | "issues" | "tasks") => void;
  rowBusy: string | null;
  emailDraftByResident: Record<string, string>;
  onEmailDraftChange: (issueId: string, value: string) => void;
  onSaveEmail: (issue: PortfolioImportIssue) => void;
  onExcludeIssueRow: (issue: PortfolioImportIssue) => void;
  onResolveIssue: (issue: PortfolioImportIssue) => void;
  onToggleBalance: (balance: PortfolioImportBalance) => void;
  onEditProperty: (key: string, edits: Record<string, unknown>) => void;
  onEditUnit: (key: string, edits: Record<string, unknown>) => void;
  onEditResident: (key: string, edits: Record<string, unknown>) => void;
  onExcludeResident: (key: string) => void;
  onAttachLease: (residentKey: string) => void;
  onBack: () => void;
  onSaveLater: () => void;
  onImport: () => void;
}) {
  const tabs: Array<{ id: typeof tab; label: string; count: number }> = [
    { id: "properties", label: "Properties", count: summary.propertyCount },
    { id: "units", label: "Units", count: summary.unitCount },
    { id: "residents", label: "Residents", count: summary.residentCount },
    { id: "issues", label: "Issues", count: summary.blockingIssueCount + summary.reviewIssueCount },
    { id: "tasks", label: "Tasks", count: summary.taskCount },
  ];
  const unitsByKey = new Map(draft.units.map((u) => [u.key, u]));
  const propertiesByKey = new Map(draft.properties.map((p) => [p.key, p]));
  const balancesByResident = new Map(draft.balances.map((b) => [b.residentKey, b]));
  const disabled = summary.blockingIssueCount > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        <SummaryBox label="Properties" value={summary.propertyCount} />
        <SummaryBox label="Units" value={summary.unitCount} />
        <SummaryBox label="Residents" value={summary.residentCount} />
        <SummaryBox label="Opening balances" value={summary.balanceCount} />
        <SummaryBox label="Tasks to create" value={summary.taskCount} />
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" data-attr="portfolio-import-review-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTab(t.id)}
            data-attr={`portfolio-import-review-tab-${t.id}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold transition",
              tab === t.id ? "bg-primary text-white" : "bg-[var(--secondary)] text-muted hover:text-foreground",
            )}
          >
            {t.label}
            <span className={cn("rounded-full px-1.5 text-[11px]", tab === t.id ? "bg-white/25" : "bg-card")}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {tab === "issues" ? (
        <div className="space-y-2" data-attr="portfolio-import-issues-list">
          {draft.issues.filter((i) => i.severity !== "info").length === 0 ? (
            <p className="rounded-2xl border border-border bg-card p-5 text-center text-sm text-muted">
              No issues to review.
            </p>
          ) : (
            draft.issues
              .filter((i) => i.severity !== "info")
              .map((issue) => {
                const balance = issue.residentKey ? balancesByResident.get(issue.residentKey) : undefined;
                return (
                  <div
                    key={issue.id}
                    data-attr={`portfolio-import-issue-${issue.code}`}
                    className="rounded-2xl border border-border bg-card p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{issue.message}</p>
                        {issue.detail ? <p className="mt-0.5 text-xs text-muted">{issue.detail}</p> : null}
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
                          issue.resolved
                            ? "bg-[var(--secondary)] text-muted"
                            : issue.severity === "block"
                              ? "portal-badge-danger"
                              : "portal-badge-warning",
                        )}
                      >
                        {issuePillLabel(issue)}
                      </span>
                    </div>
                    {!issue.resolved && issue.code === "missing_email" && issue.residentKey ? (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <input
                          type="email"
                          placeholder="name@example.com"
                          value={emailDraftByResident[issue.id] ?? ""}
                          onChange={(e) => onEmailDraftChange(issue.id, e.target.value)}
                          data-attr="portfolio-import-issue-email-input"
                          className="min-h-9 w-56 max-w-full rounded-xl border border-border bg-auth-input-bg px-3 text-sm"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          loading={rowBusy === issue.id}
                          onClick={() => onSaveEmail(issue)}
                          data-attr="portfolio-import-issue-add-email"
                        >
                          Add email
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          loading={rowBusy === issue.id}
                          onClick={() => onExcludeIssueRow(issue)}
                          data-attr="portfolio-import-issue-exclude"
                        >
                          Exclude row
                        </Button>
                      </div>
                    ) : null}
                    {!issue.resolved && issue.code === "past_due_balance" && balance ? (
                      <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                        <input
                          type="checkbox"
                          checked={balance.create}
                          onChange={() => onToggleBalance(balance)}
                          data-attr="portfolio-import-issue-create-charge"
                        />
                        Create charge
                      </label>
                    ) : null}
                    {!issue.resolved && issue.code === "shared_unit" ? (
                      <div className="mt-3">
                        <Button
                          type="button"
                          variant="outline"
                          loading={rowBusy === issue.id}
                          onClick={() => onResolveIssue(issue)}
                          data-attr="portfolio-import-issue-looks-right"
                        >
                          Looks right
                        </Button>
                      </div>
                    ) : null}
                    {!issue.resolved && issue.code !== "missing_email" && issue.code !== "past_due_balance" && issue.code !== "shared_unit" ? (
                      <div className="mt-3">
                        <Button
                          type="button"
                          variant="ghost"
                          loading={rowBusy === issue.id}
                          onClick={() => onExcludeIssueRow(issue)}
                          data-attr="portfolio-import-issue-exclude"
                        >
                          Exclude row
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })
          )}
        </div>
      ) : null}

      {tab === "properties" ? (
        <PropertiesTable
          rows={draft.properties}
          onEdit={onEditProperty}
        />
      ) : null}

      {tab === "units" ? (
        <UnitsTable rows={draft.units} properties={propertiesByKey} onEdit={onEditUnit} />
      ) : null}

      {tab === "residents" ? (
        <ResidentsTable
          rows={draft.residents}
          units={unitsByKey}
          properties={propertiesByKey}
          rowBusy={rowBusy}
          onEdit={onEditResident}
          onExclude={onExcludeResident}
          onAttachLease={onAttachLease}
        />
      ) : null}

      {tab === "tasks" ? <TasksTable rows={draft.tasks} /> : null}

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background/95 py-3 backdrop-blur-sm">
        <Button type="button" variant="outline" onClick={onBack} data-attr="portfolio-import-review-back">
          Back
        </Button>
        <Button type="button" variant="ghost" onClick={onSaveLater} data-attr="portfolio-import-save-later">
          Save and finish later
        </Button>
        <span title={disabled ? "Fix the issues marked “Fix to import” first." : undefined}>
          <Button
            type="button"
            disabled={disabled}
            onClick={onImport}
            data-attr="portfolio-import-commit"
          >
            {`Import ${summary.propertyCount} propert${summary.propertyCount === 1 ? "y" : "ies"}, ${plural(summary.residentCount, "resident")}`}
          </Button>
        </span>
      </div>
    </div>
  );
}

function SummaryBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-card px-3 py-2.5 text-center">
      <p className="text-lg font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[11px] font-medium text-muted">{label}</p>
    </div>
  );
}

function PropertiesTable({
  rows,
  onEdit,
}: {
  rows: PortfolioImportProperty[];
  onEdit: (key: string, edits: Record<string, unknown>) => void;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  return (
    <div className="space-y-2" data-attr="portfolio-import-properties-table">
      {rows.map((row) => (
        <div key={row.key} className="rounded-2xl border border-border bg-card p-3.5">
          {editingKey === row.key ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                defaultValue={row.name}
                onBlur={(e) => onEdit(row.key, { name: e.target.value })}
                className="min-h-9 flex-1 rounded-xl border border-border bg-auth-input-bg px-2.5 text-sm"
                data-attr="portfolio-import-property-name-input"
              />
              <input
                defaultValue={row.address}
                onBlur={(e) => onEdit(row.key, { address: e.target.value })}
                className="min-h-9 flex-[2] rounded-xl border border-border bg-auth-input-bg px-2.5 text-sm"
                data-attr="portfolio-import-property-address-input"
              />
              <input
                defaultValue={row.zip ?? ""}
                onBlur={(e) => onEdit(row.key, { zip: e.target.value })}
                className="min-h-9 w-24 rounded-xl border border-border bg-auth-input-bg px-2.5 text-sm"
                data-attr="portfolio-import-property-zip-input"
              />
              <Button type="button" variant="outline" onClick={() => setEditingKey(null)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{row.name}</p>
                <p className="truncate text-xs text-muted">
                  {row.address || "No address"} · {plural(row.unitKeys.length, row.inventoryKind)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!row.address ? (
                  <span className="rounded-full bg-[var(--secondary)] px-2 py-0.5 text-[11px] font-semibold text-muted">
                    Unlisted
                  </span>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setEditingKey(row.key)}
                  data-attr="portfolio-import-property-edit"
                >
                  Edit
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function UnitsTable({
  rows,
  properties,
  onEdit,
}: {
  rows: PortfolioImportUnit[];
  properties: Map<string, PortfolioImportProperty>;
  onEdit: (key: string, edits: Record<string, unknown>) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border" data-attr="portfolio-import-units-table">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="border-b border-border bg-[var(--secondary)]/50 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
            <th className="px-4 py-2.5">Property</th>
            <th className="px-4 py-2.5">Unit</th>
            <th className="px-4 py-2.5">Rent</th>
            <th className="px-4 py-2.5">Sq ft</th>
            <th className="px-4 py-2.5">Status</th>
            <th className="px-4 py-2.5">Edit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 text-sm text-foreground">{properties.get(row.propertyKey)?.name ?? "—"}</td>
              <td className="px-4 py-2.5 text-sm font-medium text-foreground">{row.label}</td>
              <td className="px-4 py-2.5 text-sm text-foreground">{money(row.monthlyRent)}</td>
              <td className="px-4 py-2.5 text-sm text-muted">{row.sqft ?? "—"}</td>
              <td className="px-4 py-2.5 text-sm capitalize text-muted">{row.occupancy}</td>
              <td className="px-4 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  data-attr="portfolio-import-unit-edit"
                  onClick={() => {
                    const next = window.prompt("Monthly rent", String(row.monthlyRent ?? ""));
                    if (next == null) return;
                    const amount = Number(next.replace(/[^\d.]/g, ""));
                    if (Number.isFinite(amount)) onEdit(row.key, { monthlyRent: amount });
                  }}
                >
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResidentsTable({
  rows,
  units,
  properties,
  rowBusy,
  onEdit,
  onExclude,
  onAttachLease,
}: {
  rows: PortfolioImportResident[];
  units: Map<string, PortfolioImportUnit>;
  properties: Map<string, PortfolioImportProperty>;
  rowBusy: string | null;
  onEdit: (key: string, edits: Record<string, unknown>) => void;
  onExclude: (key: string) => void;
  onAttachLease: (residentKey: string) => void;
}) {
  return (
    <div className="space-y-2" data-attr="portfolio-import-residents-table">
      {rows.map((row) => {
        const unit = units.get(row.unitKey);
        const property = properties.get(row.propertyKey);
        const excluded = Boolean(row.excluded);
        return (
          <div
            key={row.key}
            data-attr="portfolio-import-resident-row"
            className={cn("rounded-2xl border p-3.5", excluded ? "border-border/60 bg-[var(--secondary)]/40 opacity-70" : "border-border bg-card")}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{row.name}</p>
                <p className="truncate text-xs text-muted">{row.email ?? "No email"}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted">
                <span>{property?.name ?? "—"} · {unit?.label ?? "—"}</span>
                <span>{money(row.monthlyRent)}/mo</span>
                {row.balance ? <span className="font-semibold text-foreground">owes {money(row.balance)}</span> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {row.leasePdf ? (
                  <span className="text-xs font-medium text-foreground">
                    {row.leasePdf.fileName} {row.leasePdf.fullyExecuted ? "✓ signed" : ""}
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    loading={rowBusy === row.key}
                    onClick={() => onAttachLease(row.key)}
                    data-attr="portfolio-import-attach-lease"
                  >
                    Attach
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    onEdit(row.key, { name: window.prompt("Resident name", row.name) ?? row.name })
                  }
                  data-attr="portfolio-import-resident-edit"
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  loading={rowBusy === row.key}
                  onClick={() => onExclude(row.key)}
                  data-attr="portfolio-import-resident-exclude"
                >
                  Exclude
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TasksTable({ rows }: { rows: PortfolioImportDraft["tasks"] }) {
  return (
    <div className="space-y-2" data-attr="portfolio-import-tasks-table">
      {rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card p-5 text-center text-sm text-muted">
          No tasks planned.
        </p>
      ) : (
        rows.map((task) => (
          <div key={task.key} className="flex items-center justify-between rounded-2xl border border-border bg-card p-3.5">
            <p className="text-sm font-medium text-foreground">{task.title}</p>
            <span className="text-xs text-muted">{task.dueDate}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ===========================================================================
// Step 4 — Import progress
// ===========================================================================

const STAGE_LABEL: Record<string, string> = {
  property: "Properties",
  room: "Units & rooms",
  resident: "Residents",
  balance: "Opening balances",
  task: "Tasks",
};

function ImportStep({
  summary,
  progress,
  busy,
  error,
  commitResult,
  onViewProperties,
  onInviteResidents,
  onRetry,
}: {
  summary: PortfolioImportSummary | null;
  progress: PortfolioImportStageProgress[];
  busy: boolean;
  error: string | null;
  commitResult: { status: string; failures: Array<{ recordKind: string; sourceKey: string; message: string }> } | null;
  onViewProperties: () => void;
  onInviteResidents: () => void;
  onRetry: () => void;
}) {
  const done = commitResult?.status === "completed";
  const partial = commitResult?.status === "partial";
  return (
    <div className="space-y-4" data-attr="portfolio-import-progress">
      <div className="space-y-2.5">
        {progress.length > 0
          ? progress.map((stage) => (
              <div key={stage.stage} className="space-y-1">
                <div className="flex items-center justify-between text-xs font-medium text-muted">
                  <span>{STAGE_LABEL[stage.stage] ?? stage.stage}</span>
                  <span>
                    {stage.done} / {stage.total}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--secondary)]">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: stage.total > 0 ? `${Math.min(100, (stage.done / stage.total) * 100)}%` : "0%" }}
                  />
                </div>
              </div>
            ))
          : Object.entries(STAGE_LABEL).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <p className="text-xs font-medium text-muted">{label}</p>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--secondary)]">
                  <div className={cn("h-full rounded-full bg-primary/40", busy && "animate-pulse")} style={{ width: "10%" }} />
                </div>
              </div>
            ))}
      </div>

      {error ? (
        <div role="alert" className="rounded-2xl border border-border bg-card p-5 text-center">
          <p className="text-sm font-semibold text-foreground">Could not import</p>
          <p className="mt-1 text-sm text-muted">{error}</p>
          <Button type="button" className="mt-3" onClick={onRetry} data-attr="portfolio-import-retry">
            Retry
          </Button>
        </div>
      ) : null}

      {done && summary ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
            <SummaryBox label="Properties" value={summary.propertyCount} />
            <SummaryBox label="Units" value={summary.unitCount} />
            <SummaryBox label="Residents" value={summary.residentCount} />
            <SummaryBox label="Opening balances" value={summary.balanceCount} />
            <SummaryBox label="Tasks" value={summary.taskCount} />
          </div>
          <p className="rounded-2xl bg-accent/20 px-4 py-3 text-sm text-foreground">
            Your portfolio is in. Nothing has been emailed yet — invite residents in the next step, or later from
            Residents.
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onViewProperties} data-attr="portfolio-import-view-properties">
              View properties
            </Button>
            <Button type="button" onClick={onInviteResidents} data-attr="portfolio-import-go-invite">
              Invite residents →
            </Button>
          </div>
        </div>
      ) : null}

      {partial && commitResult ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-foreground">Some rows didn&apos;t import</p>
          {commitResult.failures.map((f) => (
            <p key={f.sourceKey} className="text-sm text-muted">
              {f.recordKind}: {f.message}
            </p>
          ))}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={onRetry} data-attr="portfolio-import-retry">
              Retry
            </Button>
            <Button type="button" onClick={onInviteResidents} data-attr="portfolio-import-go-invite">
              Continue
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ===========================================================================
// Step 5 — Invite residents
// ===========================================================================

function InviteStep({
  residents,
  selected,
  onToggle,
  messaging,
  busy,
  results,
  onRefreshMessaging,
  onSend,
  onDone,
}: {
  residents: PortfolioImportResident[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  messaging: PortfolioImportMessagingStatus | null;
  busy: boolean;
  results: PortfolioImportInviteResult[] | null;
  onRefreshMessaging: () => void;
  onSend: () => void;
  onDone: () => void;
}) {
  const canText = Boolean(messaging?.canText);
  const emailCount = residents.filter((r) => selected.has(r.key) && r.inviteChannels.email).length;
  const textCount = residents.filter((r) => selected.has(r.key) && r.inviteChannels.text && canText).length;

  if (results) {
    const sentEmail = results.filter((r) => r.email === "sent").length;
    const sentText = results.filter((r) => r.text === "sent").length;
    return (
      <div className="space-y-4" data-attr="portfolio-import-invite-results">
        <p className="rounded-2xl bg-accent/20 px-4 py-4 text-sm text-foreground">
          {plural(results.length, "invite")} sent — {sentEmail} by email, {sentText} by text.
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onDone} data-attr="portfolio-import-done">
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-attr="portfolio-import-invite-step">
      <p className="text-sm text-muted">
        Each invite goes by email and, when you have a PropLane number and the resident has a phone, by text too.
        Their Axis ID and the link to create their portal login are in both. Nothing is sent until you press the
        button.
      </p>

      {!canText ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          data-attr="portfolio-import-messaging-setup"
        >
          <span>Text invites need a PropLane work number.</span>
          <div className="flex items-center gap-2">
            <Link
              href={messaging?.settingsHref ?? "/portal/profile?tab=messaging"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-9 items-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground"
              data-attr="portfolio-import-setup-messaging"
            >
              Set up messaging
            </Link>
            <Button type="button" variant="ghost" onClick={onRefreshMessaging} data-attr="portfolio-import-refresh-messaging">
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-300/60 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-attr="portfolio-import-messaging-ready">
          <span>Texts go from {messaging?.workNumber}</span>
        </div>
      )}

      <div className="space-y-2" data-attr="portfolio-import-invite-residents">
        {residents.map((resident) => {
          const channels = residentChannels(resident, canText);
          return (
            <label
              key={resident.key}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-3.5"
              data-attr="portfolio-import-invite-row"
            >
              <input
                type="checkbox"
                checked={selected.has(resident.key)}
                onChange={() => onToggle(resident.key)}
                data-attr="portfolio-import-invite-select"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{resident.name}</span>
                <span className="block truncate text-xs text-muted">
                  {resident.email ?? "No email"} · {resident.phone ?? "No phone"}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs">
                {channels.email ? (
                  <span aria-label="Email" title="Email" data-attr="portfolio-import-channel-email">
                    ✉
                  </span>
                ) : channels.noEmail ? (
                  <span className="text-muted">no email</span>
                ) : null}
                {channels.text ? (
                  <span aria-label="Text" title="Text" data-attr="portfolio-import-channel-text">
                    💬
                  </span>
                ) : channels.needsNumber ? (
                  <span className="text-muted">needs number</span>
                ) : channels.noPhone ? (
                  <span className="text-muted">no phone</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t border-border bg-background/95 py-3 backdrop-blur-sm">
        <p className="text-sm text-muted">
          {selected.size} selected · {emailCount} emails{canText ? ` + ${textCount} texts` : ""}
        </p>
        <Button type="button" loading={busy} disabled={selected.size === 0} onClick={onSend} data-attr="portfolio-import-send-invites">
          {`Send ${plural(selected.size, "invite")}`}
        </Button>
      </div>
    </div>
  );
}
