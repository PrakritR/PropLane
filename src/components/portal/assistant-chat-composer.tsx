"use client";

import { Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  CHAT_ATTACHMENT_ACCEPT,
  MAX_CHAT_ATTACHMENTS,
  type PendingChatAttachment,
  prepareChatAttachmentsFromFiles,
  revokeAttachmentPreview,
} from "@/lib/assistant-chat-attachments.client";
import { cn } from "@/lib/utils";

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
  const [dragOver, setDragOver] = useState(false);
  const canSend = !loading && (input.trim().length > 0 || (allowAttachments && attachments.length > 0));

  useEffect(() => {
    if (allowAttachments || attachments.length === 0) return;
    attachments.forEach(revokeAttachmentPreview);
    onAttachmentsChange([]);
  }, [allowAttachments, attachments, onAttachmentsChange]);

  async function onPickFiles(files: FileList | null) {
    if (!allowAttachments || !files?.length) return;
    const { prepared, error } = await prepareChatAttachmentsFromFiles(files, attachments.length);
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
          "relative rounded-2xl border bg-auth-input-bg shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,box-shadow] duration-200 focus-within:border-primary/40 focus-within:ring-4 focus-within:ring-primary/10",
          dragOver
            ? "border-primary/50 ring-4 ring-primary/15"
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
              className={cn(
                "absolute bottom-2 left-2 flex h-8 w-8 items-center justify-center rounded-full text-muted outline-none transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-40",
              )}
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
          rows={compact ? 1 : 1}
          placeholder={placeholder}
          className={cn(
            "w-full resize-none [field-sizing:content] rounded-2xl bg-transparent py-3 pr-12 text-sm text-foreground outline-none placeholder:text-muted/70",
            allowAttachments ? "pl-11" : "pl-3",
            compact ? "max-h-20 min-h-[2.5rem]" : "max-h-32 min-h-[2.75rem]",
          )}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full text-white outline-none transition-[filter,opacity,transform] duration-200 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "var(--btn-primary)" }}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden="true">
            <path
              d="M12 19V5M5 12l7-7 7 7"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
