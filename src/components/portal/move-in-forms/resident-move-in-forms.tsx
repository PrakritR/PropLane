"use client";

/**
 * Resident portal › My home › Forms: the move-in forms a manager sent, as a checklist, and the
 * one-question-per-screen flow that fills one. Phone first; the desktop column is the same flow.
 *
 * Answers autosave as the resident goes (debounced `saveMyMoveInFormDraft`), so closing the app
 * never loses work and coming back restores both the answers and the place they stopped.
 * Photos and the signature PNG upload through the move-in forms client; nothing here talks to
 * storage directly, and no file is ever opened inline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Download } from "lucide-react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { CheckDraw, MoveInProgressBar } from "@/components/move-in-forms/move-in-motion";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
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
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormRecord, MoveInFormSummary } from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

const AUTOSAVE_MS = 800;

function CheckCircle({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full border-2 transition-colors duration-(--motion-base)",
        done ? "border-primary bg-primary text-white" : "border-border bg-card",
      )}
    >
      {done ? <CheckDraw className="size-4" /> : null}
    </span>
  );
}

/* ───────────────────────────── list ───────────────────────────── */

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; forms: MoveInFormSummary[] };

function sortForms(forms: MoveInFormSummary[]): MoveInFormSummary[] {
  const rank = (form: MoveInFormSummary) => (form.status === "submitted" ? 1 : 0);
  return [...forms].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const aDue = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });
}

export function ResidentMoveInForms() {
  const { userId, ready } = usePortalSession();
  const ui = useOptionalAppUi();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [openId, setOpenId] = useState<string | null>(null);

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

  if (openId) {
    return (
      <ResidentMoveInFormFlow
        id={openId}
        onClose={() => {
          setOpenId(null);
          void load(true);
        }}
        onSubmitted={() => {
          setOpenId(null);
          void load(true);
          ui?.showToast("Submitted. Your manager has it.");
        }}
      />
    );
  }

  if (list.status === "loading") {
    return (
      <div className={PORTAL_LIST_PAGE_BODY} role="status" aria-label="Loading forms">
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-accent/50 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    );
  }

  if (list.status === "error") {
    return (
      <div className={PORTAL_LIST_PAGE_BODY}>
        <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center">
          <p className="mb-3 text-sm text-foreground">{list.message}</p>
          <Button variant="outline" onClick={() => void load(true)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (list.forms.length === 0) {
    return (
      <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-move-in-forms-empty">
        <PortalDataTableEmpty icon="default" message="No move-in forms" />
      </div>
    );
  }

  const forms = sortForms(list.forms);
  const done = forms.filter((form) => form.status === "submitted").length;

  return (
    <div className={cn(PORTAL_LIST_PAGE_BODY, "motion-just-loaded")} data-attr="resident-move-in-forms">
      <div className="mb-4 space-y-2">
        <p className="text-sm font-semibold text-foreground">
          Before you move in · {done} of {forms.length} done
        </p>
        <MoveInProgressBar ratio={forms.length ? done / forms.length : 0} label="Forms done" />
      </div>
      <ul className="space-y-2">
        {forms.map((form) => {
          const isDone = form.status === "submitted";
          const due = formatDueDate(form.dueAt);
          const late = !isDone && isMoveInFormLate(form.dueAt);
          return (
            <li key={form.id}>
              <button
                type="button"
                onClick={() => setOpenId(form.id)}
                data-attr="resident-move-in-form-row"
                className="flex min-h-[60px] w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left shadow-sm transition-[transform,box-shadow,border-color] duration-(--motion-base) ease-(--motion-crossfade) hover:-translate-y-px hover:border-primary/30 hover:shadow-md active:translate-y-0 motion-reduce:transition-none"
              >
                <CheckCircle done={isDone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-foreground">{form.formName}</span>
                  <span className={cn("block text-[13px]", late ? "font-semibold text-red-600" : "text-muted")}>
                    {isDone ? "Done" : due ? `Due ${due}` : "Not due yet"}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
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

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const form = recordRef.current;
    if (!form || readOnlyRef.current || !dirty.current) return;
    dirty.current = false;
    setSaveState("saving");
    try {
      await saveMyMoveInFormDraft(id, mapToAnswers(form.snapshot.questions, latest.current, { draft: true }));
      setSaveState("saved");
    } catch {
      dirty.current = true;
      setSaveState("error");
    }
  }, [id]);

  // Leaving mid-form still sends what was typed.
  useEffect(() => {
    return () => {
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
          {saveState === "saving" ? "Saving…" : saveState === "error" ? "Could not save yet. We will retry." : "Saved as you go"}
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
