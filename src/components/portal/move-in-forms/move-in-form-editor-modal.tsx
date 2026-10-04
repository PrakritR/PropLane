"use client";

/**
 * The move-in form editor, in the SAME popup frame as "Edit application" and "Edit lease"
 * (`AddWorkspace`): title, a steps rail ("Form", "Questions"), a thin progress bar, the step in
 * the centre, the resident's live view flush right, and a footer with a red Delete on the left
 * (edit only) and Continue / Save on the right.
 *
 * The Questions step draws every question through `BuilderQuestionCard`, the same row the
 * application editor's Questions step uses, so the two editors share one question UI. The
 * question editor itself is being redesigned in its own plan; this file only mounts it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardMultiSelect } from "@/components/portal/add-workspace/parts";
import { FloatingLabelField, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import { MoveInFormLivePreview, previewScreens } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import {
  audienceSummary,
  cleanMoveInTemplateForSave,
  dueForTriggerChange,
  dueOptionsForTrigger,
  MOVE_IN_TRIGGER_OPTIONS,
  MOVE_OUT_DAYS_CHOICES,
  moveInFormProblemsByStep,
  questionCountLabel,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { PropertyFormWizardCard, PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { moveInFormTemplatePdfUrl, uploadMoveInFormPdf } from "@/lib/move-in-forms/client";
import { isDefaultMoveInForm, MOVE_IN_FORM_STARTERS, newMoveInFormTemplate, resetMoveInFormToDefault } from "@/lib/move-in-forms/templates";
import type {
  MoveInFormAudience,
  MoveInFormMoveOutDays,
  MoveInFormQuestion,
  MoveInFormStarterKey,
  MoveInFormTemplate,
} from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

const MAX_PDF_BYTES = 8 * 1024 * 1024;

export type MoveInEditorRoom = { id: string; label: string };
/** An application or lease template of this property a form can be linked to. */
export type MoveInEditorLinkOption = { id: string; label: string };
export type MoveInEditorSaveOptions = { sendToCurrent: boolean };

function deriveFormName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "";
}

const STARTS_FROM_OPTIONS = [
  { value: "blank", label: "Blank form" },
  { value: "upload", label: "Upload a PDF" },
  ...MOVE_IN_FORM_STARTERS.map((starter) => ({ value: starter.starterKey ?? starter.id, label: starter.name })),
];

