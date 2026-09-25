"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_TALL_PANEL_CLASS, MODAL_XL_PANEL_CLASS } from "@/components/ui/modal-styles";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { rasterizeLeasePdfPages, type RasterPage } from "@/lib/pdf-page-raster.client";
import {
  DEFAULT_LEASE_DOCUMENT_FIELD_SIZE,
  leaseDocumentFieldLabel,
  newLeaseDocumentFieldId,
  type LeaseDocumentField,
  type LeaseDocumentFieldKind,
  type LeaseDocumentFieldRole,
} from "@/lib/lease-document-library";

type ToolId = `${LeaseDocumentFieldRole}:${LeaseDocumentFieldKind}`;

const TOOLS: { id: ToolId; role: LeaseDocumentFieldRole; kind: LeaseDocumentFieldKind }[] = [
  { id: "resident:signature", role: "resident", kind: "signature" },
  { id: "resident:initials", role: "resident", kind: "initials" },
  { id: "resident:date", role: "resident", kind: "date" },
  { id: "manager:signature", role: "manager", kind: "signature" },
];

const FIELD_TONE: Record<LeaseDocumentFieldRole, string> = {
  resident: "border-blue-500 bg-blue-500/15 text-blue-900 dark:text-blue-200",
  manager: "border-amber-500 bg-amber-500/15 text-amber-900 dark:text-amber-200",
};

/**
 * Full-screen signature-field placement editor (night/custom-lease, item 2).
 * Renders every page of an uploaded lease PDF in the browser and lets a
 * manager drop Resident signature / Resident initials / Date signed /
 * Manager signature fields onto them — click a tool, click a page to place,
 * drag a placed field to move it, click its × to remove it. Coordinates are
 * saved normalized 0..1 against each page's own size
 * (`lease-document-library.ts`), so placement is resolution-independent.
 */
