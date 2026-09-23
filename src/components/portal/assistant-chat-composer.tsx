"use client";

import { ArrowUp, Paperclip, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  CHAT_ATTACHMENT_ACCEPT,
  MAX_CHAT_ATTACHMENTS,
  type PendingChatAttachment,
  prepareChatAttachmentsFromFiles,
  revokeAttachmentPreview,
} from "@/lib/assistant-chat-attachments.client";
import { cn } from "@/lib/utils";

/**
 * The composer's two round controls. `min-h-0` opts out of the portal shell's
 * 44px button floor, which otherwise stretches these into pills; the 44px
 * single-line box around them is the touch target. Inset 6px on every side so
 * they sit centered on one line and bottom-aligned as the text grows.
 */
const COMPOSER_ICON_BTN =
  "absolute bottom-1.5 flex size-8 min-h-0 items-center justify-center rounded-full transition-[background-color,color,filter,transform] duration-150 disabled:cursor-not-allowed";

export type AssistantChatComposerProps = {
  input: string;
  setInput: (value: string) => void;
  onSend: () => void;
  loading?: boolean;
  compact?: boolean;
  placeholder?: string;
  attachments: PendingChatAttachment[];
  onAttachmentsChange: (next: PendingChatAttachment[]) => void;
  onAttachmentError?: (message: string) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Stable hook for a layout-level assistant entry point to focus this composer. */
  inputId?: string;
  inputAriaLabel?: string;
  className?: string;
  /** SMS test conversations are text-only and cannot carry browser attachments. */
  allowAttachments?: boolean;
};

export function AssistantChatComposer({
  input,
  setInput,
  onSend,
  loading = false,
  compact = false,
  placeholder = "Ask about your portfolio…",
  attachments,
  onAttachmentsChange,
  onAttachmentError,
  inputRef,
  inputId,
  inputAriaLabel,
  className,
  allowAttachments = true,
}: AssistantChatComposerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const allowAttachmentsRef = useRef(allowAttachments);
  const attachmentPreparationGeneration = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const canSend = !loading && (input.trim().length > 0 || (allowAttachments && attachments.length > 0));

  useLayoutEffect(() => {
    if (allowAttachmentsRef.current === allowAttachments) return;
    allowAttachmentsRef.current = allowAttachments;
    attachmentPreparationGeneration.current += 1;
  }, [allowAttachments]);

  useEffect(() => {
    if (allowAttachments || attachments.length === 0) return;
    attachments.forEach(revokeAttachmentPreview);
    onAttachmentsChange([]);
  }, [allowAttachments, attachments, onAttachmentsChange]);

  async function onPickFiles(files: FileList | null) {
    if (!allowAttachments || !files?.length) return;
    const preparationGeneration = attachmentPreparationGeneration.current;
    const { prepared, error } = await prepareChatAttachmentsFromFiles(files, attachments.length);
    if (
      !allowAttachmentsRef.current ||
      preparationGeneration !== attachmentPreparationGeneration.current
    ) {
      prepared.forEach((attachment) => revokeAttachmentPreview(attachment));
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    if (prepared.length) onAttachmentsChange([...attachments, ...prepared]);
    if (error) onAttachmentError?.(error);
    if (fileRef.current) fileRef.current.value = "";
  }

  function onDragEnter(e: React.DragEvent) {
    if (!allowAttachments) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    if (!allowAttachments) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }

  function onDragOver(e: React.DragEvent) {
    if (!allowAttachments) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = attachments.length >= MAX_CHAT_ATTACHMENTS ? "none" : "copy";
    setDragOver(true);
  }

  function onDrop(e: React.DragEvent) {
    if (!allowAttachments) return;
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    dragDepthRef.current = 0;
    if (loading || attachments.length >= MAX_CHAT_ATTACHMENTS) return;
    void onPickFiles(e.dataTransfer.files);
  }

  function removeAttachment(id: string) {
    const target = attachments.find((a) => a.id === id);
    if (target) revokeAttachmentPreview(target);
    onAttachmentsChange(attachments.filter((a) => a.id !== id));
  }

  return (
    <div className={className}>
      {allowAttachments && attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div
              key={att.id}
              data-attr="assistant-attachment-chip"
              className="inline-flex max-w-full items-center gap-2 rounded-xl border border-border bg-foreground/[0.03] px-2 py-1.5 text-xs text-foreground"
            >
              {att.kind === "image" && att.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- local data URL preview
                <img src={att.previewUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-[10px] font-semibold uppercase text-primary">
                  PDF
                </span>
              )}
              <span className="max-w-[8rem] truncate">{att.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${att.fileName}`}
                onClick={() => removeAttachment(att.id)}
                className="rounded-full p-0.5 text-muted hover:bg-foreground/5 hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={cn(
          "relative rounded-2xl border bg-auth-input-bg shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] duration-200 focus-within:border-primary/60 focus-within:ring-[3px] focus-within:ring-primary/20",
          dragOver
            ? "border-primary/50 ring-[3px] ring-primary/15"
            : "border-border",
        )}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {allowAttachments ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={CHAT_ATTACHMENT_ACCEPT}
              multiple
              className="sr-only"
              data-attr="assistant-attachment-input"
              onChange={(e) => void onPickFiles(e.target.files)}
            />
            <button
              type="button"
              disabled={loading || attachments.length >= MAX_CHAT_ATTACHMENTS}
              aria-label="Attach image or PDF"
              data-attr="assistant-attachment-button"
              onClick={() => fileRef.current?.click()}
              className={cn(COMPOSER_ICON_BTN, "left-1.5 text-muted hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40")}
            >
              <Paperclip className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}
        <textarea
          ref={inputRef}
          id={inputId}
          aria-label={inputAriaLabel}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className={cn(
            // `block` drops the inline baseline gap under the textarea; the box's
            // focus-within ring is the focus state, so the global :focus-visible
            // outline (unlayered, so `!`) would draw a second ring inside it.
            "block w-full resize-none [field-sizing:content] bg-transparent py-3 pr-12 text-sm leading-5 text-foreground outline-none focus-visible:outline-none! placeholder:text-muted/70",
            allowAttachments ? "pl-11" : "pl-3.5",
            compact ? "max-h-20 min-h-11" : "max-h-32 min-h-11",
          )}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className={cn(
            COMPOSER_ICON_BTN,
            "right-1.5",
            canSend
              ? "text-white shadow-[0_2px_6px_-2px_rgba(47,107,255,0.55)] hover:brightness-110 active:scale-95"
              : "bg-foreground/[0.07] text-muted/70",
          )}
          style={canSend ? { background: "var(--btn-primary)" } : undefined}
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.25} aria-hidden />
        </button>
      </div>
    </div>
  );
}
