"use client";

import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PROMOTION_HOUSE_NOTES_MAX_CHARS } from "@/components/portal/promotion-house-notes";
import { AI_INFO_GROUP_OPTIONS, firstSentences } from "@/lib/property-ai-info-rows";

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
  group,
  onGroupChange,
  shortTermEnabled,
  onShortTermEnabledChange,
  shortTermValue = "",
  onShortTermValueChange,
  appliesTo,
  onAppliesToChange,
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
  /** Category of a custom entry; picked here now that the list has no tabs. */
  group?: string;
  onGroupChange?: (next: string) => void;
  /** Built-in rows: the "Different for short term" switch and its second text (cleared when switched off). */
  shortTermEnabled?: boolean;
  onShortTermEnabledChange?: (next: boolean) => void;
  shortTermValue?: string;
  onShortTermValueChange?: (next: string) => void;
  /** Custom rows: which stay it is for ("both" | "long_term" | "short_term"). */
  appliesTo?: string;
  onAppliesToChange?: (next: string) => void;
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
      panelClassName="max-w-4xl"
      contextPanel={null}
      previewLabel="How the assistant answers"
      preview={
        <div className="space-y-3" data-attr="property-ai-info-sample-preview">
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
      }
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
            {onGroupChange ? (
              <div className="mt-3">
                <FieldSingleSelect
                  label="Category"
                  // Sentence case and the same weight as the Title and body labels around it.
                  labelClassName="mb-2 block text-sm font-semibold text-foreground"
                  value={group ?? "home"}
                  onChange={onGroupChange}
                  options={AI_INFO_GROUP_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
                  dataAttr="property-ai-info-group"
                />
              </div>
            ) : null}
            {onAppliesToChange ? (
              <div className="mt-3">
                <FieldSingleSelect
                  label="Applies to"
                  labelClassName="mb-2 block text-sm font-semibold text-foreground"
                  value={appliesTo ?? "both"}
                  onChange={onAppliesToChange}
                  options={[
                    { value: "both", label: "Long and short term" },
                    { value: "long_term", label: "Long term" },
                    { value: "short_term", label: "Short term" },
                  ]}
                  dataAttr="property-ai-info-applies-to"
                />
              </div>
            ) : null}
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
        {onShortTermEnabledChange ? (
          <>
            <ToggleRow
              label="Different for short term"
              checked={Boolean(shortTermEnabled)}
              onChange={onShortTermEnabledChange}
              dataAttr="property-ai-info-short-term-toggle"
            />
            {shortTermEnabled ? (
              <>
                <label className="mt-2 block text-sm font-semibold text-foreground" htmlFor="property-ai-info-text-short-term">
                  What the assistant should know for short term
                </label>
                <Textarea
                  id="property-ai-info-text-short-term"
                  value={shortTermValue}
                  onChange={(e) => onShortTermValueChange?.(e.target.value.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS))}
                  rows={6}
                  className="mt-2"
                  data-attr="property-ai-info-text-short-term"
                />
                <p className="mt-1 text-right text-xs text-muted">
                  {shortTermValue.length}/{PROMOTION_HOUSE_NOTES_MAX_CHARS}
                </p>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