export function LeaseDocumentFieldEditorModal({
  entry,
  onClose,
  onSave,
}: {
  entry: { id: string; url: string; fileName: string; fields: LeaseDocumentField[] };
  onClose: () => void;
  onSave: (fields: LeaseDocumentField[]) => Promise<void>;
}) {
  const [pages, setPages] = useState<RasterPage[]>([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [fields, setFields] = useState<LeaseDocumentField[]>(entry.fields);
  const [armedTool, setArmedTool] = useState<ToolId | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const dragState = useRef<{ id: string; page: number; startX: number; startY: number; fieldX: number; fieldY: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const collected: RasterPage[] = [];
    setPagesLoaded(false);
    void rasterizeLeasePdfPages(
      entry.url,
      (page, index) => {
        if (cancelled) return;
        collected[index] = page;
        setPages([...collected]);
      },
      () => cancelled,
    )
      .catch(() => setError("Could not render this PDF."))
      .finally(() => {
        if (!cancelled) setPagesLoaded(true);
      });
    return () => {
      cancelled = true;
      for (const p of collected) if (p) URL.revokeObjectURL(p.url);
    };
  }, [entry.url]);

  const placeField = (pageIndex: number, clientX: number, clientY: number) => {
    if (!armedTool) return;
    const el = pageRefs.current[pageIndex];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tool = TOOLS.find((t) => t.id === armedTool);
    if (!tool) return;
    const size = DEFAULT_LEASE_DOCUMENT_FIELD_SIZE[tool.kind];
    const rawX = (clientX - rect.left) / rect.width - size.w / 2;
    const rawY = (clientY - rect.top) / rect.height - size.h / 2;
    const x = Math.min(Math.max(rawX, 0), 1 - size.w);
    const y = Math.min(Math.max(rawY, 0), 1 - size.h);
    setFields((prev) => [
      ...prev,
      { id: newLeaseDocumentFieldId(), page: pageIndex, x, y, w: size.w, h: size.h, role: tool.role, kind: tool.kind },
    ]);
    setArmedTool(null);
  };

  const onFieldPointerDown = (field: LeaseDocumentField, e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { id: field.id, page: field.page, startX: e.clientX, startY: e.clientY, fieldX: field.x, fieldY: field.y };
  };

  const onFieldPointerMove = (field: LeaseDocumentField, e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag || drag.id !== field.id) return;
    const el = pageRefs.current[drag.page];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const x = Math.min(Math.max(drag.fieldX + dx, 0), 1 - field.w);
    const y = Math.min(Math.max(drag.fieldY + dy, 0), 1 - field.h);
    setFields((prev) => prev.map((f) => (f.id === field.id ? { ...f, x, y } : f)));
  };

  const onFieldPointerUp = (field: LeaseDocumentField) => {
    if (dragState.current?.id === field.id) dragState.current = null;
  };

  const removeField = (id: string) => setFields((prev) => prev.filter((f) => f.id !== id));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(fields);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save signature fields.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title={`Place signature fields — ${entry.fileName}`}
      onClose={onClose}
      dismissBlocked={saving}
      scrollableContent={false}
      panelClassName={cn(MODAL_XL_PANEL_CLASS, MODAL_TALL_PANEL_CLASS, "h-[min(90dvh,54rem)]")}
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving} data-attr="lease-field-editor-cancel">
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            className="ml-auto rounded-full"
            onClick={() => void save()}
            disabled={saving}
            data-attr="lease-field-editor-save"
          >
            {saving ? "Saving…" : "Save fields"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="grid h-full min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => setArmedTool((cur) => (cur === tool.id ? null : tool.id))}
              data-attr={`lease-field-tool-${tool.id.replace(":", "-")}`}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                armedTool === tool.id
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-card text-foreground hover:bg-accent",
              )}
            >
              {leaseDocumentFieldLabel(tool)}
            </button>
          ))}
          {error ? <span className="text-xs font-medium text-red-600">{error}</span> : null}
          {armedTool ? <span className="text-xs text-muted">Click a page to place it</span> : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-accent/30 p-3">
          {!pagesLoaded && pages.length === 0 ? (
            <div className="grid h-40 place-items-center text-sm text-muted">Loading document…</div>
          ) : (
            <div className="mx-auto flex max-w-2xl flex-col gap-4">
              {pages.map((page, index) => (
                <div
                  key={index}
                  ref={(el) => {
                    pageRefs.current[index] = el;
                  }}
                  onClick={(e) => placeField(index, e.clientX, e.clientY)}
                  className={cn("relative select-none overflow-hidden rounded-lg border border-border bg-white shadow-sm", armedTool ? "cursor-crosshair" : "")}
                  data-attr={`lease-field-page-${index}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={page.url} alt={`Page ${index + 1}`} className="block w-full" draggable={false} />
                  {fields
                    .filter((f) => f.page === index)
                    .map((field) => (
                      <div
                        key={field.id}
                        onPointerDown={(e) => onFieldPointerDown(field, e)}
                        onPointerMove={(e) => onFieldPointerMove(field, e)}
                        onPointerUp={() => onFieldPointerUp(field)}
                        onClick={(e) => e.stopPropagation()}
                        className={cn(
                          "absolute flex cursor-move items-center justify-between gap-1 rounded border-2 px-1.5 text-[10px] font-semibold",
                          FIELD_TONE[field.role],
                        )}
                        style={{
                          left: `${field.x * 100}%`,
                          top: `${field.y * 100}%`,
                          width: `${field.w * 100}%`,
                          height: `${field.h * 100}%`,
                        }}
                        data-attr={`lease-field-placed-${field.role}-${field.kind}`}
                      >
                        <span className="truncate">{leaseDocumentFieldLabel(field)}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeField(field.id);
                          }}
                          className="shrink-0 rounded-full p-0.5 hover:bg-black/10"
                          aria-label={`Remove ${leaseDocumentFieldLabel(field)}`}
                          data-attr={`lease-field-remove-${field.id}`}
                        >
                          <X className="size-3" strokeWidth={2.5} />
                        </button>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
