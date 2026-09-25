"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection, PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { useSettingsPropertyScope } from "@/components/portal/settings-property-scope";
import { ApplicationFormBuilder } from "@/components/portal/application-form-builder";
import { sanitizeCustomApplicationFieldsForSave, validateField } from "@/components/portal/application-question-edit-modal";
import {
  emptyCustomApplicationField,
  normalizeCustomApplicationFieldsForEditor,
  type ManagerCustomApplicationField,
} from "@/lib/manager-listing-submission";
import {
  addListingApplicationField,
  canMoveCustomApplicationField,
  editorVisibleDisabledApplicationFields,
  moveCustomApplicationField,
  moveCustomApplicationFieldToSection,
  patchListingApplicationField,
  reenableListingApplicationField,
  removeListingApplicationField,
  resolveListingApplicationFields,
  type ApplicationConfigSlice,
  type ResolvedApplicationField,
} from "@/lib/rental-application/application-field-catalog";
import { DEFAULT_CUSTOM_FIELD_SECTION_ID } from "@/lib/rental-application/application-sections";
import {
  applyShareAcrossVariants,
  emptyWorkspaceApplicationFormTemplate,
  type WorkspaceApplicationFormTemplate,
} from "@/lib/rental-application/workspace-application-form";

/** The workspace template's main (long-term) triplet, in the exact shape every catalog helper already reads. */
function mainSlice(template: WorkspaceApplicationFormTemplate): ApplicationConfigSlice {
  return {
    disabledStandardApplicationKeys: template.disabledStandardApplicationKeys,
    customApplicationFields: template.customApplicationFields,
    applicationConfigMode: template.applicationConfigMode,
  };
}

function withMainSlice(
  template: WorkspaceApplicationFormTemplate,
  slice: ApplicationConfigSlice,
): WorkspaceApplicationFormTemplate {
  return applyShareAcrossVariants({
    ...template,
    disabledStandardApplicationKeys: slice.disabledStandardApplicationKeys,
    customApplicationFields: slice.customApplicationFields,
    applicationConfigMode: slice.applicationConfigMode,
  });
}

/**
 * Settings → Application form. Edits the workspace-wide rental application
 * template every listing follows by default (`applicationFormSource` on the
 * listing opts a specific one out). Reuses `ApplicationFormBuilder` — the
 * SAME question list/reorder/section editor the per-listing custom
 * application uses (`pro-application-questions-editor-modal.tsx`) — so a
 * manager sees one familiar editor whether they are shaping the workspace
 * default or one listing's override.
 */
