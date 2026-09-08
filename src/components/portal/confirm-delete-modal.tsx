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
  /** Line under the description. Pass null for an action that IS reversible. */
  note = "This cannot be undone.",
  busy = false,
  busyLabel = "Deleting…",
  tone = "danger",
  onClose,
  onConfirm,
  dataAttr,
}: {
  open: boolean;
  title?: string;
  description: ReactNode;
  confirmLabel?: string;
  note?: ReactNode;
  busy?: boolean;
  busyLabel?: string;
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
      <p className="text-sm text-foreground">{description}</p>
      {note ? <p className="mt-2 text-xs text-muted">{note}</p> : null}
    </Modal>
  );
}
