"use client";

/**
 * N087 (captain 2026-09-27): "remove send feedback just have need help and
 * inside need help have a feedback form." The sidebar's standalone "Send
 * feedback" footer item is gone; "Need help?" now opens this panel — the help
 * center link plus the redesigned feedback form inline (see
 * `portal-feedback-form.tsx` for the shared form itself) — in every portal.
 * `Modal` already resolves to the portal's standard dialog on desktop and a
 * bottom sheet on a phone, so no second presentation layer is needed here.
 */

import { useEffect } from "react";
import Link from "next/link";
import { ChevronRight, LifeBuoy } from "lucide-react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PortalFeedbackFormBody,
  PortalFeedbackFormFooterButton,
  usePortalFeedbackForm,
} from "@/components/portal/portal-feedback-form";
import type { BugFeedbackReporterRole } from "@/lib/portal-bug-feedback";

/** How long the success confirmation shows before this panel closes itself. */
const AUTO_CLOSE_MS = 1800;

export function PortalHelpPanel({
  open,
  onClose,
  reporterRole,
  reporterUserId,
  reporterEmail,
  reporterName,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  reporterRole: BugFeedbackReporterRole;
  reporterUserId: string | null;
  reporterEmail: string;
  reporterName: string;
  onSubmitted?: () => void | Promise<void>;
}) {
  const form = usePortalFeedbackForm({
    reporterRole,
    reporterUserId,
    reporterEmail,
    reporterName,
    onSubmitted: onSubmitted ?? (() => {}),
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
      title="Need help?"
      onClose={handleClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <PortalFeedbackFormFooterButton form={form} onDone={handleClose} />
        </ModalFooter>
      }
    >
      <div className="space-y-5">
        <Link
          href="/support"
          onClick={handleClose}
          data-attr="portal-help-center-link"
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-sm font-semibold text-foreground transition hover:border-primary/30 hover:bg-accent/20 active:scale-[0.99]"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <LifeBuoy className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">Visit our help center</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        </Link>

        <div>
          <p className="mb-3 text-sm font-semibold text-foreground">Send us feedback</p>
          <PortalFeedbackFormBody form={form} />
        </div>
      </div>
    </Modal>
  );
}