export function ManagerApplicationFormSettings() {
  // "" (the account rung in most Operations panels) falls through to the
  // route's own owner-default-workspace resolution — this namespace has no
  // account rung, so there is nothing extra to special-case here.
  const { workspaceId } = useSettingsPropertyScope();
  const [template, setTemplate] = useState<WorkspaceApplicationFormTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [expandedQuestionIds, setExpandedQuestionIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    fetch(`/api/portal/application-form${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load the application form."))))
      .then((data: { template: WorkspaceApplicationFormTemplate }) => {
        setTemplate(data.template ?? emptyWorkspaceApplicationFormTemplate());
        setDirty(false);
      })
      .catch(() => setLoadError("Could not load the application form. Try again."))
      .finally(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  const slice = useMemo(() => (template ? mainSlice(template) : null), [template]);
  const applicationFields = useMemo<ResolvedApplicationField[]>(
    () => (slice ? resolveListingApplicationFields(slice, normalizeCustomApplicationFieldsForEditor) : []),
    [slice],
  );
  const disabledFields = useMemo<ResolvedApplicationField[]>(
    () => (slice ? editorVisibleDisabledApplicationFields("standard", slice) : []),
    [slice],
  );
  const fieldErrors = useMemo(() => {
    const usedKeys = new Set<string>();
    const errors = new Map<string, string>();
    for (const f of applicationFields) {
      const err = validateField(f, usedKeys);
      if (err) errors.set(f.id, err);
    }
    return errors;
  }, [applicationFields]);
  const hasFieldErrors = fieldErrors.size > 0;

  const applySlice = (nextSlice: ApplicationConfigSlice) => {
    setTemplate((prev) => (prev ? withMainSlice(prev, nextSlice) : prev));
    setDirty(true);
  };

  const addQuestion = (sectionId: string) => {
    if (!slice) return;
    applySlice({
      ...slice,
      ...addListingApplicationField(slice, {
        ...emptyCustomApplicationField(sectionId),
      }),
    });
  };
  const patchField = (field: ResolvedApplicationField, patch: Partial<ManagerCustomApplicationField>) => {
    if (!slice) return;
    applySlice(patchListingApplicationField(slice, field, patch));
  };
  const removeField = (field: ResolvedApplicationField) => {
    if (!slice) return;
    applySlice(removeListingApplicationField(slice, field));
  };
  const reenableField = (field: ResolvedApplicationField) => {
    if (!slice || !field.standardKey) return;
    applySlice(reenableListingApplicationField(slice, field.standardKey));
  };
  const moveField = (field: ResolvedApplicationField, direction: "up" | "down") => {
    if (!slice) return;
    applySlice(moveCustomApplicationField(slice, field.id, direction, normalizeCustomApplicationFieldsForEditor));
  };
  const moveFieldToSection = (field: ResolvedApplicationField, sectionId: string) => {
    if (!slice) return;
    applySlice(moveCustomApplicationFieldToSection(slice, field.id, sectionId, normalizeCustomApplicationFieldsForEditor));
  };
  const canMoveField = (field: ResolvedApplicationField, direction: "up" | "down") =>
    slice ? canMoveCustomApplicationField(slice, field.id, direction, normalizeCustomApplicationFieldsForEditor) : false;

  const toggleShareAcrossVariants = (next: boolean) => {
    setTemplate((prev) => (prev ? applyShareAcrossVariants({ ...prev, shareAcrossVariants: next }) : prev));
    setDirty(true);
  };

  const save = async () => {
    if (!template || hasFieldErrors) return;
    setSaving(true);
    setSaveError(null);
    const sanitized: WorkspaceApplicationFormTemplate = {
      ...template,
      customApplicationFields: sanitizeCustomApplicationFieldsForSave(template.customApplicationFields),
    };
    try {
      const res = await fetch("/api/portal/application-form", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: sanitized, workspaceId: workspaceId || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error || "Could not save the application form.");
        return;
      }
      const data = (await res.json()) as { template: WorkspaceApplicationFormTemplate };
      setTemplate(data.template);
      setDirty(false);
      setSavedAt(Date.now());
    } catch {
      setSaveError("Could not save the application form.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PortalSettingsSection title="Application form">
        <p className="text-sm text-muted">Loading…</p>
      </PortalSettingsSection>
    );
  }

  if (loadError || !template) {
    return (
      <PortalSettingsSection title="Application form">
        <p className="text-sm text-rose-600" role="alert">
          {loadError ?? "Could not load the application form."}
        </p>
        <Button type="button" variant="outline" className="mt-3 rounded-full" onClick={load}>
          Retry
        </Button>
      </PortalSettingsSection>
    );
  }

  return (
    <>
      <PortalSettingsSection title="Application form">
        <PortalSettingsGroup>
          <PortalSettingsRow label="Use the main questions for short-term and cosigner applications too">
            <PortalSettingsToggle
              checked={template.shareAcrossVariants}
              onChange={toggleShareAcrossVariants}
              label="Use the main questions for short-term and cosigner applications too"
              dataAttr="application-form-share-across-variants"
            />
          </PortalSettingsRow>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <ApplicationFormBuilder
        applicationFields={applicationFields}
        disabledFields={disabledFields}
        expandedQuestionIds={expandedQuestionIds}
        onToggleExpand={(id) =>
          setExpandedQuestionIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
        fieldErrors={fieldErrors}
        onAddQuestion={addQuestion}
        onRemoveField={removeField}
        onReenableField={reenableField}
        onPatchField={patchField}
        onMoveField={moveField}
        onMoveFieldToSection={moveFieldToSection}
        canMoveField={canMoveField}
      />
      <Button
        type="button"
        variant="outline"
        className="rounded-full"
        data-attr="application-form-add-question"
        onClick={() => addQuestion(DEFAULT_CUSTOM_FIELD_SECTION_ID)}
      >
        + Add question
      </Button>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          data-attr="application-form-save"
          disabled={!dirty || saving || hasFieldErrors}
          onClick={() => save()}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {saveError ? (
          <span className="text-sm text-rose-600" role="alert">
            {saveError}
          </span>
        ) : !dirty && savedAt ? (
          <span className="text-sm text-muted">Saved</span>
        ) : null}
      </div>
    </>
  );
}