export function MoveInFormEditorModal({
  mode,
  initial,
  rooms,
  applicationTemplates = [],
  leaseTemplates = [],
  propertyId,
  startStep = 0,
  onSave,
  onDelete,
  onClose,
  canUploadPdf = true,
}: {
  mode: "add" | "edit";
  initial: MoveInFormTemplate;
  rooms: readonly MoveInEditorRoom[];
  /** This property's application forms, for "Linked application". */
  applicationTemplates?: readonly MoveInEditorLinkOption[];
  /** This property's leases, for "Linked lease". */
  leaseTemplates?: readonly MoveInEditorLinkOption[];
  propertyId: string;
  /** Preview from a row's menu opens on Questions (the live view is always on the right); Edit opens on Form. */
  startStep?: number;
  /** Writes the form to the property. Resolves true on success, after which the editor closes. */
  onSave: (template: MoveInFormTemplate, options: MoveInEditorSaveOptions) => Promise<boolean>;
  /** Edit only: removes the form from the property. Resolves true on success, after which the editor closes. */
  onDelete?: (template: MoveInFormTemplate) => Promise<boolean>;
  onClose: () => void;
  /** Only the property's owner stores the original PDF; a co-manager builds the form but cannot upload. */
  canUploadPdf?: boolean;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<MoveInFormTemplate>(() => structuredClone(initial));
  const [step, setStep] = useState(Math.min(Math.max(startStep, 0), 2));
  const [showErrors, setShowErrors] = useState(false);
  const [sendNow, setSendNow] = useState(mode === "add");
  // "Send to current residents now" only makes sense for the two sends that residents are already past.
  const sendsToExistingResidents = draft.trigger === "lease-signed" || draft.trigger === "application-approved";
  const isDefaultForm = isDefaultMoveInForm(initial);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startsFrom, setStartsFrom] = useState<string>(initial.source === "upload" && mode === "add" ? "upload" : (initial.starterKey ?? "blank"));
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
  const applicationOptions = useMemo(() => applicationTemplates.map((item) => ({ value: item.id, label: item.label })), [applicationTemplates]);
  const leaseOptions = useMemo(() => leaseTemplates.map((item) => ({ value: item.id, label: item.label })), [leaseTemplates]);

  const patch = (next: Partial<MoveInFormTemplate>) => setDraft((prev) => ({ ...prev, ...next }));
  const setQuestions = (questions: MoveInFormQuestion[]) => patch({ questions });

  const stepsDef: AddWorkspaceStep[] = [
    {
      id: "form",
      label: "Form",
      summary: draft.name.trim() || "Name this form",
      incomplete: problems.form.length > 0,
    },
    {
      id: "questions",
      label: "Questions",
      summary: questionCountLabel(draft.questions.length),
      incomplete: problems.questions.length > 0,
    },
    {
      id: "who-when",
      label: "Who & when",
      summary: MOVE_IN_TRIGGER_OPTIONS.find((option) => option.value === draft.trigger)?.label ?? "",
      incomplete: problems.who.length > 0,
    },
  ];

  const stepProblems = (step === 0 ? problems.form : step === 1 ? problems.questions : problems.who) as string[];

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

  /** "Start from": a blank form, an uploaded PDF, or one of the starters. Add mode only, like the application's. */
  const changeStartsFrom = (value: string) => {
    const previous = MOVE_IN_FORM_STARTERS.find((starter) => (starter.starterKey ?? starter.id) === startsFrom);
    setStartsFrom(value);
    setPreviewIndex(0);
    setPreviewAnswers({});
    if (value === "upload") {
      setDraft((prev) => ({
        ...prev,
        source: "upload",
        questions: newMoveInFormTemplate("upload").questions,
        starterKey: undefined,
        pdf: prev.pdf ?? null,
      }));
      return;
    }
    const starter = MOVE_IN_FORM_STARTERS.find((item) => (item.starterKey ?? item.id) === value);
    setDraft((prev) => {
      const keepName = prev.name.trim() && prev.name !== previous?.name;
      if (!starter) return { ...prev, source: "built", pdf: null, questions: [], starterKey: undefined };
      return {
        ...prev,
        source: "built",
        pdf: null,
        questions: structuredClone(starter.questions),
        name: keepName ? prev.name : starter.name,
        trigger: starter.trigger,
        due: starter.due,
        starterKey: value as MoveInFormStarterKey,
      };
    });
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
    // A form that only goes out when the manager sends it is never pushed to residents by saving it.
    const ok = await onSave(cleanMoveInTemplateForSave(draft), { sendToCurrent: sendNow && sendsToExistingResidents });
    setSaving(false);
    if (ok) onClose();
    else setSaveError("Could not save this form. Try again.");
  };

  const remove = async () => {
    if (!onDelete) return;
    if (!(await confirm({ description: "Delete this move-in form?" }))) return;
    setSaving(true);
    setSaveError(null);
    const ok = await onDelete(initial);
    setSaving(false);
    if (ok) onClose();
    else setSaveError("Could not delete this form. Try again.");
  };

  const resetToDefault = async () => {
    if (!(await confirm({ description: "Reset this form to its default questions? Your own questions are replaced." }))) return;
    setDraft((prev) => resetMoveInFormToDefault(prev));
    setPreviewIndex(0);
    setPreviewAnswers({});
  };

  const focusQuestion = (key: string) => {
    const screens = previewScreens(draft.source, draft.questions, previewAnswers);
    const at = screens.findIndex((screen) => screen.kind === "question" && screen.question.key === key);
    if (at >= 0) setPreviewIndex(at);
  };

  /* ───────────── step bodies ───────────── */

  const setTrigger = (value: string) => {
    const trigger = value as MoveInFormTemplate["trigger"];
    patch({ trigger, due: dueForTriggerChange(trigger, draft.due) });
  };

  const sectionOptions = (
    <>
      <PropertyFormWizardRow label="Sends">
        <FieldSingleSelect
          hideLabel
          label="Sends"
          labelClassName={WIZARD_LABEL_CLASS}
          variant="cell"
          className="min-w-[200px] max-w-[280px]"
          value={draft.trigger}
          onChange={setTrigger}
          options={MOVE_IN_TRIGGER_OPTIONS}
          dataAttr="move-in-form-trigger"
        />
      </PropertyFormWizardRow>
      {draft.trigger === "before-move-out" ? (
        <PropertyFormWizardRow label="Days before the lease ends">
          <FieldSingleSelect
            hideLabel
            label="Days before the lease ends"
            labelClassName={WIZARD_LABEL_CLASS}
            variant="cell"
            className="min-w-[200px] max-w-[280px]"
            value={String(draft.moveOutDaysBefore)}
            onChange={(value) => patch({ moveOutDaysBefore: Number(value) as MoveInFormMoveOutDays })}
            options={MOVE_OUT_DAYS_CHOICES}
            dataAttr="move-in-form-move-out-days"
          />
        </PropertyFormWizardRow>
      ) : null}
      <PropertyFormWizardRow label="Due">
        <FieldSingleSelect
          hideLabel
          label="Due"
          labelClassName={WIZARD_LABEL_CLASS}
          variant="cell"
          className="min-w-[200px] max-w-[280px]"
          value={draft.due}
          onChange={(value) => patch({ due: value as MoveInFormTemplate["due"] })}
          options={dueOptionsForTrigger(draft.trigger)}
          dataAttr="move-in-form-due"
        />
      </PropertyFormWizardRow>
      {applicationOptions.length > 0 ? (
        <PropertyFormWizardRow label="Linked application">
          <WizardMultiSelect
            hideLabel
            label="Linked application"
            options={applicationOptions}
            selected={draft.linkedApplicationTemplateIds}
            onChange={(linkedApplicationTemplateIds) => patch({ linkedApplicationTemplateIds })}
            emptyLabel="All applications"
            dataAttr="move-in-form-linked-applications"
          />
        </PropertyFormWizardRow>
      ) : null}
      {leaseOptions.length > 0 ? (
        <PropertyFormWizardRow label="Linked lease">
          <WizardMultiSelect
            hideLabel
            label="Linked lease"
            options={leaseOptions}
            selected={draft.linkedLeaseTemplateIds}
            onChange={(linkedLeaseTemplateIds) => patch({ linkedLeaseTemplateIds })}
            emptyLabel="All leases"
            dataAttr="move-in-form-linked-leases"
          />
        </PropertyFormWizardRow>
      ) : null}
      <PropertyFormWizardRow label="Who">
        <FieldSingleSelect
          hideLabel
          label="Who"
          labelClassName={WIZARD_LABEL_CLASS}
          variant="cell"
          className="min-w-[200px] max-w-[280px]"
          value={draft.audience.kind}
          onChange={setAudienceKind}
          options={[
            { value: "every-room", label: "Every room" },
            ...(rooms.length > 0 ? [{ value: "rooms", label: "Some rooms" }] : []),
            { value: "whole-house", label: "The whole house only (one per lease)" },
          ]}
          dataAttr="move-in-form-audience"
        />
      </PropertyFormWizardRow>
      {draft.audience.kind === "rooms" ? (
        <PropertyFormWizardRow label="Rooms">
          <WizardMultiSelect
            hideLabel
            label="Rooms"
            options={roomOptions}
            selected={draft.audience.roomIds}
            onChange={(roomIds) => patch({ audience: { kind: "rooms", roomIds } })}
            emptyLabel="Pick rooms"
            dataAttr="move-in-form-rooms"
          />
        </PropertyFormWizardRow>
      ) : null}
      {sendsToExistingResidents ? (
        <PropertyFormWizardRow label="Already-signed residents">
          <FieldSingleSelect
            hideLabel
            label="Already-signed residents"
            labelClassName={WIZARD_LABEL_CLASS}
            variant="cell"
            className="min-w-[200px] max-w-[280px]"
            value={sendNow ? "now" : "new"}
            onChange={(value) => setSendNow(value === "now")}
            options={[
              { value: "now", label: "Send to them now too" },
              { value: "new", label: "Only new residents" },
            ]}
            dataAttr="move-in-form-send-existing"
          />
        </PropertyFormWizardRow>
      ) : null}
    </>
  );

  const formStep = (
    <StepColumn>
      <StepHeading title="Form" />
      <div className="mb-4">
        <FloatingLabelField
          id="move-in-form-name"
          label="Form name"
          placeholder="Form name"
          value={draft.name}
          error={showErrors && !draft.name.trim() ? "Name this form." : null}
          dataAttr="move-in-form-name"
          onChange={(next) => patch({ name: next })}
        />
      </div>
      {mode === "add" ? (
      <PropertyFormWizardCard dataAttr="move-in-form-step-one-card">
          <PropertyFormWizardRow label="Start from">
            <FieldSingleSelect
              hideLabel
              label="Start from"
              labelClassName={WIZARD_LABEL_CLASS}
              variant="cell"
              className="min-w-[200px] max-w-[280px]"
              value={startsFrom}
              onChange={changeStartsFrom}
              options={canUploadPdf ? STARTS_FROM_OPTIONS : STARTS_FROM_OPTIONS.filter((option) => option.value !== "upload")}
              dataAttr="move-in-form-starts-from"
            />
          </PropertyFormWizardRow>
      </PropertyFormWizardCard>
      ) : null}
      {isUpload ? (
        <div className="mt-4 space-y-2">
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
              {canUploadPdf ? (
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
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              disabled={uploading || !canUploadPdf}
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (canUploadPdf) void pickPdf(event.dataTransfer.files?.[0]);
              }}
              data-attr="move-in-form-pdf-drop"
              className={cn(
                "grid w-full place-items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-9 text-sm font-semibold text-foreground transition-colors duration-(--motion-base) ease-(--motion-crossfade)",
                dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40 hover:bg-accent/40",
              )}
            >
              <Upload className={cn("size-6 text-muted transition-transform duration-(--motion-base)", dragging && "-translate-y-0.5 text-primary")} aria-hidden />
              {!canUploadPdf ? "Only the property owner can upload the PDF" : uploading ? "Uploading…" : "Drop a PDF here or browse"}
            </button>
          )}
          {uploadError ? (
            <p role="alert" className="text-sm text-red-600">
              {uploadError}
            </p>
          ) : null}
        </div>
      ) : null}
    </StepColumn>
  );

  const questionsStep = (
    <StepColumn>
      <StepHeading title="Questions" />
      <MoveInQuestionsEditor questions={draft.questions} onChange={setQuestions} onFocusQuestion={focusQuestion} />
    </StepColumn>
  );

  const whoWhenStep = (
    <StepColumn>
      <StepHeading title="Who & when" />
      <PropertyFormWizardCard dataAttr="move-in-form-who-when-card">{sectionOptions}</PropertyFormWizardCard>
    </StepColumn>
  );

  const bodies = [formStep, questionsStep, whoWhenStep];

  return (
    <AddWorkspace
      title={mode === "add" ? "Add move-in form" : "Edit move-in form"}
      steps={stepsDef}
      current={step}
      onJump={(next) => setStep(next)}
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard changes"
      discardBody="Discard unsaved changes to this move-in form?"
      assistantContext={mode === "add" ? "Add move-in form" : "Edit move-in form"}
      assistantScopeKey="move-in-form-editor"
      dataAttrPrefix="move-in-form"
      finishDataAttr="move-in-form-save"
      lastLabel={mode === "add" ? "Create form" : "Save"}
      lastDisabled={saving || (mode === "edit" && !dirty) || (allProblems.length > 0 && showErrors)}
      busy={saving}
      hideFooterStepCount
      onFinish={() => void finish()}
      onBeforeNext={() => {
        if (stepProblems.length > 0) {
          setShowErrors(true);
          return false;
        }
        setShowErrors(false);
        return true;
      }}
      saveState={saving ? "Saving…" : dirty || mode === "add" ? "Not saved yet" : "Saved"}
      footerNote={
        saveError ? (
          <span className="text-sm text-rose-600" role="alert">
            {saveError}
          </span>
        ) : null
      }
      dangerAction={
        mode === "edit" && isDefaultForm ? (
          <button
            type="button"
            className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
            data-attr="move-in-form-reset-default"
            disabled={saving}
            onClick={() => void resetToDefault()}
          >
            Reset to default questions
          </button>
        ) : mode === "edit" && onDelete ? (
          <button
            type="button"
            className="min-h-[44px] rounded-full border border-red-200 bg-card px-6 text-[14px] font-bold text-red-700 disabled:opacity-45"
            data-attr="move-in-form-delete"
            disabled={saving}
            onClick={() => void remove()}
          >
            Delete
          </button>
        ) : null
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
      </div>
    </AddWorkspace>
  );
}
