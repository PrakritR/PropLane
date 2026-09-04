"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { DocumentTemplateMergeField, ManagerDocumentTemplate } from "@/lib/documents/document-templates";

export function ManagerDocumentTemplatesPanel() {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive();
  const [templates, setTemplates] = useState<ManagerDocumentTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [renderTarget, setRenderTarget] = useState<ManagerDocumentTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (demo) {
      setTemplates([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/manager-document-templates");
      const data = (await res.json()) as { templates?: ManagerDocumentTemplate[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to load templates.");
      setTemplates(data.templates ?? []);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }, [demo, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  function openRender(template: ManagerDocumentTemplate) {
    const initial: Record<string, string> = {};
    for (const field of template.mergeFields) initial[field.key] = "";
    setValues(initial);
    setRenderTarget(template);
  }

  async function downloadPdf() {
    if (!renderTarget) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/manager-document-templates/${renderTarget.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, disposition: "attachment" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to render PDF.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${renderTarget.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "template"}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast("PDF generated.");
      setRenderTarget(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to render PDF.");
    } finally {
      setBusy(false);
    }
  }

  function renderFieldInput(field: DocumentTemplateMergeField) {
    return (
      <div key={field.key}>
        <label className="text-xs font-semibold text-muted">
          {field.label || field.key}
          {field.required ? " *" : ""}
        </label>
        <Input
          className="mt-1"
          value={values[field.key] ?? ""}
          onChange={(e) => setValues((cur) => ({ ...cur, [field.key]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {demo ? (
        <PortalDataTableEmpty
          message="Document templates need a signed-in manager account. Sign in to generate filled PDFs from your templates."
          icon="document"
        />
      ) : loading ? (
        <PortalDataTableEmpty message="Loading templates…" icon="document" />
      ) : templates.length === 0 ? (
        <PortalDataTableEmpty message="No document templates yet. Templates can be seeded or created via the API." icon="document" />
      ) : (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <div className={PORTAL_DATA_TABLE_SCROLL}>
            <table className={PORTAL_DATA_TABLE}>
              <thead>
                <tr className={PORTAL_TABLE_HEAD_ROW}>
                  <th className={MANAGER_TABLE_TH}>Name</th>
                  <th className={MANAGER_TABLE_TH}>Category</th>
                  <th className={MANAGER_TABLE_TH}>Merge fields</th>
                  <th className={MANAGER_TABLE_TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <tr key={template.id} className={PORTAL_TABLE_TR}>
                    <td className={PORTAL_TABLE_TD}>{template.name}</td>
                    <td className={PORTAL_TABLE_TD}>{template.category}</td>
                    <td className={PORTAL_TABLE_TD}>{template.mergeFields.length}</td>
                    <td className={PORTAL_TABLE_TD}>
                      <Button
                        variant="outline"
                        className="h-8 rounded-full px-3 text-xs"
                        onClick={() => openRender(template)}
                        data-attr="document-template-generate"
                      >
                        Generate PDF
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={Boolean(renderTarget)}
        onClose={() => setRenderTarget(null)}
        title={renderTarget?.name ?? "Generate PDF"}
        footer={
          renderTarget ? (
            <ModalFooter>
              <Button variant="primary" onClick={() => downloadPdf()} disabled={busy} data-attr="document-template-download">
                {busy ? "Generating…" : "Download PDF"}
              </Button>
            </ModalFooter>
          ) : undefined
        }
      >
        {renderTarget ? (
          <div className="space-y-3">
            {renderTarget.mergeFields.length === 0 ? (
              <p className="text-sm text-muted">This template has no merge fields. Download the PDF as-is.</p>
            ) : (
              renderTarget.mergeFields.map(renderFieldInput)
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
