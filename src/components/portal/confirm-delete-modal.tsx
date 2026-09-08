"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";

/**
 * In-app delete confirmation — same Modal shell as account deletion / other
 * portal confirms (not `window.confirm`).
 */
export function ConfirmDeleteModal({
  open,
  title = "Delete",
  description,
  confirmLabel = "Delete",
  busyLabel = "Deleting…",
  note = "This cannot be undone.",
  busy = false,
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
            variant="danger"
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
