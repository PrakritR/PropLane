"use client";

/**
 * Resident portal › Forms: the forms a manager sent (Pending · Completed), and the
 * one-question-per-screen flow that fills one. Phone first; the desktop column is the same flow.
 *
 * Answers autosave as the resident goes (debounced `saveMyMoveInFormDraft`), so closing the app
 * never loses work and coming back restores both the answers and the place they stopped.
 * Photos and the signature PNG upload through the move-in forms client; nothing here talks to
 * storage directly, and no file is ever opened inline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock, Download, FileText, Lock } from "lucide-react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { CheckDraw, MoveInProgressBar } from "@/components/move-in-forms/move-in-motion";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { ResidentLeaseBareDocumentPreview } from "@/components/portal/resident-lease-document-preview";
import {
  answerFormatProblem,
  answersToMap,
  firstFormatProblem,
  formatDueDate,
  isMoveInFormLate,
  isMoveInQuestionAnswered,
  mapToAnswers,
  moveInFormProgress,
  omitKey,
  requiredMessage,
  visibleMoveInQuestions,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/ui/motion/use-reduced-motion";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { usePortalSession } from "@/hooks/use-portal-session";
import {
  deleteMyMoveInFormFile,
  downloadMoveInFormPdf,
  getMyMoveInForm,
  loadMoveInForms,
  MOVE_IN_FORMS_CHANGED,
  moveInFormFileUrl,
  moveInFormTemplatePdfUrl,
  saveMyMoveInFormDraft,
  submitMyMoveInForm,
  uploadMyMoveInFormFile,
} from "@/lib/move-in-forms/client";
import {
  MOVE_IN_FORM_BLOCKS_LABELS,
  resolveMoveInFormBlocks,
  type MoveInFormAnswer,
  type MoveInFormQuestion,
  type MoveInFormRecord,
  type MoveInFormSummary,
} from "@/lib/move-in-forms/types";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  RESIDENT_FORMS_BUCKETS,
  residentFormHref,
  residentFormsListHref,
  type ResidentFormsBucket,
} from "@/lib/resident-forms-routes";
import { cn } from "@/lib/utils";

const AUTOSAVE_MS = 800;
/** Waits before retrying a failed autosave: quick at first, then settling at the last value. */
const AUTOSAVE_RETRY_MS = [2_000, 5_000, 15_000, 30_000] as const;

/* ───────────────────────────── list ───────────────────────────── */

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; forms: MoveInFormSummary[] };

const BUCKET_LABELS: Record<ResidentFormsBucket, string> = { pending: "Pending", completed: "Completed" };

function bucketOf(form: MoveInFormSummary): ResidentFormsBucket {
  return form.status === "submitted" ? "completed" : "pending";
}

/** Pending: due soonest first, no due date last. Completed: newest submitted first. */
function sortForBucket(forms: MoveInFormSummary[], bucket: ResidentFormsBucket): MoveInFormSummary[] {
  const time = (value: string | null | undefined, fallback: number) => {
    const t = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(t) ? fallback : t;
  };
  return [...forms].sort((a, b) =>
    bucket === "pending" ? time(a.dueAt, Infinity) - time(b.dueAt, Infinity) : time(b.submittedAt, 0) - time(a.submittedAt, 0),
  );
}

/**
 * Resident portal › Forms: the forms a manager sent, Pending · Completed (tabs are routes), and the form
 * itself at `/forms/<id>`: the one-question-per-screen flow that fills it, or the read-only copy once
 * submitted. A direct link works before approval too (a form that blocks approval is sent while the
 * nav row is still locked).
 */
