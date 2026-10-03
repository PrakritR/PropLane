"use client";

import type { ReactNode } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

/** Read-only “what the resident sees” shell with a primary Edit handoff (studio pt40.view). */
export function PropertySectionPreviewModal({
  open,
  title,
  onClose,
  onEdit,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      title={`Preview · ${title}`}
      onClose={onClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter className="w-full gap-2">
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          <Button type="button" variant="primary" className="ml-auto rounded-full" onClick={onEdit} data-attr="property-section-preview-edit">
            Edit
          </Button>
        </ModalFooter>
      }
    >
      <div className="rounded-2xl border border-border bg-card p-4" data-attr="property-section-preview-body">
        {children}
      </div>
    </Modal>
  );
}
