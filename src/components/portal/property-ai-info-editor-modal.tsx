"use client";

import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Input } from "@/components/ui/input";
import { PROMOTION_HOUSE_NOTES_MAX_CHARS } from "@/components/portal/promotion-house-notes";
import { firstSentences } from "@/lib/property-ai-info-rows";

export type AiInfoEditorTarget =
  | { kind: "builtin"; key: "about" | "tours" | "rules" | "pricing" | "neighborhood"; title: string; sampleQuestion: string }
  | { kind: "custom"; id: string; title: string; sampleQuestion: string; isNew?: boolean; group: string };

export function PropertyAiInfoEditorModal({
  open,
  target,
  value,
  onChange,
  onClose,
  onSave,
  onClear,
  onDelete,
  busy,
  showCustomTitle,
  customTitle,
  onCustomTitleChange,
}: {
  open: boolean;
  target: AiInfoEditorTarget | null;
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
  onSave: () => void;
  onClear?: () => void;
  onDelete?: () => void;
  busy?: boolean;
  showCustomTitle?: boolean;
  customTitle?: string;
  onCustomTitleChange?: (next: string) => void;
}) {
  const previewAnswer = useMemo(() => {
    const trimmed = value.trim();
    if (!trimmed) return "I do not have that yet, so I will ask the manager and get back to you.";
    return firstSentences(trimmed, 2);
  }, [value]);

  if (!target) return null;

  return (
    <Modal
      open={open}
      title={target.kind === "custom" && target.isNew ? "Add to what the assistant knows" : `Edit ${target.title}`}
      onClose={onClose}
      panelClassName="max-w-2xl"
      footer={
        <ModalFooter className="w-full gap-2">
          {onDelete ? (
            <Button type="button" variant="outline" className="text-red-700" onClick={onDelete} data-attr="property-ai-info-delete">
              Delete
            </Button>
          ) : null}
          {onClear && value.trim() ? (
            <Button type="button" variant="outline" onClick={onClear} data-attr="property-ai-info-clear">
              Clear
            </Button>
          ) : null}
          <Button type="button" variant="primary" className="ml-auto rounded-full" disabled={busy} onClick={onSave} data-attr="property-ai-info-save">
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {showCustomTitle ? (
            <>
              <label className="text-sm font-semibold text-foreground" htmlFor="property-ai-info-title">
                Title
              </label>
              <Input
                id="property-ai-info-title"
                value={customTitle ?? ""}
                onChange={(e) => onCustomTitleChange?.(e.target.value)}
                className="mt-2"
                placeholder="e.g. House FAQ"
                data-attr="property-ai-info-title"
              />
            </>
          ) : null}
          <label className="mt-3 block text-sm font-semibold text-foreground" htmlFor="property-ai-info-text">
            What the assistant should know
          </label>
          <Textarea
            id="property-ai-info-text"
            value={value}
            onChange={(e) => onChange(e.target.value.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS))}
            rows={10}
            className="mt-2"
            data-attr="property-ai-info-text"
          />
          <p className="mt-1 text-right text-xs text-muted">
            {value.length}/{PROMOTION_HOUSE_NOTES_MAX_CHARS}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4" data-attr="property-ai-info-sample-preview">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">How the assistant answers</p>
          <div className="space-y-3">
            <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-white">
              <p className="mb-1 text-[11px] font-semibold text-white/75">Renter</p>
              <p>{target.sampleQuestion}</p>
            </div>
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-[var(--secondary)] px-3.5 py-2.5 text-sm">
              <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold text-muted">
                <Sparkles className="size-3.5 text-primary" aria-hidden />
                PropLane assistant
              </p>
              <p className={value.trim() ? "text-foreground" : "text-muted"}>{previewAnswer}</p>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
