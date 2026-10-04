"use client";

/**
 * One question, edited in place inside the shared question editor: its words, its type, its choices
 * (pick questions), Required, and Done. Delete is a red text button on the left, absent when the
 * system reads the question and it cannot go.
 */
import { OptionRowsEditor } from "@/components/portal/application-question-edit-modal";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import type { QuestionEditorPatch, QuestionEditorQuestion, QuestionEditorType } from "./question-editor-types";

const LABEL_CLASS = "mb-1.5 block text-[12.5px] font-bold normal-case tracking-normal text-foreground";

export function questionTypeUsesChoices(type: string): boolean {
  return type === "select" || type === "multi_select";
}

export function QuestionInlineForm({
  question,
  allowedTypes,
  onPatch,
  onDone,
  onDelete,
  dataAttrPrefix,
}: {
  question: QuestionEditorQuestion;
  allowedTypes: readonly QuestionEditorType[];
  onPatch: (patch: QuestionEditorPatch) => void;
  onDone: () => void;
  onDelete?: () => void;
  dataAttrPrefix: string;
}) {
  const can = question.can ?? {};
  const typeOptions = allowedTypes.some((type) => type.id === question.type)
    ? allowedTypes
    : [...allowedTypes, { id: question.type, label: question.type }];
  const currentTypeLabel = typeOptions.find((type) => type.id === question.type)?.label ?? question.type;
  const canRequired = can.required !== false;
  return (
    <div className="space-y-4 py-3" data-attr={`${dataAttrPrefix}-question-form`}>
      <div>
        <label className={LABEL_CLASS} htmlFor={`${dataAttrPrefix}-label-${question.id}`}>Question</label>
        {can.label === false ? (
          <p className="text-sm text-foreground" data-attr={`${dataAttrPrefix}-question-label-text`}>{question.label}</p>
        ) : (
          <Input
            id={`${dataAttrPrefix}-label-${question.id}`}
            value={question.label}
            onChange={(event) => onPatch({ label: event.target.value })}
            placeholder="e.g. Do you smoke?"
            autoFocus={!question.label}
            data-attr={`${dataAttrPrefix}-question-label`}
          />
        )}
      </div>
      <div>
        {can.type === false ? (
          <div className="flex items-baseline gap-3 text-sm" data-attr={`${dataAttrPrefix}-question-type-text`}>
            <span className="text-[12.5px] font-bold text-foreground">Type</span>
            <span className="text-foreground">{currentTypeLabel}</span>
          </div>
        ) : (
          <FieldSingleSelect
            label="Type"
            labelClassName={LABEL_CLASS}
            value={question.type}
            options={typeOptions.map((type) => ({ value: type.id, label: type.label }))}
            onChange={(next) => onPatch({ type: next })}
            dataAttr={`${dataAttrPrefix}-question-type`}
          />
        )}
      </div>
      {questionTypeUsesChoices(question.type) && can.options !== false ? (
        <div>
          <span className={LABEL_CLASS}>Choices</span>
          <OptionRowsEditor options={question.options} onChange={(options) => onPatch({ options })} />
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">Required</span>
        {canRequired ? (
          <PortalSettingsToggle
            checked={question.required}
            onChange={(next) => onPatch({ required: next })}
            label="Required"
            dataAttr={`${dataAttrPrefix}-question-required`}
          />
        ) : (
          <span className="text-sm text-foreground" data-attr={`${dataAttrPrefix}-question-required-text`}>
            {question.required ? "Required" : "Optional"}
          </span>
        )}
      </div>
      {question.showIfCandidates && question.showIfCandidates.length > 0 ? (
        <div className="space-y-3">
          <FieldSingleSelect
            label="Show only if"
            labelClassName={LABEL_CLASS}
            value={question.showIf?.fieldKey ?? ""}
            options={[
              { value: "", label: "Always shown" },
              ...question.showIfCandidates.map((candidate) => ({ value: candidate.key, label: candidate.label.trim() || "Untitled question" })),
            ]}
            onChange={(fieldKey) => onPatch({ showIf: fieldKey ? { fieldKey, equals: question.showIf?.equals ?? "" } : undefined })}
            dataAttr={`${dataAttrPrefix}-question-showif-field`}
          />
          {question.showIf?.fieldKey ? (
            <div>
              <label className={LABEL_CLASS} htmlFor={`${dataAttrPrefix}-showif-${question.id}`}>is answered</label>
              <Input
                id={`${dataAttrPrefix}-showif-${question.id}`}
                value={question.showIf.equals}
                onChange={(event) => onPatch({ showIf: { fieldKey: question.showIf!.fieldKey, equals: event.target.value } })}
                placeholder="e.g. Yes"
                data-attr={`${dataAttrPrefix}-question-showif-equals`}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {question.error ? (
        <p className="text-sm text-danger" role="alert" data-attr={`${dataAttrPrefix}-question-error`}>{question.error}</p>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        {onDelete ? (
          <button
            type="button"
            className="min-h-11 text-[13px] font-semibold text-danger hover:underline"
            onClick={onDelete}
            data-attr={`${dataAttrPrefix}-question-delete`}
          >
            Delete
          </button>
        ) : <span />}
        <Button type="button" variant="primary" className="rounded-full" onClick={onDone} data-attr={`${dataAttrPrefix}-question-done`}>
          Done
        </Button>
      </div>
    </div>
  );
}
