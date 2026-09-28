"use client";

import { useEffect } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PortalFeedbackFormBody,
  PortalFeedbackFormFooterButton,
  usePortalFeedbackForm,
} from "@/components/portal/portal-feedback-form";
import type { BugFeedbackKind, BugFeedbackReporterRole } from "@/lib/portal-bug-feedback";

/** How long the success confirmation shows before this modal closes itself. */
const AUTO_CLOSE_MS = 1800;

/**
 * The feedback form as its own modal — used from the profile Feedback pane's
 * "Add" row and from the in-app rating sheet's "Tell us what to fix". See
 * `portal-feedback-form.tsx` for the shared form itself; `PortalHelpPanel`
 * inlines the same form inside "Need help?" instead of nesting a second
 * modal.
 */
export function PortalFeedbackSubmitModal({
  open,
  onClose,
  reporterRole,
  reporterUserId,
  reporterEmail,
  reporterName,
  onSubmitted,
  /** Pre-filled message (e.g. the in-app rating sheet's "Rated 2/5 in the app"). Empty for every ordinary caller. */
  initialMessage = "",
  initialKind = "bug",
}: {
  open: boolean;
  onClose: () => void;
  reporterRole: BugFeedbackReporterRole;
  reporterUserId: string | null;
  reporterEmail: string;
  reporterName: string;
  onSubmitted: () => void | Promise<void>;
  initialMessage?: string;
  initialKind?: BugFeedbackKind;
}) {
  const form = usePortalFeedbackForm({
    reporterRole,
    reporterUserId,
    reporterEmail,
    reporterName,
    onSubmitted,
    initialMessage,
    initialKind,
    open,
  });

  const handleClose = () => {
    if (form.busy) return;
    form.resetForm();
    onClose();
  };

  // Felt, not just flashed — then close itself so a reporter who is done
  // reading never has to reach for the ×.
  useEffect(() => {
    if (!form.submitted) return;
    const timer = window.setTimeout(() => handleClose(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.submitted]);

  return (
    <Modal
      open={open}
      title="Send feedback"
      onClose={handleClose}
      panelClassName="max-w-lg"
      description={form.submitted ? undefined : "Share an idea, ask a question, or report something broken."}
      footer={
        <ModalFooter>
          <PortalFeedbackFormFooterButton form={form} onDone={handleClose} />
        </ModalFooter>
      }
    >
      <PortalFeedbackFormBody form={form} />
    </Modal>
  );
}