export function ResidentFormsSection({
  basePath = "/resident",
  bucket = "pending",
  formId,
}: {
  basePath?: string;
  bucket?: ResidentFormsBucket;
  /** Open this form (the `/forms/<id>` address). */
  formId?: string;
}) {
  const { userId, ready } = usePortalSession();
  const ui = useOptionalAppUi();
  const router = useRouter();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (force = false) => {
      if (!userId) {
        setList({ status: "ready", forms: [] });
        return;
      }
      try {
        const result = await loadMoveInForms(userId, "resident", {}, force);
        setList({ status: "ready", forms: result.forms.filter((form) => form.status !== "cancelled") });
      } catch (caught) {
        setList({ status: "error", message: caught instanceof Error ? caught.message : "Could not load your forms." });
      }
    },
    [userId],
  );

  useEffect(() => {
    if (!ready) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on mount; state is set after the awaited fetch
    void load();
    const refresh = () => void load(true);
    window.addEventListener(MOVE_IN_FORMS_CHANGED, refresh);
    return () => window.removeEventListener(MOVE_IN_FORMS_CHANGED, refresh);
  }, [ready, load]);

  if (formId) {
    return (
      <ResidentMoveInFormFlow
        id={formId}
        onClose={() => router.push(residentFormsListHref(basePath))}
        onSubmitted={() => {
          ui?.showToast("Submitted. Your manager has it.");
          router.push(residentFormsListHref(basePath, "completed"));
        }}
      />
    );
  }

  const forms = list.status === "ready" ? list.forms : [];
  const counts = {
    pending: forms.filter((form) => bucketOf(form) === "pending").length,
    completed: forms.filter((form) => bucketOf(form) === "completed").length,
  };
  const rows = sortForBucket(
    forms.filter((form) => bucketOf(form) === bucket),
    bucket,
  );
  const tabs = RESIDENT_FORMS_BUCKETS.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    count: counts[id],
    href: residentFormsListHref(basePath, id),
    dataAttr: `resident-forms-tab-${id}`,
  }));
  const selectedForm = selected.size === 1 ? rows.find((form) => selected.has(form.id)) : undefined;
  const open = (form: MoveInFormSummary) => router.push(residentFormHref(basePath, form.id));

  return (
    <div className="min-w-0 space-y-3" data-attr="resident-forms-section" data-forms-bucket={bucket}>
      <PortalListControlStack
        variant="command"
        stickyDestinations
        destinationAriaLabel="Forms"
        activeDestinationId={bucket}
        destinations={tabs}
      />
      <PortalRecordListSurface
        isEmpty={rows.length === 0}
        loading={list.status === "loading"}
        loadError={list.status === "error" ? "Couldn't load your forms" : undefined}
        onRetry={() => void load(true)}
        emptyCard={{ title: bucket === "pending" ? "No pending forms" : "No completed forms", section: "forms" }}
        onBulkClear={() => setSelected(new Set())}
        bulkCount={selected.size}
        bulkActions={
          selectedForm ? (
            <Button
              type="button"
              variant="outline"
              className={PORTAL_BULK_BAR_BTN}
              data-attr={selectedForm.status === "submitted" ? "resident-form-view" : "resident-form-fill"}
              onClick={() => open(selectedForm)}
            >
              {selectedForm.status === "submitted" ? "View" : "Fill out"}
            </Button>
          ) : undefined
        }
        dataAttr="resident-forms-list"
      >
        {rows.map((form) => {
          const done = form.status === "submitted";
          const late = !done && isMoveInFormLate(form.dueAt);
          const due = formatDueDate(form.dueAt);
          const submitted = formatDueDate(form.submittedAt);
          const blocking = resolveMoveInFormBlocks(form.blocks, form.kind) !== "nothing";
          return (
            <PortalEntryRow
              key={form.id}
              tile={{ kind: "glyph", icon: FileText }}
              title={form.formName}
              place={[form.propertyLabel, form.roomLabel].map((part) => part.trim()).filter(Boolean).join(" · ")}
              facts={[
                ...(done
                  ? [{ icon: CheckCircle2, label: submitted ? `Submitted ${submitted}` : "Submitted" }]
                  : [
                      {
                        icon: Clock,
                        label: late ? <span className="font-medium text-[var(--status-overdue-fg)]">{`Due ${due} · Late`}</span> : due ? `Due ${due}` : "Not due yet",
                      },
                    ]),
                ...(blocking && !done ? [{ icon: Lock, label: `Needed for ${MOVE_IN_FORM_BLOCKS_LABELS[resolveMoveInFormBlocks(form.blocks, form.kind)].toLowerCase()}` }] : []),
              ]}
              checked={selected.has(form.id)}
              onSelectedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(form.id);
                  else next.delete(form.id);
                  return next;
                })
              }
              onOpen={() => open(form)}
              omitActionView
              selectLabel={form.formName}
              dataAttr="resident-form-row"
            />
          );
        })}
      </PortalRecordListSurface>
    </div>
  );
}

