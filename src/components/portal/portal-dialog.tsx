"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoldToConfirmButton } from "@/components/ui/motion/hold-to-confirm-button";
import { Modal, MODAL_HEADER_CLOSE_CLASS, ModalFooter } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

/** Shared popup frame. Dismiss-only footer actions are omitted; wizard Back remains.
 * Size is retained for source compatibility; every popup uses the approved frame.
 */

export type PortalDialogAction = {
  /** Names the outcome — "Record $1,200", "Send reminder", "Delete charge". Never "Save"/"OK". */
  label: string;
  onClick: () => unknown;
  disabled?: boolean;
  /** Independent of Button's own promise-tracking loading state, for a caller that owns `saving` itself. */
  loading?: boolean;
  dataAttr?: string;
  /**
   * M008 — "hold" requires a genuine press-and-hold (pointer or Enter/Space)
   * before the action fires; a plain tap is refused. Opt-in and scoped to
   * {@link ConfirmDeleteModal} in `confirm-delete-modal.tsx` — the one
   * destructive-confirm shape `useConfirm()` renders app-wide — rather than
   * every `tone="danger"` dialog, so a hand-built danger confirm elsewhere in
   * the portal keeps today's plain-click behavior unless it opts in too.
   */
  confirmGuard?: "hold";
};

export type PortalDialogStep = {
  /** 1-based current step. */
  current: number;
  total: number;
};

function StepDots({ current, total }: PortalDialogStep) {
  if (total <= 1) return null;
  return (
    <span
      className="mt-1 inline-flex items-center gap-1.5 lg:hidden"
      role="progressbar"
      aria-valuenow={current}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${current} of ${total}`}
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          aria-hidden
          className={cn(
            "h-1.5 rounded-full transition-all",
            n === current ? "w-4 bg-primary" : "w-1.5 bg-border",
          )}
        />
      ))}
    </span>
  );
}

function PortalDialogFooter({
  tone,
  primaryAction,
  secondaryAction,
  step,
}: {
  tone: "default" | "danger";
  primaryAction: PortalDialogAction;
  secondaryAction: PortalDialogAction | null;
  step?: PortalDialogStep;
}) {
  return (
    <ModalFooter className="w-full items-center justify-between gap-3">
      {secondaryAction ? (
        <Button
          type="button"
          variant="ghost"
          className="rounded-lg border border-[var(--input)]"
          disabled={secondaryAction.disabled}
          onClick={secondaryAction.onClick}
          data-attr={secondaryAction.dataAttr}
        >
          {secondaryAction.label}
        </Button>
      ) : (
        // Keeps the primary pinned right even with no secondary — never re-centers.
        <span aria-hidden />
      )}
      {/* The centred "Step n of N" of the approved pop-up footer, desktop only (the header dots serve a phone). */}
      {step && step.total > 1 ? (
        <span className="hidden min-w-0 flex-1 text-center text-[13px] text-muted lg:block" data-attr="portal-dialog-step-count">
          Step {step.current} of {step.total}
        </span>
      ) : null}
      {primaryAction.confirmGuard === "hold" ? (
        // M008 — a destructive confirm is a press-and-hold guard rail, not a
        // plain tap. Scoped to callers that opt in via `confirmGuard: "hold"`
        // (ConfirmDeleteModal) — see the field's own doc comment.
        <HoldToConfirmButton
          variant="primary"
          className="rounded-lg !bg-danger !text-white hover:!brightness-110 !shadow-none"
          disabled={primaryAction.disabled}
          loading={primaryAction.loading}
          onConfirm={primaryAction.onClick}
          dataAttr={primaryAction.dataAttr}
        >
          {primaryAction.label}
        </HoldToConfirmButton>
      ) : (
        <Button
          type="button"
          variant="primary"
          className={cn(
            "rounded-lg",
            tone === "danger" && "!bg-danger !text-white hover:!brightness-110 !shadow-none",
          )}
          disabled={primaryAction.disabled}
          loading={primaryAction.loading}
          onClick={primaryAction.onClick}
          data-attr={primaryAction.dataAttr}
        >
          {primaryAction.label}
        </Button>
      )}
    </ModalFooter>
  );
}

export function PortalDialog({
  open,
  onClose,
  title,
  /** Back arrow beside the title — wizard steps only. */
  onBack,
  /** Step-dot strip under the title — wizard steps only. */
  step,
  /** Legacy sizing alias; all dialogs use the shared frame. */
  size = "default",
  /** `danger` fills the primary action red — a destructive confirm. */
  tone = "default",
  primaryAction,
  /** Optional action such as Back. Dismiss-only labels are omitted. */
  secondaryAction,
  /** Header chrome before the × — Message, prev/next, Add. Never a second footer button. */
  headerAction,
  children,
  dataAttr,
  /** Outside click / Escape / the header ✕ are ignored — a nested confirm is open on top. */
  dismissBlocked = false,
  className,
  contextPanel,
  preview,
  previewLabel,
  /** False for a short confirm: a content-sized bottom sheet on phone, not a full-screen page. */
  fullScreenMobile = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  onBack?: () => void;
  step?: PortalDialogStep;
  size?: "default" | "wizard";
  tone?: "default" | "danger";
  /** Omit with `null` on a browse-only dialog — no footer, dismiss via ×. */
  primaryAction?: PortalDialogAction | null;
  secondaryAction?: PortalDialogAction | null;
  headerAction?: ReactNode;
  children: ReactNode;
  dataAttr?: string;
  dismissBlocked?: boolean;
  /** Escape hatch for a dialog's body-specific width/height tuning. Never used to add a second footer button. */
  className?: string;
  contextPanel?: ReactNode;
  preview?: ReactNode;
  previewLabel?: string;
  fullScreenMobile?: boolean;
}) {
  void size; // Legacy API: both sizes now use the same frame.
  const resolvedSecondary =
    secondaryAction && !/^(cancel|close|done|keep)$/i.test(secondaryAction.label.trim()) ? secondaryAction : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissBlocked={dismissBlocked}
      dataAttr={dataAttr}
      // Editing popups use the authenticated role-scoped assistant.
      assistantStrip={tone !== "danger"}
      fullScreenMobile={fullScreenMobile}
      contextPanel={contextPanel}
      preview={preview}
      previewLabel={previewLabel}
      status={headerAction}
      title={
        onBack ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              data-attr="portal-dialog-back"
              className={cn(MODAL_HEADER_CLOSE_CLASS, "-ml-1.5")}
            >
              <ArrowLeft className="h-5 w-5" aria-hidden />
            </button>
            <span className="min-w-0 truncate">{title}</span>
          </span>
        ) : (
          title
        )
      }
      description={step ? <StepDots current={step.current} total={step.total} /> : undefined}
      footer={
        primaryAction ? (
          <PortalDialogFooter tone={tone} primaryAction={primaryAction} secondaryAction={resolvedSecondary} step={step} />
        ) : undefined
      }
    >
      <div className={className}>{children}</div>
    </Modal>
  );
}

/**
 * A destructive or committing confirm's body: what is about to happen to which
 * record, as key-value rows — never a paragraph of prose (PLAN-0920-1058).
 */
export function ConfirmRows({
  rows,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="divide-y divide-border/70 text-sm" data-attr="portal-dialog-confirm-rows">
      {rows.map((row) => (
        <div key={row.label} className="flex items-start justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-muted">{row.label}</dt>
          <dd className="min-w-0 text-right font-medium text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
