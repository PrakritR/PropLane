"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Modal, MODAL_FIELD_LABEL_CLASS, ModalFooter } from "@/components/ui/modal";

export function ResidentLeaseReportIssueModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (message: string) => boolean | Promise<boolean>;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const handleClose = () => {
    if (busy) return;
    setMessage("");
    onClose();
  };

  const handleSubmit = async () => {
    if (!message.trim()) return;
    setBusy(true);
    try {
      const ok = await onSubmit(message.trim());
      if (ok) {
        setMessage("");
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Report issue"
      description="Tell your property manager what needs to change. The lease goes back to them for review — you will not sign until they send an updated version."
      panelClassName="max-w-md"
    >
      <label className="block">
        <span className={MODAL_FIELD_LABEL_CLASS}>What needs to change?</span>
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          rows={5}
          placeholder="Example: The move-in date should be Oct 1, not Sep 22."
          disabled={busy}
          autoFocus
        />
      </label>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={handleClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          data-attr="resident-lease-report-issue-submit"
          onClick={() => void handleSubmit()}
          disabled={busy || !message.trim()}
          loading={busy}
        >
          Send to manager
        </Button>
      </ModalFooter>
    </Modal>
  );
}
