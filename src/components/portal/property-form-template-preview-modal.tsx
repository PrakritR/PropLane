"use client";

import type { ReactNode } from "react";
import { Modal, MODAL_TALL_PANEL_CLASS } from "@/components/ui/modal";

/**
 * Property Application / Lease tab — read-only applicant view in the standard popup frame.
 */
export function PropertyFormTemplatePreviewModal({
  open,
  title,
  onClose,
  children,
  dataAttr,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  dataAttr: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      panelClassName={MODAL_TALL_PANEL_CLASS}
      dataAttr={dataAttr}
    >
      <div className="max-h-[min(78vh,820px)] overflow-y-auto px-4 pb-6 pt-2 sm:px-6">{children}</div>
    </Modal>
  );
}
