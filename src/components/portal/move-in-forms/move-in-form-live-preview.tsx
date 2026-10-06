"use client";

/**
 * The builder's right-hand pane: the form exactly as a resident gets it, a whole section at a time,
 * in the shared preview pager the application editor's "Applicant sees" also uses. It draws through
 * the same question renderer as the resident flow, so editing a question and watching it change here
 * is the whole feedback loop. Nothing typed here is saved or sent anywhere.
 */
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import {
  PreviewPager,
  previewStepIndexOf,
  type PreviewGroup,
} from "@/components/portal/preview-pager";
import {
  visibleMoveInQuestions,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import type { MoveInFormAnswer, MoveInFormQuestion, MoveInFormSource } from "@/lib/move-in-forms/types";

/**
 * The questions a resident would see, as runs of the form's own sections in order. A blank question
 * still gets a placeholder so it can be seen while typed. Questions with no section share one untitled group.
 */
export function moveInPreviewGroups(questions: readonly MoveInFormQuestion[], answers: MoveInAnswerMap): PreviewGroup<MoveInFormQuestion>[] {
  const named = questions.map((q) => (q.label.trim() ? q : { ...q, label: "Your question" }));
  const groups: PreviewGroup<MoveInFormQuestion>[] = [];
  for (const question of visibleMoveInQuestions(named, answers)) {
    const title = question.section?.trim() ?? "";
    const last = groups[groups.length - 1];
    if (last && last.title === title) (last.items as MoveInFormQuestion[]).push(question);
    else groups.push({ key: `${groups.length}:${title}`, title, items: [question] });
  }
  return groups;
}

/** The preview step that holds a question (an uploaded form's PDF is step 0); -1 when it is not shown. */
export function moveInPreviewStepOf(source: MoveInFormSource, questions: readonly MoveInFormQuestion[], answers: MoveInAnswerMap, key: string): number {
  return previewStepIndexOf(moveInPreviewGroups(questions, answers), (question) => question.key === key, source === "upload");
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
  const setAnswer = (key: string, answer: MoveInFormAnswer | null) => {
    const next = { ...answers };
    if (answer) next[key] = answer;
    else delete next[key];
    onAnswersChange(next);
  };

  return (
    <PreviewPager
      heading="Resident sees"
      ariaLabel="What the resident sees"
      dataAttr="move-in-form-live-preview"
      attrPrefix="move-in-form-preview"
      formName={name.trim() || "Untitled form"}
      groups={moveInPreviewGroups(questions, answers)}
      itemKey={(question) => question.key}
      renderItem={(question) => (
        <MoveInFormQuestionField question={question} answer={answers[question.key]} onChange={(answer) => setAnswer(question.key, answer)} signerName="Resident name" />
      )}
      leadingStep={
        source === "upload" ? (
          pdfUrl ? (
            <div className="max-h-[300px] overflow-y-auto rounded-lg border border-border bg-white">
              <UploadedLeasePdfPreview dataUrl={pdfUrl} title={name || "Form"} documentFlow />
            </div>
          ) : (
            <div className="grid h-40 place-items-center rounded-lg border border-dashed border-border text-xs text-muted">The PDF shows here</div>
          )
        ) : undefined
      }
      emptyText="No questions in this form yet."
      index={index}
      onIndexChange={onIndexChange}
    />
  );
}
