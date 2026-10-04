"use client";

/**
 * One question, edited in place inside the shared question editor: its words, its type, its choices
 * (pick questions), Required, and Done. Delete is a red text button on the left, absent when the
 * system reads the question and it cannot go.
 */
import { useState } from "react";
import { X } from "lucide-react";
import { OptionRowsEditor } from "@/components/portal/application-question-edit-modal";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import {
  linkedFormKey,
  mintLinkedFormRuleId,
  whenOptionLabel,
  whenOptionsForQuestionType,
  type LinkedFormRule,
} from "@/lib/application-linked-forms";
import type { LinkedFormOption, QuestionEditorPatch, QuestionEditorQuestion, QuestionEditorType } from "./question-editor-types";

const LABEL_CLASS = "mb-1.5 block text-[12.5px] font-bold normal-case tracking-normal text-foreground";

export function questionTypeUsesChoices(type: string): boolean {
  return type === "select" || type === "multi_select";
}

export function QuestionInlineForm({
  question,
  allowedTypes,
  linkedFormOptions,
  onPatch,
  onDone,
  onDelete,
  dataAttrPrefix,
}: {
  question: QuestionEditorQuestion;
  allowedTypes: readonly QuestionEditorType[];
  /** Forms this question can link. Absent hides the Linked forms block. */
  linkedFormOptions?: readonly LinkedFormOption[];
  onPatch: (patch: QuestionEditorPatch) => void;
  onDone: () => void;
  onDelete?: () => void;
  dataAttrPrefix: string;
}) {
  const can = question.can ?? {};
  // A built-in whose words are cleared reads as its default again; keep what is being typed until the field loses focus.
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  // A built-in the system reads by key asks before its type changes (the change detaches it).
  const [pendingType, setPendingType] = useState<string | null>(null);
  const typeOptions = allowedTypes.some((type) => type.id === question.type)
    ? allowedTypes
    : [...allowedTypes, { id: question.type, label: question.type }];
  const currentTypeLabel = typeOptions.find((type) => type.id === question.type)?.label ?? question.type;
  const canRequired = can.required !== false;
  return (
    <div className="space-y-4 py-3" data-attr={`${dataAttrPrefix}-question-form`} data-question-id={question.id}>
      <div>
        <label className={LABEL_CLASS} htmlFor={`${dataAttrPrefix}-label-${question.id}`}>Question</label>
        {can.label === false ? (
          <p className="text-sm text-foreground" data-attr={`${dataAttrPrefix}-question-label-text`}>{question.label}</p>
        ) : (
          <Input
            id={`${dataAttrPrefix}-label-${question.id}`}
            value={labelDraft ?? question.label}
            onChange={(event) => {
              setLabelDraft(event.target.value);
              onPatch({ label: event.target.value });
            }}
            onBlur={() => setLabelDraft(null)}
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
            onChange={(next) => {
              if (next === question.type) return;
              if (question.systemRead) setPendingType(next);
              else onPatch({ type: next });
            }}
            dataAttr={`${dataAttrPrefix}-question-type`}
          />
        )}
        {pendingType && question.systemRead ? (
          <TypeChangeConfirm
            label={question.label.trim() || "this question"}
            feature={question.systemRead.feature}
            fromLabel={currentTypeLabel}
            toLabel={typeOptions.find((type) => type.id === pendingType)?.label ?? pendingType}
            onKeep={() => setPendingType(null)}
            onConfirm={() => {
              const next = pendingType;
              setPendingType(null);
              onPatch({ type: next });
            }}
            dataAttrPrefix={dataAttrPrefix}
          />
        ) : null}
      </div>
      {questionTypeUsesChoices(question.type) && can.options !== false ? (
        <div>
          <span className={LABEL_CLASS}>Choices</span>
          <OptionRowsEditor options={question.options} onChange={(options) => onPatch({ options })} reword={can.fixedOptions === true} />
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
      {linkedFormOptions ? (
        <LinkedFormsBlock
          question={question}
          options={linkedFormOptions}
          onChange={(linkedForms) => onPatch({ linkedForms })}
          dataAttrPrefix={dataAttrPrefix}
        />
      ) : null}
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

function TypeChangeConfirm({
  label,
  feature,
  fromLabel,
  toLabel,
  onKeep,
  onConfirm,
  dataAttrPrefix,
}: {
  label: string;
  feature: string;
  fromLabel: string;
  toLabel: string;
  onKeep: () => void;
  onConfirm: () => void;
  dataAttrPrefix: string;
}) {
  const sentenceFeature = feature.charAt(0).toUpperCase() + feature.slice(1);
  return (
    <div
      className="mt-3 space-y-3 rounded-xl border border-border bg-card px-3 py-3"
      role="alertdialog"
      aria-label={`Change ${label} to ${toLabel}`}
      data-attr={`${dataAttrPrefix}-question-type-confirm`}
    >
      <p className="text-sm text-foreground">
        Change {label} to {toLabel}? {sentenceFeature} reads this answer as {fromLabel}. As {toLabel} it becomes your own question and {feature} skips it.
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onKeep} data-attr={`${dataAttrPrefix}-question-type-keep`}>
          Keep {fromLabel}
        </Button>
        <Button type="button" variant="primary" className="rounded-full" onClick={onConfirm} data-attr={`${dataAttrPrefix}-question-type-change`}>
          Change to {toLabel}
        </Button>
      </div>
    </div>
  );
}

/** "When the answer is X include <form>": one row per rule, a plain fact for the form's own fee. */
function LinkedFormsBlock({
  question,
  options,
  onChange,
  dataAttrPrefix,
}: {
  question: QuestionEditorQuestion;
  options: readonly LinkedFormOption[];
  onChange: (next: LinkedFormRule[]) => void;
  dataAttrPrefix: string;
}) {
  const rules = question.linkedForms ?? [];
  const whenValues = whenOptionsForQuestionType(question.type, question.options);
  const optionByKey = new Map(options.map((option) => [linkedFormKey(option.ref), option] as const));
  const update = (id: string, patch: Partial<LinkedFormRule>) =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  const canAdd = options.length > 0;
  if (rules.length === 0 && !canAdd) return null;
  return (
    <div className="space-y-2" data-attr={`${dataAttrPrefix}-question-linked-forms-block`}>
      <span className={LABEL_CLASS}>Linked forms</span>
      {rules.map((rule) => {
        const key = linkedFormKey(rule.formRef);
        const picked = optionByKey.get(key);
        const whenChoices = whenValues.includes(rule.whenEquals) ? whenValues : [...whenValues, rule.whenEquals];
        const formChoices = [
          ...options.map((option) => ({ value: linkedFormKey(option.ref), label: option.label })),
          ...(picked ? [] : [{ value: key, label: "Deleted form" }]),
        ];
        return (
          <div key={rule.id} className="space-y-2 rounded-xl border border-border px-3 py-3" data-attr={`${dataAttrPrefix}-question-linked-form-rule`} data-rule-id={rule.id}>
            <div className="grid gap-2 sm:grid-cols-2">
              <FieldSingleSelect
                label="When the answer is"
                labelClassName={LABEL_CLASS}
                value={rule.whenEquals}
                options={whenChoices.map((value) => ({ value, label: whenOptionLabel(value) }))}
                onChange={(whenEquals) => update(rule.id, { whenEquals })}
                dataAttr={`${dataAttrPrefix}-question-linked-form-when`}
              />
              <FieldSingleSelect
                label="Include"
                labelClassName={LABEL_CLASS}
                value={key}
                options={formChoices}
                onChange={(next) => {
                  const chosen = optionByKey.get(next);
                  if (chosen) update(rule.id, { formRef: chosen.ref });
                }}
                dataAttr={`${dataAttrPrefix}-question-linked-form-form`}
              />
            </div>
            {picked ? (
              <p className="text-xs text-muted" data-attr={`${dataAttrPrefix}-question-linked-form-fee`}>{picked.feeText}</p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-foreground">Needed before review</span>
              <div className="flex items-center gap-2">
                <PortalSettingsToggle
                  checked={rule.neededBeforeReview}
                  onChange={(next) => update(rule.id, { neededBeforeReview: next })}
                  label="Needed before review"
                  dataAttr={`${dataAttrPrefix}-question-linked-form-needed`}
                />
                <button
                  type="button"
                  className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-foreground"
                  aria-label="Remove linked form"
                  title="Remove"
                  onClick={() => onChange(rules.filter((candidate) => candidate.id !== rule.id))}
                  data-attr={`${dataAttrPrefix}-question-linked-form-remove`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {canAdd ? (
        <button
          type="button"
          className="min-h-11 text-[13px] font-semibold text-primary hover:underline"
          onClick={() =>
            onChange([
              ...rules,
              {
                id: mintLinkedFormRuleId(),
                whenEquals: whenValues[0] ?? "any",
                formRef: options[0]!.ref,
                neededBeforeReview: false,
              },
            ])
          }
          data-attr={`${dataAttrPrefix}-question-linked-form-add`}
        >
          + Link a form
        </button>
      ) : null}
    </div>
  );
}