/* ───────────────────────────── fill flow ───────────────────────────── */

type Step = { kind: "pdf" } | { kind: "pdf-sign"; question: MoveInFormQuestion } | { kind: "question"; question: MoveInFormQuestion };

function stepsFor(record: MoveInFormRecord, visible: MoveInFormQuestion[]): Step[] {
  if (record.source === "upload") {
    if (visible.length === 1 && visible[0]!.type === "signature") return [{ kind: "pdf-sign", question: visible[0]! }];
    return [{ kind: "pdf" }, ...visible.map((question) => ({ kind: "question" as const, question }))];
  }
  return visible.map((question) => ({ kind: "question" as const, question }));
}

function stepQuestion(step: Step | undefined): MoveInFormQuestion | null {
  return step && step.kind !== "pdf" ? step.question : null;
}

type SaveState = "idle" | "saving" | "saved" | "error";

function ResidentMoveInFormFlow({ id, onClose, onSubmitted }: { id: string; onClose: () => void; onSubmitted: () => void }) {
  const reduced = useReducedMotion();
  const ui = useOptionalAppUi();
  const [record, setRecord] = useState<MoveInFormRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<MoveInAnswerMap>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState<"fwd" | "back">("fwd");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"fill" | "submitting" | "done">("fill");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const latest = useRef<MoveInAnswerMap>({});
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const failures = useRef(0);
  // True while the form is closing: that final save is attempted once and never rescheduled.
  const closing = useRef(false);
  // The retry timer calls the latest flush through this ref (a callback cannot name itself).
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const recordRef = useRef<MoveInFormRecord | null>(null);
  const readOnlyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getMyMoveInForm(id)
      .then(({ form }) => {
        if (cancelled) return;
        const map = answersToMap(form.answers);
        latest.current = map;
        recordRef.current = form;
        readOnlyRef.current = form.status !== "sent";
        setRecord(form);
        setAnswers(map);
        const visible = visibleMoveInQuestions(form.snapshot.questions, map);
        const steps = stepsFor(form, visible);
        const resume = moveInFormProgress(form.snapshot.questions, map).resumeIndex;
        const hasAnswers = Object.keys(map).length > 0;
        const offset = steps[0]?.kind === "pdf" && hasAnswers ? 1 : 0;
        setStepIndex(Math.min(resume + offset, Math.max(steps.length - 1, 0)));
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "Could not open this form.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Saves what is pending now. Resolves true when nothing is left unsaved. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const form = recordRef.current;
    if (!form || readOnlyRef.current || !dirty.current) return true;
    dirty.current = false;
    setSaveState("saving");
    try {
      await saveMyMoveInFormDraft(id, mapToAnswers(form.snapshot.questions, latest.current, { draft: true }));
      failures.current = 0;
      setSaveState("saved");
      return true;
    } catch {
      dirty.current = true;
      setSaveState("error");
      // A real retry, with backoff: a resident who stops typing after a failed save is not left waiting.
      if (!closing.current) {
        const delay = AUTOSAVE_RETRY_MS[Math.min(failures.current, AUTOSAVE_RETRY_MS.length - 1)]!;
        failures.current += 1;
        retryTimer.current = window.setTimeout(() => void flushRef.current(), delay);
      }
      return false;
    }
  }, [id]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Leaving mid-form still sends what was typed.
  useEffect(() => {
    closing.current = false;
    return () => {
      closing.current = true;
      void flush();
    };
  }, [flush]);

  const setAnswer = (key: string, answer: MoveInFormAnswer | null) => {
    const next = { ...latest.current };
    if (answer) next[key] = answer;
    else delete next[key];
    latest.current = next;
    setAnswers(next);
    setErrors((prev) => (prev[key] ? omitKey(prev, key) : prev));
    dirty.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const questions = useMemo(() => record?.snapshot.questions ?? [], [record]);
  const visible = useMemo(() => visibleMoveInQuestions(questions, answers), [questions, answers]);
  const steps = useMemo(() => (record ? stepsFor(record, visible) : []), [record, visible]);
  const index = Math.min(stepIndex, Math.max(steps.length - 1, 0));
  const step = steps[index];
  const current = stepQuestion(step);
  const isLast = index >= steps.length - 1;
  const readOnly = Boolean(record && record.status !== "sent");

  const checkStep = (question: MoveInFormQuestion | null): boolean => {
    if (!question) return true;
    if (question.required && !isMoveInQuestionAnswered(question, answers[question.key])) {
      setErrors((prev) => ({ ...prev, [question.key]: requiredMessage(question) }));
      return false;
    }
    const format = answerFormatProblem(question, answers[question.key]);
    if (format) {
      setErrors((prev) => ({ ...prev, [question.key]: format }));
      return false;
    }
    return true;
  };

  const go = (to: number, dir: "fwd" | "back") => {
    setDirection(dir);
    setStepIndex(Math.min(Math.max(to, 0), Math.max(steps.length - 1, 0)));
  };

  const next = () => {
    if (!checkStep(current)) return;
    void flush();
    if (!isLast) go(index + 1, "fwd");
  };

  const submit = async () => {
    if (!record) return;
    if (!checkStep(current)) return;
    const badFormat = firstFormatProblem(questions, answers);
    if (badFormat) {
      const target = steps.findIndex((item) => stepQuestion(item)?.key === badFormat.question.key);
      setErrors((prev) => ({ ...prev, [badFormat.question.key]: badFormat.message }));
      if (target >= 0) go(target, target < index ? "back" : "fwd");
      return;
    }
    const { missing } = moveInFormProgress(questions, answers);
    if (missing.length > 0) {
      const first = missing[0]!;
      const target = steps.findIndex((item) => stepQuestion(item)?.key === first.key);
      setErrors((prev) => ({ ...prev, [first.key]: requiredMessage(first) }));
      if (target >= 0) go(target, target < index ? "back" : "fwd");
      return;
    }
    setSubmitError(null);
    setPhase("submitting");
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    try {
      await submitMyMoveInForm(id, mapToAnswers(questions, latest.current));
      dirty.current = false;
      recordRef.current = null;
      setPhase("done");
      window.setTimeout(onSubmitted, reduced ? 250 : 1250);
    } catch (caught) {
      setPhase("fill");
      setSubmitError(caught instanceof Error ? caught.message : "Could not submit. Try again.");
    }
  };

  if (loadError) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <FlowHeader title="Move-in form" onBack={onClose} />
        <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-foreground">
          {loadError}
        </div>
      </div>
    );
  }

  if (!record) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY} role="status" aria-label="Opening form">
        <div className="h-40 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className={cn(PORTAL_LIST_PAGE_BODY, "grid place-items-center py-16")} data-attr="resident-move-in-form-done" role="status">
        <div className="grid place-items-center gap-3 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-primary text-white shadow-md">
            <CheckDraw className="size-8" />
          </span>
          <p className="text-base font-semibold text-foreground">Submitted</p>
        </div>
      </div>
    );
  }

  const pdfSrc = record.source === "upload" ? moveInFormTemplatePdfUrl("resident", record.id) : null;
  const fileUrl = (path: string) => moveInFormFileUrl("resident", record.id, path);
  const uploaderFor = (question: MoveInFormQuestion) => (file: Blob, fileName: string) =>
    uploadMyMoveInFormFile(record.id, question.key, file, fileName).then((result) => result.storagePath);
  // The answer that drops a file is saved first, so a draft never points at an object that is gone.
  const removeUpload = async (storagePath: string) => {
    if (await flush()) await deleteMyMoveInFormFile(record.id, storagePath);
  };

  if (readOnly) {
    return (
      <div className={cn(PORTAL_LIST_PAGE_BODY, "motion-just-loaded")} data-attr="resident-move-in-form-readonly">
        <FlowHeader title={record.formName} onBack={onClose} />
        <div className="space-y-5 rounded-2xl border border-border bg-card p-4">
          {pdfSrc ? <ResidentLeaseBareDocumentPreview pdfSrc={pdfSrc} title={record.formName} /> : null}
          {visible.map((question) => (
            <MoveInFormQuestionField
              key={question.key}
              question={question}
              answer={answers[question.key]}
              onChange={() => {}}
              readOnly
              fileUrl={fileUrl}
            />
          ))}
        </div>
        {record.status === "submitted" ? (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => void downloadMoveInFormPdf("resident", record.id, `${record.formName}.pdf`).catch(() => ui?.showToast("Could not download this form."))}
              data-attr="resident-move-in-form-download"
            >
              <Download className="size-4" aria-hidden />
              Download
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const progressTotal = Math.max(steps.length, 1);
  const stepLabel = step?.kind === "pdf" ? "Read the document" : `${index + 1} of ${progressTotal}`;
  const primaryLabel = isLast ? (record.source === "upload" ? "Sign and submit" : "Submit") : "Next";

  return (
    <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-move-in-form-flow">
      <FlowHeader title={record.formName} onBack={onClose} />
      <div className="mx-auto w-full max-w-xl space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{step?.kind === "pdf" || step?.kind === "pdf-sign" ? "Document" : current?.section ?? "Questions"}</span>
            <span>{stepLabel}</span>
          </div>
          <MoveInProgressBar ratio={steps.length ? (index + 1) / steps.length : 1} label="Form progress" />
        </div>

        <div
          key={`${step?.kind ?? "none"}-${current?.key ?? "x"}`}
          className={cn("space-y-4 rounded-2xl border border-border bg-card p-4", direction === "fwd" ? "motion-wiz-dir-fwd" : "motion-wiz-dir-back")}
        >
          {step?.kind === "pdf" || step?.kind === "pdf-sign" ? (
            pdfSrc ? <ResidentLeaseBareDocumentPreview pdfSrc={pdfSrc} title={record.formName} /> : null
          ) : null}
          {current ? (
            <MoveInFormQuestionField
              question={current}
              answer={answers[current.key]}
              onChange={(answer) => setAnswer(current.key, answer)}
              error={errors[current.key]}
              uploadFile={uploaderFor(current)}
              removeFile={removeUpload}
              fileUrl={fileUrl}
              signerName={record.residentName}
            />
          ) : null}
          {steps.length === 0 ? <p className="text-sm text-foreground">There is nothing to fill in on this form.</p> : null}
        </div>

        {submitError ? (
          <p role="alert" className="text-sm text-red-600">
            {submitError}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 rounded-full px-5"
            disabled={index === 0 || phase === "submitting"}
            onClick={() => go(index - 1, "back")}
            data-attr="resident-move-in-form-back"
          >
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-11 flex-1 rounded-full sm:flex-none sm:px-8"
            loading={phase === "submitting"}
            onClick={isLast ? () => void submit() : next}
            data-attr="resident-move-in-form-next"
          >
            {primaryLabel}
          </Button>
        </div>
        <p className="text-center text-xs text-muted" aria-live="polite">
          {saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved yet. Retrying…" : "Saved as you go"}
        </p>
      </div>
    </div>
  );
}

function FlowHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to forms"
        data-attr="resident-move-in-form-close"
        className="-ml-2 grid size-11 place-items-center rounded-full text-foreground transition-colors duration-(--motion-fast) hover:bg-accent"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </button>
      <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h2>
    </div>
  );
}
