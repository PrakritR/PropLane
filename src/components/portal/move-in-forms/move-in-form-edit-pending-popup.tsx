"use client";

/**
 * Edit a move-in form that is still waiting on the resident: due date, what it blocks, and its
 * questions. The standard popup (`AddWorkspace`, the same frame as Edit move-in form and Edit lease):
 * step rail, step in the centre, the resident's live view flush right, Save on the right. Saving is
 * `PATCH /api/move-in-forms/:id`, which answers 409 once the resident has submitted, so a form that
 * was filed while this was open stays locked and the manager is told.
 */
import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, workspaceSaveState, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading, StepRail } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { MoveInFormFrame, MoveInFormResidentCard } from "@/components/portal/move-in-forms/move-in-form-frame";
import { MoveInFormLivePreview, previewScreens } from "@/components/portal/move-in-forms/move-in-form-live-preview";
import { questionCountLabel, type MoveInAnswerMap } from "@/components/portal/move-in-forms/move-in-form-model";
import { MoveInQuestionsEditor } from "@/components/portal/move-in-forms/move-in-questions-editor";
import { PropertyFormWizardCard, PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { editMoveInForm, getMoveInForm } from "@/lib/move-in-forms/client";
import { pacificDay } from "@/lib/move-in-forms/manager-rows";
import { moveInFormDueAt } from "@/lib/move-in-forms/templates";
import {
  MOVE_IN_FORM_BLOCKS,
  MOVE_IN_FORM_BLOCKS_LABELS,
  resolveMoveInFormBlocks,
  type MoveInFormBlocks,
  type MoveInFormQuestion,
  type MoveInFormRecord,
  type MoveInFormSummary,
} from "@/lib/move-in-forms/types";

const BLOCK_OPTIONS = MOVE_IN_FORM_BLOCKS.map((value) => ({ value, label: MOVE_IN_FORM_BLOCKS_LABELS[value] }));

export function EditPendingMoveInFormPopup({ form, onClose }: { form: MoveInFormSummary; onClose: () => void }) {
  const [record, setRecord] = useState<MoveInFormRecord | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getMoveInForm(form.id)
      .then((value) => {
        if (!cancelled) setRecord(value.form);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error && error.message ? error.message : "Could not load this form.");
      });
    return () => {
      cancelled = true;
    };
  }, [form.id, attempt]);

  if (!record) {
    return (
      <MoveInFormFrame
        title="Edit form"
        onClose={onClose}
        assistantContext="Edit a pending move-in form"
        assistantScopeKey="move-in-form-edit-pending"
        dataAttr="move-in-form-edit-popup"
        rail={<StepRail steps={[{ id: "details", label: "Details" }]} current={0} onJump={() => {}} />}
        footer={
          <Button type="button" variant="ghost" className="min-h-[44px] rounded-full px-6" onClick={onClose}>
            Close
          </Button>
        }
      >
        {loadError ? (
          <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center">
            <p className="mb-3 text-sm font-semibold text-foreground">{loadError}</p>
            <Button
              variant="outline"
              onClick={() => {
                setLoadError("");
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading form" className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-accent/50 motion-reduce:animate-none" />
            ))}
          </div>
        )}
      </MoveInFormFrame>
    );
  }
  return <PendingFormEditor record={record} onClose={onClose} />;
}

