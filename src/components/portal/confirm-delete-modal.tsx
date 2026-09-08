"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";

/**
 * In-app confirmation for a destructive or lossy action — the same Modal shell
 * as account deletion and every other portal confirm, never `window.confirm`.
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
    <Modal
      open={open}
      title={title}
      dense
      fullPage={false}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant={tone === "danger" ? "danger" : "primary"}
            disabled={busy}
            onClick={onConfirm}
            data-attr={dataAttr}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </ModalFooter>
      }
    >
      <p className="text-sm text-muted">{description}</p>
      {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
    </Modal>
  );
}
