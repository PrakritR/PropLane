"use client";

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, MODAL_HEADER_CLOSE_CLASS, ModalFooter } from "@/components/ui/modal";
import { cn } from "@/lib/utils";

/**
 * ONE pop-up shape for the whole portal — `docs/agents/ui-change-checklist.md`
 * § Pop-ups, PLAN-0920-1058 "1d · The pop-up".
 *
 * Desktop: a centered dialog, 560px (720px for `size="wizard"`), body scrolls
 * inside a fixed header/footer. Phone: a bottom sheet with a grab handle, full
 * height only for a wizard. Both come from {@link Modal}, which already does
 * that responsive dialog/drawer switch off pointer type
 * (`useModalPresentation`) — this component never re-decides it.
 *
 * The footer is exactly one text secondary (left, defaults to "Cancel") and
 * one filled primary (right) whose label names the outcome ("Record $1,200",
 * never "Save"). `tone="danger"` fills the primary red for a destructive
 * confirm. The in-modal "Ask PropLane" assistant strip is chrome for an
 * editing workspace, not a pop-up — every `PortalDialog` renders without it.
 */

export type PortalDialogAction = {
  /** Names the outcome — "Record $1,200", "Send reminder", "Delete charge". Never "Save"/"OK". */
  label: string;
  onClick: () => unknown;
  disabled?: boolean;
  /** Independent of Button's own promise-tracking loading state, for a caller that owns `saving` itself. */
  loading?: boolean;
  dataAttr?: string;
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
      className="mt-1 inline-flex items-center gap-1.5"
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
}: {
  tone: "default" | "danger";
  primaryAction: PortalDialogAction;
  secondaryAction: PortalDialogAction | null;
}) {
  return (
    <ModalFooter className="w-full items-center justify-between gap-3">
      {secondaryAction ? (
        <Button
          type="button"
          variant="ghost"
          className="rounded-full"
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
      <Button
        type="button"
        variant="primary"
        className={cn(
          "rounded-full",
          tone === "danger" && "!bg-danger !text-white hover:!brightness-110 !shadow-none",
        )}
        disabled={primaryAction.disabled}
        loading={primaryAction.loading}
        onClick={primaryAction.onClick}
        data-attr={primaryAction.dataAttr}
      >
        {primaryAction.label}
      </Button>
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
  /** `wizard` widens the desktop dialog to 720px and fills the phone sheet (full height). */
  size = "default",
  /** `danger` fills the primary action red — a destructive confirm. */
  tone = "default",
  primaryAction,
  /**
   * Defaults to a "Cancel" that calls `onClose`. Pass `null` only where there is
   * genuinely no way back (rare) — never to make room for a second filled button.
   */
  secondaryAction,
  children,
  dataAttr,
  /** Outside click / Escape / the header ✕ are ignored — a nested confirm is open on top. */
  dismissBlocked = false,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  onBack?: () => void;
  step?: PortalDialogStep;
  size?: "default" | "wizard";
  tone?: "default" | "danger";
  primaryAction: PortalDialogAction;
  secondaryAction?: PortalDialogAction | null;
  children: ReactNode;
  dataAttr?: string;
  dismissBlocked?: boolean;
  /** Escape hatch for a dialog's body-specific width/height tuning. Never used to add a second footer button. */
  className?: string;
}) {
  const isWizard = size === "wizard";
  const resolvedSecondary =
    secondaryAction === null ? null : secondaryAction ?? { label: "Cancel", onClick: onClose };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissBlocked={dismissBlocked}
      dataAttr={dataAttr}
      // The chip is top-bar chrome, never dialog chrome (PLAN-0920-1058 "1d · The pop-up").
      assistantStrip={false}
      fullScreenMobile={isWizard}
      panelClassName={isWizard ? "max-w-[720px]" : "max-w-[560px]"}
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
      footer={<PortalDialogFooter tone={tone} primaryAction={primaryAction} secondaryAction={resolvedSecondary} />}
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