function PendingFormEditor({ record, onClose }: { record: MoveInFormRecord; onClose: () => void }) {
  const { showToast } = useAppUi();
  const initialBlocks = resolveMoveInFormBlocks(record.snapshot.blocks, record.snapshot.kind);
  const initialDue = pacificDay(record.dueAt);
  const [questions, setQuestions] = useState<MoveInFormQuestion[]>(() => structuredClone(record.snapshot.questions));
  const [blocks, setBlocks] = useState<MoveInFormBlocks>(initialBlocks);
  const [due, setDue] = useState(initialDue);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [baseline] = useState(() => JSON.stringify(record.snapshot.questions));
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewAnswers, setPreviewAnswers] = useState<MoveInAnswerMap>({});

  const dirty = blocks !== initialBlocks || due !== initialDue || JSON.stringify(questions) !== baseline;
  const problems = useMemo(() => {
    const list: string[] = [];
    if (record.source === "built" && questions.length === 0) list.push("Add at least one question.");
    if (questions.some((q) => !q.label.trim())) list.push("Every question needs words.");
    if (questions.some((q) => (q.type === "select" || q.type === "multi_select") && q.options.filter((o) => o.trim()).length < 2)) {
      list.push("A pick question needs at least two choices.");
    }
    if (record.source === "upload" && !questions.some((q) => q.type === "signature")) list.push("Add the signature.");
    return list;
  }, [questions, record.source]);

  const steps: AddWorkspaceStep[] = [
    { id: "details", label: "Details", summary: `${MOVE_IN_FORM_BLOCKS_LABELS[blocks]}${due ? "" : " · No due date"}` },
    { id: "questions", label: "Questions", summary: questionCountLabel(questions.length), incomplete: problems.length > 0 },
  ];

  const focusQuestion = (key: string) => {
    const at = previewScreens(record.source, questions, previewAnswers).findIndex((s) => s.kind === "question" && s.question.key === key);
    if (at >= 0) setPreviewIndex(at);
  };

  const save = async () => {
    if (problems.length > 0) {
      setStep(1);
      setSaveError(problems[0]!);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await editMoveInForm(record.id, {
        ...(due !== initialDue ? { dueAt: due ? moveInFormDueAt("move-in-day", due) : null } : {}),
        ...(blocks !== initialBlocks ? { blocks } : {}),
        ...(JSON.stringify(questions) !== baseline
          ? { questions: questions.map((q) => ({ ...q, label: q.label.trim() })) }
          : {}),
      });
      showToast("Form updated");
      onClose();
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : "Could not save this form.");
      setSaving(false);
    }
  };

  const detailsStep = (
    <StepColumn>
      <StepHeading title="Details" />
      <PropertyFormWizardCard dataAttr="move-in-form-edit-details-card">
        <PropertyFormWizardRow label="Due">
          <Input
            type="date"
            className="portal-modal-date-input min-w-[200px] max-w-[280px]"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            data-attr="move-in-form-edit-due"
          />
        </PropertyFormWizardRow>
        <PropertyFormWizardRow label="Blocks">
          <FieldSingleSelect
            hideLabel
            label="Blocks"
            labelClassName={WIZARD_LABEL_CLASS}
            variant="cell"
            className="min-w-[200px] max-w-[280px]"
            value={blocks}
            onChange={(value) => setBlocks(value as MoveInFormBlocks)}
            options={BLOCK_OPTIONS}
            dataAttr="move-in-form-edit-blocks"
          />
        </PropertyFormWizardRow>
      </PropertyFormWizardCard>
    </StepColumn>
  );
  const questionsStep = (
    <StepColumn>
      <StepHeading title="Questions" />
      <MoveInQuestionsEditor questions={questions} onChange={setQuestions} onFocusQuestion={focusQuestion} />
    </StepColumn>
  );

  return (
    <AddWorkspace
      title={`Edit ${record.formName}`}
      steps={steps}
      current={step}
      onJump={setStep}
      onClose={onClose}
      dirty={dirty}
      discardTitle="Discard changes"
      discardBody="Discard unsaved changes to this form?"
      assistantContext="Edit a pending move-in form"
      assistantScopeKey="move-in-form-edit-pending"
      railHeader={<MoveInFormResidentCard name={record.residentName} place={[record.propertyLabel, record.roomLabel].filter(Boolean).join(" · ")} />}
      dataAttrPrefix="move-in-form-edit"
      finishDataAttr="move-in-form-edit-save"
      lastLabel="Save"
      lastDisabled={saving || !dirty}
      busy={saving}
      hideFooterStepCount
      onFinish={() => void save()}
      saveState={workspaceSaveState({ busy: saving, dirty, isNew: false })}
      footerNote={
        saveError ? (
          <span className="text-sm text-rose-600" role="alert">
            {saveError}
          </span>
        ) : null
      }
      sidePanel={
        <MoveInFormLivePreview
          name={record.formName}
          source={record.source}
          questions={questions}
          pdfUrl={null}
          index={previewIndex}
          answers={previewAnswers}
          onAnswersChange={setPreviewAnswers}
        />
      }
    >
      <div className="motion-wiz-dir-fwd" key={step}>
        {step === 0 ? detailsStep : questionsStep}
      </div>
    </AddWorkspace>
  );
}
