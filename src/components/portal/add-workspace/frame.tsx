"use client";

/**
 * The parts every editor popup (Edit / Add application, lease, move-in form, room pricing) draws the
 * same way, so a manager who learned one knows them all: the Saved / Not saved yet words, the title
 * that sits above a right-hand preview card, and the red Delete text at the left of the footer.
 * `AddWorkspace` owns the rest of the frame (header, rail, progress bar, step heading, Back and the
 * primary button).
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The title above a right-hand preview card: "Applicant sees", "Resident sees", "Lease preview", "What a resident pays". */
export const WORKSPACE_PREVIEW_TITLE_CLASS = "text-xs font-semibold text-muted";

export function WorkspacePreviewTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-2.5", WORKSPACE_PREVIEW_TITLE_CLASS, className)}>{children}</h3>;
}

/** The header's save words. A new record reads "Not saved yet" until it is created. */
export function workspaceSaveState({ busy = false, dirty, isNew = false }: { busy?: boolean; dirty: boolean; isNew?: boolean }): string {
  if (busy) return "Saving…";
  return dirty || isNew ? "Not saved yet" : "Saved";
}

/** Footer left, edit only: red text, never a bordered button. */
export function WorkspaceDeleteButton({
  onClick,
  disabled = false,
  dataAttr,
}: {
  onClick: () => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-attr={dataAttr}
      data-workspace-delete
      className="min-h-[44px] px-2 text-[13px] font-semibold text-danger hover:underline disabled:opacity-50"
    >
      Delete
    </button>
  );
}
