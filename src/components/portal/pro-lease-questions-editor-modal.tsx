"use client";

/**
 * Manager editor for an imported lease's question config (C282) — the lease
 * side of the "+ Add → Upload PDF" flow `pro-property-application-questions-panel.tsx`
 * already built for applications, targeting `PropertyLeaseTemplate`'s own
 * draft/publish machinery (`property-lease-templates.ts`) and the
 * `/api/portal/lease-template-import` route instead of the application one.
 *
 * DELIBERATELY SMALLER than `pro-application-questions-editor-modal.tsx`
 * (1400+ lines): a lease has no form-variant tri-state, no standard-field
 * catalog, and no workspace-form concept, so this covers the real contract —
 * import, review each reported issue, compare against the fingerprint/
 * revision, publish — without the application editor's per-question
 * drag-reorder/inline-type-edit UI. A published lease's questions are shown
 * grouped by section, in source order, read-only apart from required/owner
 * toggles; reordering or retyping an individual imported clause is a
 * follow-up (see the build report).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import {
  draftLeaseQuestionConfigForTemplate,
  leaseTemplateQuestionPublishGate,
  publishedLeaseQuestionConfigForTemplate,
  type PropertyLeaseTemplate,
} from "@/lib/property-lease-templates";
import type { ApplicationTemplateQuestionConfig } from "@/lib/property-application-templates";

type ImportIssue = { pageNumber: number | null; code: string; message: string };

function sectionGroups(config: ApplicationTemplateQuestionConfig | null): { section: string; fields: ManagerCustomApplicationField[] }[] {
  if (!config) return [];
  const order = config.questionDisplayOrder;
  const fields = order?.length
    ? [...config.customApplicationFields].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (ai === -1 ? config.customApplicationFields.length : ai) - (bi === -1 ? config.customApplicationFields.length : bi);
      })
    : config.customApplicationFields;
  const groups: { section: string; fields: ManagerCustomApplicationField[] }[] = [];
  for (const field of fields) {
    const section = field.section?.trim() || "General";
    let group = groups.find((g) => g.section === section);
    if (!group) {
      group = { section, fields: [] };
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

export function ManagerLeaseQuestionsEditorModal({
  open,
  template,
  templates,
  propertyId,
  onClose,
  onSave,
  onDelete,
  canDelete,
  showToast,
  autoImportFile,
  onAutoImportConsumed,
}: {
  open: boolean;
  template: PropertyLeaseTemplate | null;
  templates: PropertyLeaseTemplate[];
  propertyId: string | null;
  onClose: () => void;
  onSave: (nextTemplates: PropertyLeaseTemplate[]) => Promise<boolean>;
  onDelete?: () => void;
  canDelete?: boolean;
  showToast: (m: string) => void;
  autoImportFile?: File | null;
  onAutoImportConsumed?: () => void;
}) {
  const [label, setLabel] = useState(template?.label ?? "");
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  // Caller remounts this component with `key={template.id}` on every open (a
  // fresh template id = a fresh instance), so state below initializes once
  // per template rather than needing a reset effect.
  const [localTemplate, setLocalTemplate] = useState<PropertyLeaseTemplate | null>(template);
  const [resolvedIssueIndexes, setResolvedIssueIndexes] = useState<Set<number>>(new Set());
  const autoImportRanRef = useRef(false);

  const draft = localTemplate ? draftLeaseQuestionConfigForTemplate(localTemplate) : null;
  const published = localTemplate ? publishedLeaseQuestionConfigForTemplate(localTemplate) : null;
  const issues: ImportIssue[] = draft?.importProvenance?.issues ?? [];
  const unresolvedCount = draft?.importProvenance?.unresolvedCount ?? 0;

  const importPdf = useCallback(
    async (file: File) => {
      if (!localTemplate || !propertyId) return;
      setImporting(true);
      try {
        const body = new FormData();
        body.append("propertyId", propertyId);
        body.append("leaseTemplateId", localTemplate.id);
        body.append("file", file);
        const res = await fetch("/api/portal/lease-template-import", { method: "POST", body });
        const data = (await res.json().catch(() => ({}))) as {
          draft?: ApplicationTemplateQuestionConfig;
          issues?: ImportIssue[];
          error?: string;
        };
        if (!res.ok || !data.draft) {
          showToast(data.error ?? "Could not import that PDF.");
          return;
        }
        setLocalTemplate((prev) => (prev ? { ...prev, draftQuestionConfig: data.draft } : prev));
        setResolvedIssueIndexes(new Set());
        showToast(`Imported — review ${data.issues?.length ?? 0} flagged item(s) before publishing.`);
      } finally {
        setImporting(false);
      }
    },
    [localTemplate, propertyId, showToast],
  );

  useEffect(() => {
    if (autoImportRanRef.current || !autoImportFile || !localTemplate || !propertyId) return;
    autoImportRanRef.current = true;
    void importPdf(autoImportFile).finally(() => onAutoImportConsumed?.());
  }, [autoImportFile, importPdf, localTemplate, propertyId, onAutoImportConsumed]);

  if (!open || !localTemplate) return null;

  const saveLabel = async () => {
    setSaving(true);
    try {
      // `localTemplate` (not the parent's possibly-stale `templates` prop) is
      // the source of truth for this row's own fields — the dedicated import
      // route already persisted every draft/publish change directly, so this
      // only needs to carry the label edit alongside whatever `localTemplate`
      // currently holds.
      const updatedLocal: PropertyLeaseTemplate = { ...localTemplate, label: label.trim() || localTemplate.label };
      const next = templates.some((t) => t.id === localTemplate.id)
        ? templates.map((t) => (t.id === localTemplate.id ? updatedLocal : t))
        : [...templates, updatedLocal];
      const ok = await onSave(next);
      if (ok) {
        setLocalTemplate(updatedLocal);
        showToast("Saved.");
      }
      return ok;
    } finally {
      setSaving(false);
    }
  };

  const reviewAndConfirm = async () => {
    if (!draft?.importProvenance?.sourcePath || !propertyId) return;
    if (resolvedIssueIndexes.size !== issues.length) {
      showToast("Resolve every listed import issue first.");
      return;
    }
    setSaving(true);
    try {
      const metaRes = await fetch(
        `/api/portal/lease-template-import?propertyId=${encodeURIComponent(propertyId)}&leaseTemplateId=${encodeURIComponent(localTemplate.id)}&meta=1`,
      );
      const meta = (await metaRes.json().catch(() => ({}))) as { draftFingerprint?: string; revision?: string; error?: string };
      if (!metaRes.ok || !meta.draftFingerprint) {
        showToast(meta.error ?? "Could not read the imported draft.");
        return;
      }
      const res = await fetch("/api/portal/lease-template-import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          leaseTemplateId: localTemplate.id,
          sourceSha256: draft.importProvenance.sourceSha256,
          draftFingerprint: meta.draftFingerprint,
          expectedRevision: meta.revision,
          resolvedIssueIndexes: [...resolvedIssueIndexes],
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { draft?: ApplicationTemplateQuestionConfig; error?: string };
      if (!res.ok || !data.draft) {
        showToast(data.error ?? "Could not confirm the review.");
        return;
      }
      setLocalTemplate((prev) => (prev ? { ...prev, draftQuestionConfig: data.draft } : prev));
      showToast("Reviewed. Ready to publish.");
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!localTemplate || !propertyId) return;
    const gate = leaseTemplateQuestionPublishGate(localTemplate);
    if (!gate.ok) {
      showToast(gate.reason);
      return;
    }
    setPublishing(true);
    try {
      const res = await fetch("/api/portal/lease-template-import", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          leaseTemplateId: localTemplate.id,
          expectedPublishedVersion: localTemplate.publishedQuestionConfig?.version ?? 0,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { template?: PropertyLeaseTemplate; error?: string };
      if (!res.ok || !data.template) {
        showToast(data.error ?? "Could not publish.");
        return;
      }
      setLocalTemplate(data.template);
      showToast(`Published — ${localTemplate.label} v${data.template.publishedQuestionConfig?.version ?? 1}.`);
    } finally {
      setPublishing(false);
    }
  };

  const canPublish = draft ? leaseTemplateQuestionPublishGate({ ...localTemplate, draftQuestionConfig: draft }).ok : false;

  return (
    <Modal
      open
      title={localTemplate.label || "Lease form"}
      description="Imported lease questions"
      onClose={onClose}
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      footer={
        <ModalFooter>
          {onDelete && canDelete ? (
            <Button type="button" variant="danger" onClick={onDelete} data-attr="lease-questions-delete">
              Delete
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} data-attr="lease-questions-close">
            Close
          </Button>
          <Button type="button" onClick={() => void saveLabel()} disabled={saving} data-attr="lease-questions-save">
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="lease-questions-label" className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
            Form name
          </label>
          <Input id="lease-questions-label" value={label} onChange={(e) => setLabel(e.target.value)} data-attr="lease-questions-label" />
        </div>

        <div className="rounded-xl border border-border bg-card p-3">
          <p className="text-sm font-semibold text-foreground">Import a lease PDF</p>
          <p className="mt-1 text-xs text-muted">
            {importing ? "Reading the PDF…" : "Upload the license agreement PDF to turn it into editable questions."}
          </p>
          <div className="mt-2">
            <input
              type="file"
              accept="application/pdf"
              disabled={importing}
              data-attr="lease-questions-import-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importPdf(file);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {issues.length > 0 ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3" data-attr="lease-questions-issues">
            <p className="text-sm font-semibold text-amber-900">
              {unresolvedCount > 0 ? `${unresolvedCount} item(s) to review` : "Reviewed"}
            </p>
            <ul className="mt-2 space-y-2">
              {issues.map((issue, index) => (
                <li key={index} className="flex items-start gap-2 text-xs text-amber-900">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={resolvedIssueIndexes.has(index)}
                    data-attr={`lease-questions-issue-resolve-${index}`}
                    onChange={(e) => {
                      setResolvedIssueIndexes((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  />
                  <span>
                    {issue.pageNumber ? `Page ${issue.pageNumber}: ` : ""}
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              <Button type="button" variant="outline" onClick={() => void reviewAndConfirm()} disabled={saving} data-attr="lease-questions-confirm-review">
                Compare and confirm
              </Button>
            </div>
          </div>
        ) : null}

        <div className="space-y-3" data-attr="lease-questions-list">
          {sectionGroups(draft).map((group) => (
            <div key={group.section} className="rounded-xl border border-border bg-card p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{group.section}</p>
              <ul className="mt-2 space-y-1.5">
                {group.fields.map((field) => (
                  <li key={field.id} className="flex items-center justify-between gap-2 text-sm text-foreground" data-attr={`lease-question-row-${field.key}`}>
                    <span className="min-w-0 flex-1 truncate">{field.label}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {field.type}
                      {field.required ? " · required" : ""}
                      {field.filledBy === "manager" ? " · manager" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {sectionGroups(draft).length === 0 ? <p className="text-sm text-muted">No questions yet — import a PDF to get started.</p> : null}
        </div>

        <div className="flex items-center justify-between rounded-xl border border-border bg-accent/20 p-3">
          <div>
            <p className="text-sm font-semibold text-foreground">
              {published ? `Published v${published.version}` : "Not published yet"}
            </p>
            {!canPublish && draft ? <p className="text-xs text-muted">Resolve every import issue to publish.</p> : null}
          </div>
          <Button type="button" onClick={() => void publish()} disabled={!canPublish || publishing} data-attr="lease-questions-publish">
            {publishing ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
