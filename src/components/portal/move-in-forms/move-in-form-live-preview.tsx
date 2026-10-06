"use client";

/**
 * The builder's right-hand pane: the form exactly as a resident gets it, one question at a
 * time, in the same card the application editor draws for "Applicant sees" ("Step n of N · form name"). It draws through the same question renderer as the resident
 * flow, so editing a question and watching it change here is the whole feedback loop.
 * Nothing typed here is saved or sent anywhere.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  visibleMoveInQuestions,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { WorkspacePreviewTitle } from "@/components/portal/add-workspace/frame";
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormSource } from "@/lib/move-in-forms/types";

export type PreviewScreen = { kind: "pdf" } | { kind: "question"; question: MoveInFormQuestion };

/** The screens a resident would walk through, in order. A blank question still gets a placeholder so it can be seen while typed. */
export function previewScreens(source: MoveInFormSource, questions: readonly MoveInFormQuestion[], answers: MoveInAnswerMap): PreviewScreen[] {
  const named = questions.map((q) => (q.label.trim() ? q : { ...q, label: "Your question" }));
  const screens: PreviewScreen[] = visibleMoveInQuestions(named, answers).map((question) => ({ kind: "question", question }));
  return source === "upload" ? [{ kind: "pdf" }, ...screens] : screens;
}

/** "Step 1 of 9 · Household application": where the preview is, like the application editor's label. */
export function previewStepLabel(index: number, total: number, formName: string): string {
  return `Step ${index + 1} of ${total} · ${formName}`;
}

export function MoveInFormLivePreview({
  name,
  source,
  questions,
  pdfUrl,
  index,
  onIndexChange,
  answers,
  onAnswersChange,
}: {
  name: string;
  source: MoveInFormSource;
  questions: readonly MoveInFormQuestion[];
  /** A blob URL of the PDF just picked, or the saved PDF's route. Null before any upload. */
  pdfUrl: string | null;
  index: number;
  onIndexChange: (next: number) => void;
  answers: MoveInAnswerMap;
  onAnswersChange: (next: MoveInAnswerMap) => void;
}) {
  const screens = previewScreens(source, questions, answers);
  const at = Math.min(Math.max(index, 0), Math.max(screens.length - 1, 0));
  const screen = screens[at];
  const formName = name.trim() || "Untitled form";
  const setAnswer = (key: string, answer: MoveInFormAnswer | null) => {
    const next = { ...answers };
    if (answer) next[key] = answer;
    else delete next[key];
    onAnswersChange(next);
  };

  return (
    <section aria-label="What the resident sees" data-attr="move-in-form-live-preview">
      <WorkspacePreviewTitle>Resident sees</WorkspacePreviewTitle>
      <div className="space-y-4 rounded-2xl border border-border bg-card p-3.5">
        <div className="flex items-center justify-between gap-2">
          {screens.length === 0 ? (
            <h4 className="min-w-0 truncate text-sm font-bold text-foreground">{formName}</h4>
          ) : (
            <p className="min-w-0 truncate text-xs text-muted" data-attr="move-in-form-preview-step-label">
              {previewStepLabel(at, screens.length, formName)}
            </p>
          )}
          {screens.length > 1 ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <PortalIconAction icon={ChevronLeft} label="Previous question" disabled={at === 0} onClick={() => onIndexChange(at - 1)} />
              <PortalIconAction icon={ChevronRight} label="Next question" disabled={at >= screens.length - 1} onClick={() => onIndexChange(at + 1)} />
            </div>
          ) : null}
        </div>
        {screens.length === 0 ? (
          <p className="text-sm text-muted" data-attr="move-in-form-preview-empty">
            No questions in this form yet.
          </p>
        ) : (
          <div key={screen?.kind === "question" ? screen.question.key : "pdf"} className="motion-wiz-dir-fwd min-h-0 text-[13px]">
            {screen?.kind === "pdf" ? (
              pdfUrl ? (
                <div className="max-h-[300px] overflow-y-auto rounded-lg border border-border bg-white">
                  <UploadedLeasePdfPreview dataUrl={pdfUrl} title={name || "Form"} documentFlow />
                </div>
              ) : (
                <div className="grid h-40 place-items-center rounded-lg border border-dashed border-border text-xs text-muted">The PDF shows here</div>
              )
            ) : screen ? (
              <MoveInFormQuestionField
                question={screen.question}
                answer={answers[screen.question.key]}
                onChange={(answer) => setAnswer(screen.question.key, answer)}
                signerName="Resident name"
              />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
