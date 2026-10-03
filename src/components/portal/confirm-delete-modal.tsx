"use client";

import type { ReactNode } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";

/**
 * In-app confirmation for a destructive or lossy action — the one
 * {@link PortalDialog} shape ("Destructive confirm") every portal confirm
 * uses, never `window.confirm`.
 *
 * A native confirm is a browser chrome dialog: it reads "localhost:3002 says",
 * cannot be styled, and looks like a phishing prompt rather than part of the
 * product. Route every destructive gesture through here.
 *
 * Most callers reach it through `useConfirm()` (app-ui-provider) rather than
 * mounting it directly — that hook hands back a promise, so a call site reads
 * like the `window.confirm` it replaced.
 */
export function ConfirmDeleteModal({
  open,
  title = "Delete",
  description,
  confirmLabel = "Delete",
  busyLabel = "Deleting…",
  note = "This cannot be undone.",
  busy = false,
  confirmDisabled = false,
  tone = "danger",
  onClose,
  onConfirm,
  dataAttr,
  guard = "hold",
}: {
  open: boolean;
  title?: string;
  description: ReactNode;
  confirmLabel?: string;
  /** Shown while the action runs. "Deleting…" is wrong for a confirm that is not a delete. */
  busyLabel?: string;
  /** Pass null where the action IS reversible — a row that moves to another tab is not gone. */
  note?: ReactNode;
  busy?: boolean;
  /**
   * Hold the confirm without claiming the action is running — Cancel stays live.
   * For a dialog whose consent depends on something still loading (the counts a
   * cascade delete is about to remove).
   */
  confirmDisabled?: boolean;
  /** `primary` for a confirm that is not destructive (apply, switch, submit anyway). */
  tone?: "danger" | "primary";
  onClose: () => void;
  onConfirm: () => void;
  dataAttr?: string;
  /**
   * `hold` (default) for deleting saved records. `tap` for dropping unsaved
   * input (closing an editor) — nothing stored is lost, so a plain tap.
   */
  guard?: "hold" | "tap";
}) {
  if (guard === "tap") {
    // Dropping unsaved input is one short question: no context column, no preview,
    // no empty body — the question sits on the button's row (captain, Oct 3).
    return (
      <PortalDialog
        open={open}
        onClose={onClose}
        title={title}
        tone={tone === "danger" ? "danger" : "default"}
        dismissBlocked={busy}
        fullScreenMobile={false}
        contextPanel={null}
        preview={null}
        primaryAction={null}
      >
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3" data-attr="confirm-tap-row">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">{description}</p>
            {note ? <p className="mt-1 text-xs text-muted">{note}</p> : null}
          </div>
          <Button
            type="button"
            variant="primary"
            className={tone === "danger" ? "shrink-0 rounded-full !bg-danger !text-white hover:!brightness-110 !shadow-none" : "shrink-0 rounded-full"}
            disabled={busy || confirmDisabled}
            loading={busy}
            onClick={onConfirm}
            data-attr={dataAttr}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </PortalDialog>
    );
  }
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title={title}
      tone={tone === "danger" ? "danger" : "default"}
      dismissBlocked={busy}
      // Dropping unsaved input is a short question: a content-sized sheet. A delete
      // keeps the full frame with its "What gets removed" preview (C2-POP9).
      fullScreenMobile
      previewLabel={tone === "danger" ? "What gets removed" : "Confirmation"}
      preview={
        <div className="space-y-4 rounded-xl border border-border bg-card p-4 text-sm"><div>{description}</div>{note ? <div className="text-danger">{note}</div> : null}</div>
      }
      primaryAction={{
        label: busy ? busyLabel : confirmLabel,
        onClick: onConfirm,
        disabled: busy || confirmDisabled,
        loading: busy,
        dataAttr,
        // M008 — every destructive confirm through this shared modal is a
        // press-and-hold guard rail, not a plain tap.
        confirmGuard: "hold",
      }}
    >
      <p className="text-sm text-muted">{description}</p>
      {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
    </PortalDialog>
  );
}
