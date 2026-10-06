"use client";

import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WIZARD_LABEL_CLASS, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  PROPERTY_LEASE_TYPE_OPTIONS,
  normalizeLeaseTemplateKind,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import {
  createPropertyApplicationTemplate,
  updatePropertyApplicationTemplate,
  type PropertyApplicationTemplate,
} from "@/lib/property-application-templates";

function defaultApplicationLabel(kind: PropertyLeaseTemplateKind): string {
  const meta = PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === kind);
  const base = meta?.defaultLabel ?? "Application";
  return base.replace(/\blease\b/i, "application");
}

/**
 * Add or rename a property application template (stay type + label).
 */
export function PropertyApplicationFormModal({
  open,
  mode,
  template,
  templates,
  onClose,
  onSave,
  onDelete,
  canDelete = false,
}: {
  open: boolean;
  mode: "add" | "edit";
  template?: PropertyApplicationTemplate | null;
  templates: PropertyApplicationTemplate[];
  onClose: () => void;
  onSave: (nextTemplates: PropertyApplicationTemplate[]) => boolean;
  onDelete?: () => void;
  canDelete?: boolean;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<PropertyLeaseTemplateKind>("long-term");
  const [error, setError] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);

  const typeMeta = useMemo(
    () => PROPERTY_LEASE_TYPE_OPTIONS.find((o) => o.id === kind),
    [kind],
  );

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && template) {
      setLabel(template.label);
      setKind(template.kind);
    } else {
      setLabel("");
      setKind("long-term");
    }
    setError(null);
    setStepIdx(0);
  }, [open, mode, template]);

  const submit = () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setError("Enter a name for this application.");
      return;
    }
    const normalizedKind = normalizeLeaseTemplateKind(kind);
    let next: PropertyApplicationTemplate[];
    if (mode === "edit" && template) {
      next = updatePropertyApplicationTemplate(templates, template.id, {
        label: trimmed,
        kind: normalizedKind,
      });
    } else {
      next = [
        ...templates,
        createPropertyApplicationTemplate({
          kind: normalizedKind,
          label: trimmed,
        }),
      ];
    }
    if (!onSave(next)) return;
    workspaceDraft.clear();
    onClose();
  };

  const workspaceTitle = mode === "edit" ? "Edit application" : "Add application";
  const workspaceSteps: AddWorkspaceStep[] = [
    { id: "name", label: "Name", incomplete: !label.trim(), summary: label.trim() || "Name this application" },
  ];
  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]!.id;

  const workspaceDraft = useWorkspaceDraft({
    scope: `application-name:${mode}:${template?.id ?? "new"}`,
    open, value: { label, kind, stepIdx },
    restore: (saved) => { setLabel(saved.label); setKind(saved.kind); setStepIdx(saved.stepIdx); },
  });

  if (!open) return null;

  return (
    <AddWorkspace
      title={workspaceTitle}
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={() => { workspaceDraft.preserve(); (onClose)(); }}
      keepsDraft
      onDiscardDraft={workspaceDraft.clear}
      dirty={Boolean(label.trim())}
      discardTitle="Discard this application?"
      assistantContext={workspaceTitle}
      assistantScopeKey="property-application-workspace"
      sidePanel={
        <PreviewPanel
          title="Application preview"
          name={label.trim() || defaultApplicationLabel(kind)}
          facts={[
            { label: "Type", value: typeMeta?.label ?? "Application" },
            { label: "Name", value: label.trim() || "Not set", warn: !label.trim() },
          ]}
          creates={[{ tone: "yes", text: mode === "add" ? "Adds this application on the property" : "Saves this application" }]}
        />
      }
      lastLabel={mode === "edit" ? "Save" : "Create application"}
      lastDisabled={!label.trim()}
      onBeforeNext={() => {
        if (stepId === "name" && !label.trim()) {
          setError("Enter a name for this application.");
          return false;
        }
        setError(null);
        return true;
      }}
      onFinish={submit}
      dataAttrPrefix="property-application"
      finishDataAttr="property-application-save"
      footerNote={error ? <span className="text-sm text-rose-600">{error}</span> : null}
      onDelete={mode === "edit" && canDelete && onDelete ? onDelete : undefined}
      deleteDataAttr="property-application-delete"
    >
      {stepId === "name" ? (
        <StepColumn>
          <StepHeading title="Name" />
          <WizardSelect
            label="Application type"
            value={kind}
            onChange={(next) => {
              const nextKind = normalizeLeaseTemplateKind(next);
              setKind(nextKind);
              if (!label.trim() || label === defaultApplicationLabel(kind)) {
                setLabel(defaultApplicationLabel(nextKind));
              }
            }}
            options={PROPERTY_LEASE_TYPE_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
            disabled={mode === "edit" && Boolean(template?.listingSeedKey)}
            dataAttr="property-application-kind"
          />
          <label className={WIZARD_LABEL_CLASS} htmlFor="property-application-label">
            Display name
          </label>
          <Input
            id="property-application-label"
            value={label}
            onChange={(e) => {
              setError(null);
              setLabel(e.target.value);
            }}
            placeholder={defaultApplicationLabel(kind)}
          />
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
