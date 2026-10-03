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
import { FileText, Plus, Upload } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WizardMultiSelect } from "@/components/portal/add-workspace/parts";
import { BuilderQuestionCard } from "@/components/portal/application-form-builder";
import type { ExtraQuestionType } from "@/components/portal/application-question-edit-modal";
import { FloatingLabelField, StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { MoveInFormLivePreview, previewScreens } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import {
  addMoveInQuestion,
  addMoveInSection,
  audienceSummary,
  cleanMoveInTemplateForSave,
  groupQuestionsBySection,
  MOVE_IN_DUE_OPTIONS,
  MOVE_IN_TRIGGER_OPTIONS,
  moveInFormProblemsByStep,
  moveMoveInQuestion,
  questionCountLabel,
  removeMoveInQuestion,
  removeMoveInSection,
  renameMoveInSection,
  updateMoveInQuestion,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS, PortalCollapsibleEditRow } from "@/components/portal/portal-collapsible-edit-row";
import { PropertyFormWizardCard, PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { useConfirm } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import type { ManagerCustomApplicationFieldType } from "@/lib/manager-listing-submission";
import type { ResolvedApplicationField } from "@/lib/rental-application/application-field-catalog";
import { moveInFormTemplatePdfUrl, uploadMoveInFormPdf } from "@/lib/move-in-forms/client";
import { MOVE_IN_FORM_STARTERS, newMoveInFormTemplate } from "@/lib/move-in-forms/templates";
import type {
  MoveInFormAudience,
  MoveInFormQuestion,
  MoveInFormStarterKey,
  MoveInFormTemplate,
} from "@/lib/move-in-forms/types";
import { cn } from "@/lib/utils";

const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** What move-in forms add to the application's answer types. */
const MOVE_IN_EXTRA_TYPES: readonly ExtraQuestionType[] = [
  { id: "photos", label: "Photos" },
  { id: "signature", label: "Signature" },
];

/** The shared question row speaks the application's field shape; a move-in question is that plus a signature type. */
function asField(question: MoveInFormQuestion): ResolvedApplicationField {
  return { ...question, type: question.type as ManagerCustomApplicationFieldType, isStandard: false };
}

export type MoveInEditorRoom = { id: string; label: string };
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
  const [step, setStep] = useState(Math.min(Math.max(startStep, 0), 1));
  const [showErrors, setShowErrors] = useState(false);
  const [sendNow, setSendNow] = useState(mode === "add");
  const sendsItself = draft.trigger !== "manual";
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [startsFrom, setStartsFrom] = useState<string>(initial.source === "upload" && mode === "add" ? "upload" : (initial.starterKey ?? "blank"));
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewAnswers, setPreviewAnswers] = useState<MoveInAnswerMap>({});
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<ReadonlySet<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
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
      label: "Form",
      summary: draft.name.trim() || "Name this form",
      incomplete: problems.form.length > 0 || problems.who.length > 0,
    },
    {
      id: "questions",
      label: "Questions",
      summary: questionCountLabel(draft.questions.length),
      incomplete: problems.questions.length > 0,
    },
  ];

  const stepProblems = (step === 0 ? [...problems.form, ...problems.who] : problems.questions) as string[];

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
    const ok = await onSave(cleanMoveInTemplateForSave(draft), { sendToCurrent: sendNow && sendsItself });
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

  const focusQuestion = (key: string) => {
    const screens = previewScreens(draft.source, draft.questions, previewAnswers);
    const at = screens.findIndex((screen) => screen.kind === "question" && screen.question.key === key);
    if (at >= 0) setPreviewIndex(at);
  };

  const toggleQuestion = (id: string) =>
    setExpandedQuestionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addQuestionTo = (sectionName: string) => {
    const next = addMoveInQuestion(draft.questions, sectionName);
    const created = next.find((q) => !draft.questions.some((existing) => existing.id === q.id));
    setQuestions(next);
    if (created) {
      setExpandedQuestionIds((prev) => new Set(prev).add(created.id));
      setCollapsedSections((prev) => {
        const out = new Set(prev);
        out.delete(sectionName);
        return out;
      });
    }
  };

  /* ───────────── step bodies ───────────── */

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
          onChange={(value) => patch({ trigger: value as MoveInFormTemplate["trigger"] })}
          options={MOVE_IN_TRIGGER_OPTIONS}
          dataAttr="move-in-form-trigger"
        />
      </PropertyFormWizardRow>
      <PropertyFormWizardRow label="Due">
        <FieldSingleSelect
          hideLabel
          label="Due"
          labelClassName={WIZARD_LABEL_CLASS}
          variant="cell"
          className="min-w-[200px] max-w-[280px]"
          value={draft.due}
          onChange={(value) => patch({ due: value as MoveInFormTemplate["due"] })}
          options={MOVE_IN_DUE_OPTIONS}
          dataAttr="move-in-form-due"
        />
      </PropertyFormWizardRow>
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
      {sendsItself ? (
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
      <PropertyFormWizardCard dataAttr="move-in-form-step-one-card">
        {mode === "add" ? (
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
        ) : null}
        {sectionOptions}
      </PropertyFormWizardCard>
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

  const sections = groupQuestionsBySection(draft.questions);
  const questionsStep = (
    <StepColumn>
      <StepHeading title="Questions" />
      <div className="space-y-2">
        {sections.map((section, sectionIndex) => {
          const sectionKey = section.name;
          const expanded = !collapsedSections.has(sectionKey);
          return (
            <PortalCollapsibleEditRow
              key={sectionIndex}
              title={section.name || "Questions"}
              subtitle={questionCountLabel(section.questions.length)}
              expanded={expanded}
              onExpandedChange={(next) =>
                setCollapsedSections((prev) => {
                  const out = new Set(prev);
                  if (next) out.delete(sectionKey);
                  else out.add(sectionKey);
                  return out;
                })
              }
              onRemove={sections.length > 1 || section.name ? () => setQuestions(removeMoveInSection(draft.questions, section.name)) : undefined}
              removeIconOnly
              removeTitle="Remove section"
              removeDataAttr="move-in-form-section-remove"
              headerActions={
                <button
                  type="button"
                  className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
                  title="Add question"
                  aria-label="Add question"
                  data-attr="move-in-form-add-question"
                  onClick={() => addQuestionTo(section.name)}
                >
                  <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                </button>
              }
              toggleDataAttr={`move-in-form-section-toggle-${sectionIndex}`}
              contentClassName="space-y-2"
            >
              {sections.length > 1 || section.name ? (
                <Input
                  value={section.name}
                  onChange={(event) => setQuestions(renameMoveInSection(draft.questions, section.name, event.target.value))}
                  placeholder="Section name"
                  aria-label="Section name"
                  data-attr="move-in-form-section-name"
                />
              ) : null}
              {section.questions.map((question, index) => (
                <div key={question.id} onFocusCapture={() => focusQuestion(question.key)}>
                  <BuilderQuestionCard
                    field={asField(question)}
                    allFields={draft.questions.map(asField)}
                    expanded={expandedQuestionIds.has(question.id)}
                    onToggleExpand={() => toggleQuestion(question.id)}
                    onRemove={() => setQuestions(removeMoveInQuestion(draft.questions, question.id))}
                    onPatch={(change) =>
                      setQuestions(updateMoveInQuestion(draft.questions, question.id, change as Parameters<typeof updateMoveInQuestion>[2]))
                    }
                    canMoveUp={index > 0}
                    canMoveDown={index < section.questions.length - 1}
                    onMoveUp={() => setQuestions(moveMoveInQuestion(draft.questions, question.id, "up"))}
                    onMoveDown={() => setQuestions(moveMoveInQuestion(draft.questions, question.id, "down"))}
                    availableSections={[]}
                    onMoveToSection={() => {}}
                    extraTypes={MOVE_IN_EXTRA_TYPES}
                    sampleLabel="Resident sees"
                    hideSampleForTypes={["signature"]}
                  />
                </div>
              ))}
            </PortalCollapsibleEditRow>
          );
        })}
        {draft.questions.length === 0 ? (
          <button
            type="button"
            className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
            data-attr="move-in-form-add-first-question"
            onClick={() => addQuestionTo("")}
          >
            + Add question
          </button>
        ) : null}
        <button
          type="button"
          className="flex min-h-[44px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-card text-sm font-semibold text-primary"
          data-attr="move-in-form-add-section"
          onClick={() => setQuestions(addMoveInSection(draft.questions))}
        >
          + Add section
        </button>
      </div>
    </StepColumn>
  );

  const bodies = [formStep, questionsStep];

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
        mode === "edit" && onDelete ? (
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
