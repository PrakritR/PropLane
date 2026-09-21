"use client";

import type { ReactNode } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";

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
  tone = "danger",
  onClose,
  onConfirm,
  dataAttr,
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
  /** `primary` for a confirm that is not destructive (apply, switch, submit anyway). */
  tone?: "danger" | "primary";
  onClose: () => void;
  onConfirm: () => void;
  dataAttr?: string;
}) {
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title={title}
      tone={tone === "danger" ? "danger" : "default"}
      dismissBlocked={busy}
      secondaryAction={{ label: "Cancel", onClick: onClose, disabled: busy }}
      primaryAction={{
        label: busy ? busyLabel : confirmLabel,
        onClick: onConfirm,
        disabled: busy,
        loading: busy,
        dataAttr,
      }}
    >
      <p className="text-sm text-muted">{description}</p>
      {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
    </PortalDialog>
  );
}
