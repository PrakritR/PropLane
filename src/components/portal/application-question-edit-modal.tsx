"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS,
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

function parseOptionsText(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const t = part.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function ApplicationQuestionFields({
  field,
  optionsText,
  onPatch,
  onOptionsTextChange,
  error,
}: {
  field: ResolvedApplicationField;
  optionsText: string;
  onPatch: (patch: Partial<ManagerCustomApplicationField>) => void;
  onOptionsTextChange: (text: string) => void;
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
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-sm font-medium text-foreground">Answer type</p>
          <NativeSelect
            value={field.type}
            onChange={(e) => onPatch({ type: e.target.value as ManagerCustomApplicationFieldType })}
            className="mt-1"
          >
            {CUSTOM_APPLICATION_FIELD_TYPE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex cursor-pointer items-center gap-2 self-end rounded-xl border border-border bg-card px-3 py-2.5">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary"
            checked={field.required}
            onChange={(e) => onPatch({ required: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">Required</span>
        </label>
      </div>
      {field.type === "select" ? (
        <div>
          <p className="text-sm font-medium text-foreground">Dropdown options</p>
          <Input
            value={optionsText}
            onChange={(e) => onOptionsTextChange(e.target.value)}
            placeholder="Comma-separated, e.g. Yes, No, Occasionally"
            className="mt-1"
          />
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </>
  );
}

function validateField(
  field: ResolvedApplicationField,
  usedKeys: Set<string>,
): string | null {
  if (!field.isStandard) {
    const label = field.label.trim();
    if (!label) return "Question label is required.";
    if (field.type === "select" && field.options.length === 0) {
      return "Add at least one dropdown option (comma-separated).";
    }
    const key = field.key.trim() || customApplicationFieldKeyFromLabel(label, usedKeys);
    if (usedKeys.has(key)) return "Duplicate question. Rename or remove one of the copies.";
    usedKeys.add(key);
  }
  return null;
}

/** Edit a single application question — saves listing submission on Save. */
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
  const [optionsText, setOptionsText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const nextField =
      field ?? { ...emptyCustomApplicationField(sectionId), isStandard: false };
    setDraft({ ...nextField });
    setOptionsText(nextField.options.join(", "));
    setError(null);
  }, [open, field, sectionId]);

  const patch = (patchField: Partial<ManagerCustomApplicationField>) => {
    setDraft((prev) => ({ ...prev, ...patchField }));
    if (error) setError(null);
  };

  const onOptionsTextChange = (text: string) => {
    setOptionsText(text);
    patch({ options: parseOptionsText(text) });
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

    const { isStandard: _isStandard, standardKey: _standardKey, ...fieldPatch } = draft;

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
          <Button
            type="button"
            variant="primary"
            className="rounded-full"
            data-attr="application-question-save"
            onClick={save}
          >
            Save changes
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <ApplicationQuestionFields
          field={draft}
          optionsText={optionsText}
          onPatch={patch}
          onOptionsTextChange={onOptionsTextChange}
          error={error}
        />
      </div>
    </Modal>
  );
}
