"use client";

/**
 * The move-in form builder, in the house standard popup frame (`AddWorkspace`, the New
 * property wizard's shell): header with save state and Ask PropLane, a step rail with the
 * property as its context card, the step in the centre, and the resident's live view flush
 * right. Four steps — Form (or Upload), Questions, Who & when, Review — and the primary on
 * the last one is "Create form" or "Save form".
 *
 * The questions reuse the application's question model and its type vocabulary; the live
 * pane draws through the same renderer a resident gets.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus, Trash2, Upload } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import {
  ReviewCard,
  WizardField,
  WizardMultiSelect,
  WizardRow,
  WizardSection,
  WizardSelect,
} from "@/components/portal/add-workspace/parts";
import { MoveInFormLivePreview, previewScreens } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import {
  addMoveInQuestion,
  addMoveInSection,
  audienceSummary,
  cleanMoveInTemplateForSave,
  groupQuestionsBySection,
  MOVE_IN_DUE_OPTIONS,
  MOVE_IN_QUESTION_TYPE_OPTIONS,
  MOVE_IN_TRIGGER_OPTIONS,
  moveInFormProblemsByStep,
  questionCountLabel,
  questionTypeHasOptions,
  removeMoveInQuestion,
  removeMoveInSection,
  renameMoveInSection,
  reorderMoveInSection,
  templateSourceLine,
  triggerSummary,
  updateMoveInQuestion,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { ReorderList } from "@/components/ui/motion/reorder-list";
import { moveInFormTemplatePdfUrl, uploadMoveInFormPdf } from "@/lib/move-in-forms/client";
import { MOVE_IN_FORM_STARTERS } from "@/lib/move-in-forms/templates";
import type {
  MoveInFormAudience,
  MoveInFormQuestion,
  MoveInFormStarterKey,
  MoveInFormTemplate,
} from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

const MAX_PDF_BYTES = 8 * 1024 * 1024;

export type MoveInEditorRoom = { id: string; label: string };
export type MoveInEditorSaveOptions = { sendToCurrent: boolean };

function deriveFormName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
}

const STARTS_FROM_OPTIONS = [
  { value: "blank", label: "Blank" },
  ...MOVE_IN_FORM_STARTERS.map((starter) => ({ value: starter.starterKey ?? starter.id, label: starter.name })),
];

export function MoveInFormEditorModal({
  mode,
  initial,
  rooms,
  propertyId,
  propertyLabel,
  startStep = 0,
  onSave,
  onClose,
}: {
  mode: "add" | "edit";
  initial: MoveInFormTemplate;
  rooms: readonly MoveInEditorRoom[];
  propertyId: string;
  propertyLabel: string;
  /** Preview from a row's ⋯ opens on the last step; Edit opens on the first. */
  startStep?: number;
  /** Writes the form to the property. Resolves true on success, after which the editor closes. */
  onSave: (template: MoveInFormTemplate, options: MoveInEditorSaveOptions) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<MoveInFormTemplate>(() => structuredClone(initial));
  const [step, setStep] = useState(Math.min(Math.max(startStep, 0), 3));
  const [showErrors, setShowErrors] = useState(false);
  const [sendNow, setSendNow] = useState(mode === "add");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startsFrom, setStartsFrom] = useState<string>(initial.starterKey ?? "blank");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewAnswers, setPreviewAnswers] = useState<MoveInAnswerMap>({});
  const [baseline] = useState(() => JSON.stringify(initial));
  const fileInput = useRef<HTMLInputElement>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    blobRef.current = pdfBlobUrl;
  }, [pdfBlobUrl]);
  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

  const isUpload = draft.source === "upload";
  const dirty = JSON.stringify(draft) !== baseline;
  const problems = useMemo(() => moveInFormProblemsByStep(draft), [draft]);
  const allProblems = [...problems.form, ...problems.questions, ...problems.who];
  const pdfUrl = pdfBlobUrl ?? (draft.pdf ? moveInFormTemplatePdfUrl("manager", draft.id, propertyId) : null);
  const roomOptions = useMemo(() => rooms.map((room) => ({ value: room.id, label: room.label })), [rooms]);

  const patch = (next: Partial<MoveInFormTemplate>) => setDraft((prev) => ({ ...prev, ...next }));
  const setQuestions = (questions: MoveInFormQuestion[]) => patch({ questions });

  const stepsDef: AddWorkspaceStep[] = [
    {
      id: "form",
      label: isUpload ? "Upload" : "Form",
      summary: draft.name.trim() || (isUpload ? "Add the PDF" : "Name this form"),
      incomplete: problems.form.length > 0,
    },
    {
      id: "questions",
      label: "Questions",
      summary: questionCountLabel(draft.questions.length),
      incomplete: problems.questions.length > 0,
    },
    {
      id: "who",
      label: "Who & when",
      summary: `${audienceSummary(draft.audience, rooms)} · ${triggerSummary(draft.trigger)}`,
      incomplete: problems.who.length > 0,
    },
    { id: "review", label: "Review", summary: mode === "add" ? "Check and create" : "Check and save" },
  ];

  const stepProblems = [problems.form, problems.questions, problems.who, [] as string[]][step] ?? [];

  const pickPdf = async (file: File | undefined | null) => {
    if (!file) return;
    if (!(file.type === "application/pdf" || /\.pdf$/i.test(file.name))) {
      setUploadError("Choose a PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setUploadError("The PDF must be 8 MB or smaller.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const { pdf } = await uploadMoveInFormPdf(propertyId, draft.id, file);
      setPdfBlobUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return URL.createObjectURL(file);
      });
      setDraft((prev) => ({ ...prev, pdf, name: prev.name.trim() ? prev.name : deriveFormName(file.name) }));
      setPreviewIndex(0);
    } catch (caught) {
      setUploadError(caught instanceof Error ? caught.message : "Could not upload that PDF. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const changeStartsFrom = (value: string) => {
    const previous = MOVE_IN_FORM_STARTERS.find((starter) => (starter.starterKey ?? starter.id) === startsFrom);
    setStartsFrom(value);
    const starter = MOVE_IN_FORM_STARTERS.find((item) => (item.starterKey ?? item.id) === value);
    setDraft((prev) => {
      const keepName = prev.name.trim() && prev.name !== previous?.name;
      if (!starter) return { ...prev, questions: [], starterKey: undefined };
      return {
        ...prev,
        questions: structuredClone(starter.questions),
        name: keepName ? prev.name : starter.name,
        trigger: starter.trigger,
        due: starter.due,
        starterKey: value as MoveInFormStarterKey,
      };
    });
    setPreviewIndex(0);
    setPreviewAnswers({});
  };

  const setAudienceKind = (kind: string) => {
    const audience: MoveInFormAudience =
      kind === "rooms"
        ? { kind: "rooms", roomIds: draft.audience.kind === "rooms" ? draft.audience.roomIds : [] }
        : kind === "whole-house"
          ? { kind: "whole-house" }
          : { kind: "every-room" };
    patch({ audience });
  };

  const finish = async () => {
    if (allProblems.length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const enabled = mode === "add" ? true : draft.enabled;
    const ok = await onSave(cleanMoveInTemplateForSave({ ...draft, enabled }), { sendToCurrent: sendNow && enabled });
    setSaving(false);
    if (ok) onClose();
    else setSaveError("Could not save this form. Try again.");
  };

  const focusQuestion = (key: string) => {
    const screens = previewScreens(draft.source, draft.questions, previewAnswers);
    const at = screens.findIndex((screen) => screen.kind === "question" && screen.question.key === key);
    if (at >= 0) setPreviewIndex(at);
  };

  /* ───────────── step bodies ───────────── */

  const formStep = (
    <div className="space-y-4">
      <WizardSection title={isUpload ? "Upload the PDF" : "Name the form"}>
        <div className="space-y-4">
          <WizardField label="Form name" required>
            <Input
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder={isUpload ? "Pet agreement" : "Move-in checklist"}
              data-attr="move-in-form-name"
            />
          </WizardField>
          {!isUpload && mode === "add" ? (
            <WizardSelect
              label="Starts from"
              value={startsFrom}
              onChange={changeStartsFrom}
              options={STARTS_FROM_OPTIONS}
              dataAttr="move-in-form-starts-from"
            />
          ) : null}
          {isUpload ? (
            <div className="space-y-2">
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                aria-label="Choose a PDF"
                onChange={(event) => {
                  void pickPdf(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {draft.pdf ? (
                <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3" data-attr="move-in-form-pdf-row">
                  <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-accent text-foreground/80">
                    <FileText className="size-5" strokeWidth={1.6} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-foreground">{draft.pdf.fileName}</p>
                    <p className="text-xs text-muted">
                      {draft.pdf.pageCount} page{draft.pdf.pageCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    loading={uploading}
                    onClick={() => fileInput.current?.click()}
                    data-attr="move-in-form-pdf-replace"
                  >
                    Replace
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    void pickPdf(event.dataTransfer.files?.[0]);
                  }}
                  data-attr="move-in-form-pdf-drop"
                  className={cn(
                    "grid w-full place-items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-9 text-sm font-semibold text-foreground transition-colors duration-(--motion-base) ease-(--motion-crossfade)",
                    dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/40",
                  )}
                >
                  <Upload className={cn("size-6 text-muted transition-transform duration-(--motion-base)", dragging && "-translate-y-0.5 text-primary")} aria-hidden />
                  {uploading ? "Uploading…" : "Drop a PDF here or browse"}
                </button>
              )}
              {uploadError ? (
                <p role="alert" className="text-sm text-red-600">
                  {uploadError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </WizardSection>
    </div>
  );

  const sections = groupQuestionsBySection(draft.questions);
  const questionsStep = (
    <div className="space-y-4">
      {sections.map((section, sectionIndex) => (
        <WizardSection key={sectionIndex} title={section.name || "Questions"} className="mb-0">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                value={section.name}
                onChange={(event) => setQuestions(renameMoveInSection(draft.questions, section.name, event.target.value))}
                placeholder="Section name"
                aria-label="Section name"
                data-attr="move-in-form-section-name"
              />
              <button
                type="button"
                aria-label={`Delete section ${section.name || sectionIndex + 1}`}
                title="Delete section"
                onClick={() => setQuestions(removeMoveInSection(draft.questions, section.name))}
                className="grid size-11 shrink-0 place-items-center rounded-lg text-foreground/70 transition-colors duration-(--motion-fast) hover:bg-accent hover:text-red-600"
              >
                <Trash2 className="size-[18px]" strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            <ReorderList
              label={`${section.name || "Questions"} questions`}
              items={section.questions}
              onReorder={(next) => setQuestions(reorderMoveInSection(draft.questions, section.name, next.map((q) => q.id)))}
              className="space-y-2 [&>[data-reorder-id]]:flex [&>[data-reorder-id]]:items-start [&>[data-reorder-id]]:gap-1 [&>[data-reorder-id]]:rounded-xl [&>[data-reorder-id]]:border [&>[data-reorder-id]]:border-border [&>[data-reorder-id]]:bg-card [&>[data-reorder-id]]:p-2 [&>[data-reorder-id]>button]:mt-2 [&>[data-reorder-id]>button]:text-muted"
              renderRow={(question) => (
                <QuestionRow
                  key={question.id}
                  question={question}
                  onFocus={() => focusQuestion(question.key)}
                  onPatch={(change) => setQuestions(updateMoveInQuestion(draft.questions, question.id, change))}
                  onDelete={() => setQuestions(removeMoveInQuestion(draft.questions, question.id))}
                />
              )}
            />
            <Button
              type="button"
              variant="outline"
              className="rounded-full"
              onClick={() => setQuestions(addMoveInQuestion(draft.questions, section.name))}
              data-attr="move-in-form-add-question"
            >
              <Plus className="size-4" aria-hidden />
              Question
            </Button>
          </div>
        </WizardSection>
      ))}
      <div className="flex flex-wrap gap-2">
        {draft.questions.length === 0 ? (
          <Button type="button" variant="outline" className="rounded-full" onClick={() => setQuestions(addMoveInQuestion([], ""))} data-attr="move-in-form-add-first-question">
            <Plus className="size-4" aria-hidden />
            Question
          </Button>
        ) : null}
        <Button type="button" variant="outline" className="rounded-full" onClick={() => setQuestions(addMoveInSection(draft.questions))} data-attr="move-in-form-add-section">
          <Plus className="size-4" aria-hidden />
          Section
        </Button>
      </div>
    </div>
  );

  const whoStep = (
    <div className="space-y-4">
      <WizardSection title="Who fills it, and when">
        <div className="space-y-4">
          <WizardSelect
            label="Who"
            value={draft.audience.kind}
            onChange={setAudienceKind}
            options={[
              { value: "every-room", label: "Every room" },
              ...(rooms.length > 0 ? [{ value: "rooms", label: "Some rooms" }] : []),
              { value: "whole-house", label: "The whole house only (one per lease)" },
            ]}
            dataAttr="move-in-form-audience"
          />
          {draft.audience.kind === "rooms" ? (
            <WizardMultiSelect
              label="Rooms"
              options={roomOptions}
              selected={draft.audience.roomIds}
              onChange={(roomIds) => patch({ audience: { kind: "rooms", roomIds } })}
              emptyLabel="Pick rooms"
              dataAttr="move-in-form-rooms"
            />
          ) : null}
          <WizardRow>
            <WizardSelect
              label="Send"
              value={draft.trigger}
              onChange={(value) => patch({ trigger: value as MoveInFormTemplate["trigger"] })}
              options={MOVE_IN_TRIGGER_OPTIONS}
              dataAttr="move-in-form-trigger"
            />
            <WizardSelect
              label="Due"
              value={draft.due}
              onChange={(value) => patch({ due: value as MoveInFormTemplate["due"] })}
              options={MOVE_IN_DUE_OPTIONS}
              dataAttr="move-in-form-due"
            />
          </WizardRow>
          <WizardSelect
            label="Already-signed residents"
            value={sendNow ? "now" : "new"}
            onChange={(value) => setSendNow(value === "now")}
            options={[
              { value: "now", label: "Send to them now too" },
              { value: "new", label: "Only new residents" },
            ]}
            dataAttr="move-in-form-send-existing"
          />
        </div>
      </WizardSection>
    </div>
  );

  const reviewStep = (
    <div className="space-y-1">
      <ReviewCard
        title={isUpload ? "Upload" : "Form"}
        status={problems.form.length ? "incomplete" : "complete"}
        onEdit={() => setStep(0)}
        facts={[
          { label: "Name", value: draft.name.trim() || "Not named", missing: !draft.name.trim() },
          { label: isUpload ? "File" : "Source", value: isUpload ? templateSourceLine(draft) : "Built in PropLane", missing: isUpload && !draft.pdf },
        ]}
      />
      <ReviewCard
        title="Questions"
        status={problems.questions.length ? "incomplete" : "complete"}
        onEdit={() => setStep(1)}
        facts={[
          {
            label: isUpload ? "Asked after the PDF" : "Questions",
            value: `${questionCountLabel(draft.questions.length)} in ${sections.length} section${sections.length === 1 ? "" : "s"}`,
          },
        ]}
      />
      <ReviewCard
        title="Who & when"
        status={problems.who.length ? "incomplete" : "complete"}
        onEdit={() => setStep(2)}
        facts={[
          { label: "Who", value: audienceSummary(draft.audience, rooms) },
          { label: "Send", value: triggerSummary(draft.trigger) },
          { label: "Due", value: MOVE_IN_DUE_OPTIONS.find((option) => option.value === draft.due)?.label ?? "" },
          { label: "Already-signed residents", value: sendNow ? "Sent now too" : "Only new residents" },
        ]}
      />
    </div>
  );

  const bodies = [formStep, questionsStep, whoStep, reviewStep];

  return (
    <AddWorkspace
      title={mode === "add" ? "New move-in form" : `Edit · ${draft.name.trim() || "Untitled form"}`}
      steps={stepsDef}
      current={step}
      onJump={(next) => setStep(next)}
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard changes"
      discardBody="Discard unsaved changes to this form?"
      assistantContext="Move-in form"
      assistantScopeKey="move-in-form-editor"
      numberedSteps
      dataAttrPrefix="move-in-form"
      finishDataAttr="move-in-form-save"
      lastLabel={mode === "add" ? "Create form" : "Save form"}
      lastDisabled={allProblems.length > 0 && showErrors}
      busy={saving}
      onFinish={() => void finish()}
      onBeforeNext={() => {
        if (stepProblems.length > 0) {
          setShowErrors(true);
          return false;
        }
        setShowErrors(false);
        return true;
      }}
      saveState={saving ? "Saving…" : dirty ? "Not saved yet" : mode === "add" ? "Draft" : "Saved"}
      footerNote={
        saveError ? (
          <span className="text-sm text-rose-600" role="alert">
            {saveError}
          </span>
        ) : null
      }
      railHeader={
        <div className="rounded-2xl border border-border bg-card p-3" data-attr="move-in-form-context-card">
          <b className="block truncate text-[14px] text-foreground">{propertyLabel}</b>
          <span className="text-[12.5px] text-muted">Move-in form · {isUpload ? "Uploaded PDF" : "Built in PropLane"}</span>
        </div>
      }
      sidePanel={
        <MoveInFormLivePreview
          name={draft.name}
          source={draft.source}
          questions={draft.questions}
          pdfUrl={pdfUrl}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          answers={previewAnswers}
          onAnswersChange={setPreviewAnswers}
        />
      }
    >
      <div className="motion-wiz-dir-fwd" key={step}>
        {bodies[step]}
        {showErrors && stepProblems.length > 0 ? (
          <ul role="alert" className="mt-3 space-y-0.5 text-sm text-red-600" data-attr="move-in-form-problems">
            {stepProblems.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
        {step === 3 && showErrors && allProblems.length > 0 ? (
          <ul role="alert" className="mt-3 space-y-0.5 text-sm text-red-600" data-attr="move-in-form-problems">
            {allProblems.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </AddWorkspace>
  );
}

/* ───────────────────────────── one question row ───────────────────────────── */

function QuestionRow({
  question,
  onPatch,
  onDelete,
  onFocus,
}: {
  question: MoveInFormQuestion;
  onPatch: (change: Partial<Pick<MoveInFormQuestion, "label" | "type" | "required" | "options" | "description">>) => void;
  onDelete: () => void;
  onFocus: () => void;
}) {
  return (
    <div className="min-w-0 flex-1 space-y-2" data-attr="move-in-form-question-row" onFocusCapture={onFocus}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={question.label}
          onChange={(event) => onPatch({ label: event.target.value })}
          placeholder="Question"
          aria-label="Question"
          className="min-w-[11rem] flex-1"
        />
        <FieldTypeSelect value={question.type} onChange={(type) => onPatch({ type })} />
        <label className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-border accent-primary"
            checked={question.type === "signature" ? true : question.required}
            disabled={question.type === "signature"}
            onChange={(event) => onPatch({ required: event.target.checked })}
          />
          Required
        </label>
        <button
          type="button"
          aria-label="Delete question"
          title="Delete question"
          onClick={onDelete}
          className="grid size-11 shrink-0 place-items-center rounded-lg text-foreground/70 transition-colors duration-(--motion-fast) hover:bg-accent hover:text-red-600"
        >
          <Trash2 className="size-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {questionTypeHasOptions(question.type) ? <OptionsField key={`${question.id}-${question.type}`} question={question} onChange={(options) => onPatch({ options })} /> : null}
    </div>
  );
}

function FieldTypeSelect({ value, onChange }: { value: MoveInFormQuestion["type"]; onChange: (type: MoveInFormQuestion["type"]) => void }) {
  const options = MOVE_IN_QUESTION_TYPE_OPTIONS.some((option) => option.value === value)
    ? MOVE_IN_QUESTION_TYPE_OPTIONS
    : [...MOVE_IN_QUESTION_TYPE_OPTIONS, { value, label: String(value) }];
  return (
    <WizardSelect
      label="Answer type"
      hideLabel
      value={value}
      onChange={(next) => onChange(next as MoveInFormQuestion["type"])}
      options={options}
      wrapperClassName="w-40 shrink-0"
      dataAttr="move-in-form-question-type"
    />
  );
}

/** One choice per line. Typed text is kept as typed; the list is parsed from it on every edit. */
function OptionsField({ question, onChange }: { question: MoveInFormQuestion; onChange: (options: string[]) => void }) {
  const [raw, setRaw] = useState(question.options.join("\n"));
  return (
    <Textarea
      value={raw}
      rows={3}
      aria-label="Choices, one per line"
      placeholder="One choice per line"
      onChange={(event) => {
        setRaw(event.target.value);
        onChange(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean));
      }}
    />
  );
}
