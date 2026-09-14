"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PORTAL_EDIT_ROW_ICON_BUTTON_CLASS,
  PORTAL_EDIT_ROW_ICON_DANGER_BUTTON_CLASS,
} from "@/components/portal/portal-collapsible-edit-row";
import {
  customApplicationFieldTypeOptionsFor,
  customApplicationFieldKeyFromLabel,
  emptyCustomApplicationField,
  normalizeCustomApplicationFields,
  type ManagerCustomApplicationField,
  type ManagerCustomApplicationFieldType,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  applicationConfigFieldsFromSubmission,
  persistApplicationConfigToPropertyIds,
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";
import {
  addListingApplicationField,
  applicationConfigForVariant,
  mergeApplicationConfigForVariant,
  patchListingApplicationField,
  resolveListingApplicationFields,
  type ApplicationFormVariant,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";

/** Types whose answer choices come from the `options` array. */
function fieldTypeUsesOptions(type: ManagerCustomApplicationFieldType): boolean {
  return type === "select" || type === "multi_select";
}

/**
 * Drop blank rows and case-insensitive duplicates from a select/multi_select
 * question's option rows. Mirrors the old comma-text parser's rejection
 * rules (round 31), applied to option ROWS instead of split text — called
 * only at Save so a manager can still type into a fresh blank row mid-edit.
 */
export function sanitizeCustomFieldOptionsForSave(options: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** Sanitize every select/multi_select question's options in one saved custom-fields array. */
export function sanitizeCustomApplicationFieldsForSave(
  fields: readonly ManagerCustomApplicationField[],
): ManagerCustomApplicationField[] {
  return fields.map((f) =>
    fieldTypeUsesOptions(f.type) ? { ...f, options: sanitizeCustomFieldOptionsForSave(f.options) } : f,
  );
}

/**
 * One option row per answer choice — replaces the old comma-separated text
 * field so a comma can appear INSIDE an option (the reason for the change).
 * Blank rows are allowed while editing; `sanitizeCustomFieldOptionsForSave`
 * drops them (and de-dupes case-insensitively) at Save.
 */
export function OptionRowsEditor({
  options,
  onChange,
}: {
  options: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const duplicateIndexes = (() => {
    const seen = new Map<string, number>();
    const dupes = new Set<number>();
    options.forEach((opt, i) => {
      const key = opt.trim().toLowerCase();
      if (!key) return;
      if (seen.has(key)) dupes.add(i);
      else seen.set(key, i);
    });
    return dupes;
  })();

  const setAt = (i: number, value: string) => {
    const next = [...options];
    next[i] = value;
    onChange(next);
  };
  const removeAt = (i: number) => onChange(options.filter((_, idx) => idx !== i));
  const moveAt = (i: number, direction: "up" | "down") => {
    const swap = direction === "up" ? i - 1 : i + 1;
    if (swap < 0 || swap >= options.length) return;
    const next = [...options];
    [next[i], next[swap]] = [next[swap], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-1.5">
      {options.length === 0 ? <p className="text-sm text-muted">No options yet.</p> : null}
      {options.map((opt, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={opt}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder={`Option ${i + 1}`}
            className={duplicateIndexes.has(i) ? "border-red-300 ring-2 ring-red-100" : undefined}
            data-attr={`application-question-option-${i}`}
          />
          <button
            type="button"
            className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
            title="Move option up"
            aria-label="Move option up"
            disabled={i === 0}
            onClick={() => moveAt(i, "up")}
            data-attr="application-question-option-move-up"
          >
            <ChevronUp className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
          <button
            type="button"
            className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
            title="Move option down"
            aria-label="Move option down"
            disabled={i === options.length - 1}
            onClick={() => moveAt(i, "down")}
            data-attr="application-question-option-move-down"
          >
            <ChevronDown className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
          <button
            type="button"
            className={PORTAL_EDIT_ROW_ICON_DANGER_BUTTON_CLASS}
            title="Remove option"
            aria-label="Remove option"
            onClick={() => removeAt(i)}
            data-attr="application-question-option-remove"
          >
            <X className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
        </div>
      ))}
      {duplicateIndexes.size > 0 ? (
        <p className="text-xs text-amber-700">Duplicate options are merged when you save.</p>
      ) : null}
      <button
        type="button"
        onClick={() => onChange([...options, ""])}
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border px-3 text-xs font-semibold text-muted transition hover:border-primary/40 hover:text-foreground"
        data-attr="application-question-option-add"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
        Add option
      </button>
    </div>
  );
}

export function ApplicationQuestionFields({
  field,
  onPatch,
  error,
}: {
  field: ResolvedApplicationField;
  onPatch: (patch: Partial<ManagerCustomApplicationField>) => void;
  error?: string | null;
}) {
  return (
    <>
      <div>
        <p className="text-sm font-medium text-foreground">Question</p>
        <Input
          value={field.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          placeholder="e.g. Do you smoke?"
          className="mt-1"
          data-attr="application-question-label"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-foreground">Answer type</p>
          <Select
            value={field.type}
            onChange={(e) => onPatch({ type: e.target.value as ManagerCustomApplicationFieldType })}
            className="mt-1"
            data-attr="application-question-type"
          >
            {customApplicationFieldTypeOptionsFor(field.type).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-xl border border-border bg-card px-3 py-2.5">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary"
            checked={field.required}
            onChange={(e) => onPatch({ required: e.target.checked })}
            data-attr="application-question-required"
          />
          <span className="text-sm font-medium text-foreground">Required</span>
        </label>
      </div>
      {fieldTypeUsesOptions(field.type) ? (
        <div>
          <p className="text-sm font-medium text-foreground">
            {field.type === "multi_select" ? "Multi-select choices" : "Dropdown options"}
          </p>
          <div className="mt-1">
            <OptionRowsEditor options={field.options} onChange={(options) => onPatch({ options })} />
          </div>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600" data-attr="application-question-error">{error}</p> : null}
    </>
  );
}

/**
 * Validate one resolved application question. Standard (built-in) rows are
 * never invalid — only a manager-authored custom row can fail. `usedKeys` is
 * shared across a sequential scan of every custom question so a duplicate
 * derived key is flagged on the SECOND row carrying it, not the first.
 */
export function validateField(field: ResolvedApplicationField, usedKeys: Set<string>): string | null {
  if (!field.isStandard) {
    const label = field.label.trim();
    if (!label) return "Question label is required.";
    if (fieldTypeUsesOptions(field.type) && field.options.filter((o) => o.trim()).length === 0) {
      return field.type === "multi_select"
        ? "Add at least one choice."
        : "Add at least one dropdown option.";
    }
    const key = field.key.trim() || customApplicationFieldKeyFromLabel(label, usedKeys);
    if (usedKeys.has(key)) return "Duplicate question. Rename or remove one of the copies.";
    usedKeys.add(key);
  }
  return null;
}

/**
 * Edit a single application question — saves listing submission on Save.
 *
 * RETIRED from the manager application-question workspace (see
 * `pro-application-questions-editor-modal.tsx`), which now expands a
 * question IN PLACE using `ApplicationQuestionFields` above directly. Kept
 * here (still exported, still compiling) in case a narrower single-question
 * flow needs it again; nothing in the app currently renders it.
 */
export function ApplicationQuestionEditModal({
  open,
  field,
  isNew = false,
  sectionId = "additional",
  sub,
  variant = "standard",
  saveTarget,
  propertyIds,
  managerUserId,
  onClose,
  onSaved,
  showToast,
  deferPersist = false,
}: {
  open: boolean;
  field: ResolvedApplicationField | null;
  isNew?: boolean;
  sectionId?: string;
  sub: ManagerListingSubmissionV1;
  /** Which application form (long-term vs short-term) this question belongs to. */
  variant?: ApplicationFormVariant;
  saveTarget?: ManagerPropertySaveTarget;
  /** When set, Save applies the same application config to every id (bulk edit). */
  propertyIds?: string[];
  managerUserId: string;
  onClose: () => void;
  onSaved: (next: ManagerListingSubmissionV1) => void;
  showToast: (m: string) => void;
  /**
   * When true, this editor DOES NOT persist. It validates, computes the next submission,
   * and hands it up via `onSaved` for the parent to hold locally until an explicit Save
   * (round 31 — the bulk application editor must not commit on every change). saveTarget /
   * propertyIds are unused in this mode.
   */
  deferPersist?: boolean;
}) {
  const [draft, setDraft] = useState<ResolvedApplicationField>(() =>
    field ?? { ...emptyCustomApplicationField(sectionId), isStandard: false },
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const nextField = field ?? { ...emptyCustomApplicationField(sectionId), isStandard: false };
    setDraft({ ...nextField });
    setError(null);
  }, [open, field, sectionId]);

  const patch = (patchField: Partial<ManagerCustomApplicationField>) => {
    setDraft((prev) => ({ ...prev, ...patchField }));
    if (error) setError(null);
  };

  const save = () => {
    const configSlice = applicationConfigForVariant(sub, variant);
    const applicationFields = resolveListingApplicationFields(configSlice, normalizeCustomApplicationFields);
    const usedKeys = new Set<string>();
    for (const f of applicationFields) {
      if (f.id === draft.id) continue;
      if (!f.isStandard) {
        const key = f.key.trim() || customApplicationFieldKeyFromLabel(f.label.trim(), usedKeys);
        usedKeys.add(key);
      }
    }

    const validationError = validateField(draft, usedKeys);
    if (validationError) {
      setError(validationError);
      return;
    }

    const sanitizedDraft: ResolvedApplicationField = {
      ...draft,
      options: fieldTypeUsesOptions(draft.type) ? sanitizeCustomFieldOptionsForSave(draft.options) : draft.options,
    };
    const { isStandard: _isStandard, standardKey: _standardKey, ...fieldPatch } = sanitizedDraft;

    let configPatch;
    if (isNew) {
      configPatch = addListingApplicationField(configSlice, fieldPatch);
    } else {
      const existing = applicationFields.find((f) => f.id === draft.id);
      if (!existing) {
        showToast("Could not find question to update.");
        return;
      }
      configPatch = patchListingApplicationField(configSlice, existing, fieldPatch);
    }

    // Editing a short-term question must keep the form marked "custom" even if
    // the resulting slice is empty (a matches-default override is dropped), or
    // applicationConfigForVariant would revert it to the curated default.
    const editedSlice = { ...configSlice, ...configPatch };
    if (variant === "short_term") editedSlice.applicationConfigMode = "custom";
    const next: ManagerListingSubmissionV1 = {
      ...sub,
      ...mergeApplicationConfigForVariant(variant, editedSlice),
    };

    // Deferred mode: hand the edit up, persist nothing. The parent buffers it until Save.
    if (deferPersist) {
      onClose();
      onSaved(next);
      return;
    }

    const bulkIds = propertyIds?.filter((id) => id.trim()) ?? [];
    if (bulkIds.length > 0) {
      const { saved, failed } = persistApplicationConfigToPropertyIds(
        managerUserId,
        bulkIds,
        applicationConfigFieldsFromSubmission(next),
      );
      if (saved === 0) {
        showToast("Could not save question.");
        return;
      }
      if (failed > 0) {
        showToast(`Updated application for ${saved} properties (${failed} could not be saved).`);
      } else if (saved === 1) {
        showToast(isNew ? "Question added." : "Question saved.");
      } else {
        showToast(`Updated application for ${saved} properties`);
      }
      onClose();
      onSaved(next);
      return;
    }

    if (!saveTarget) {
      showToast("Could not save question.");
      return;
    }
    if (!persistManagerListingSubmission(saveTarget, managerUserId, next)) {
      showToast("Could not save question.");
      return;
    }
    showToast(isNew ? "Question added." : "Question saved.");
    onClose();
    onSaved(next);
  };

  return (
    <Modal
      open={open}
      title={isNew ? "Add question" : "Edit question"}
      onClose={onClose}
      presentation="dialog"
      dense
      panelClassName="max-w-xl"
      stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" data-attr="application-question-save" onClick={save}>
            Save changes
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <ApplicationQuestionFields field={draft} onPatch={patch} error={error} />
      </div>
    </Modal>
  );
}
