"use client";

/**
 * The builder's right-hand pane: the form exactly as a resident gets it, one question at a
 * time, inside a phone frame. It draws through the same question renderer as the resident
 * flow, so editing a question and watching it change here is the whole feedback loop.
 * Nothing typed here is saved or sent anywhere.
 */
import { ArrowLeft } from "lucide-react";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { MoveInProgressBar } from "@/components/move-in-forms/move-in-motion";
import {
  visibleMoveInQuestions,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { Button } from "@/components/ui/button";
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormSource } from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

export type PreviewScreen = { kind: "pdf" } | { kind: "question"; question: MoveInFormQuestion };

/** The screens a resident would walk through, in order. A blank question still gets a placeholder so it can be seen while typed. */
export function previewScreens(source: MoveInFormSource, questions: readonly MoveInFormQuestion[], answers: MoveInAnswerMap): PreviewScreen[] {
  const named = questions.map((q) => (q.label.trim() ? q : { ...q, label: "Your question" }));
  const screens: PreviewScreen[] = visibleMoveInQuestions(named, answers).map((question) => ({ kind: "question", question }));
  return source === "upload" ? [{ kind: "pdf" }, ...screens] : screens;
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
  const setAnswer = (key: string, answer: MoveInFormAnswer | null) => {
    const next = { ...answers };
    if (answer) next[key] = answer;
    else delete next[key];
    onAnswersChange(next);
  };

  return (
    <section aria-label="What the resident sees" data-attr="move-in-form-live-preview">
      <h3 className="mb-2 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">What the resident sees · live</h3>
      <div className="mx-auto w-full max-w-[272px] rounded-[30px] border-[7px] border-foreground/85 bg-card shadow-lg">
        <div className="flex min-h-[420px] flex-col rounded-[22px] bg-background p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
            <ArrowLeft className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 truncate">{name.trim() || "Untitled form"}</span>
          </div>
          {screens.length === 0 ? (
            <p className="mt-6 text-center text-xs text-muted">Add a question and it shows here.</p>
          ) : (
            <>
              <div className="mb-2 space-y-1.5">
                <p className="text-[11px] text-muted">
                  {screen?.kind === "pdf" ? "Read the document" : `${at + 1} of ${screens.length}`}
                </p>
                <MoveInProgressBar ratio={(at + 1) / screens.length} label="Preview progress" />
              </div>
              <div key={screen?.kind === "question" ? screen.question.key : "pdf"} className={cn("motion-wiz-dir-fwd min-h-0 flex-1 overflow-y-auto pb-2 text-[13px]")}>
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
              <div className="mt-2 flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full px-3"
                  disabled={at === 0}
                  onClick={() => onIndexChange(at - 1)}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className="flex-1 rounded-full"
                  disabled={at >= screens.length - 1}
                  onClick={() => onIndexChange(at + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
