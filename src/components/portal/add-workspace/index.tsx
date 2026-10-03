"use client";

/**
 * The shared "add" workspace — one shell behind every manager + button.
 *
 * Add resident, Schedule tour, Add application, Add lease, Invite vendor and
 * New promotion all render here: the listing wizard's full-screen overlay,
 * header, step rail, single-column body, live side panel and Back / Continue
 * footer. A door supplies its steps and their bodies; the shell owns
 * navigation, the "things to finish" card, the discard-on-close confirm and
 * the phone layout (the rail collapses to the chip strip `StepRail` already
 * draws).
 *
 * Plan: `.lavish/plans/PLAN-0916-1004-*` — the same shell as New listing, so a
 * manager who has built a listing already knows how to add a person.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";
import { nextOnPathIndex, prevOnPathIndex } from "@/components/portal/add-workspace/path";
import {
  ListingWorkspace,
  RailNotice,
  SideBelow,
  StepRail,
  type StepRailItem,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { useConfirm } from "@/components/providers/app-ui-provider";

export { nextOnPathIndex, prevOnPathIndex } from "@/components/portal/add-workspace/path";

export type AddWorkspaceStep = StepRailItem & {
  /** True while this step still has something required to fill. Drawn as the red dot. */
  incomplete?: boolean;
};

export function AddWorkspace({
  title,
  subtitle,
  steps,
  current,
  onJump,
  onClose,
  onRequestClose,
  dirty = false,
  discardTitle = "Discard this?",
  discardBody = "Nothing has been saved yet. Close and lose what you typed?",
  assistantContext,
  assistantScopeKey,
  railHeader,
  sidePanel,
  children,
  lastLabel,
  lastDisabled = false,
  nextDisabled = false,
  onBeforeNext,
  busy = false,
  onFinish,
  saveState = "Not saved yet",
  dataAttrPrefix = "add-workspace",
  finishDataAttr,
  finishCount,
  dangerAction,
  footerNote,
  overlay,
  headerActions,
  skipOffPath = false,
  numberedSteps = false,
}: {
  title: string;
  subtitle?: string;
  steps: readonly AddWorkspaceStep[];
  current: number;
  onJump: (index: number) => void;
  onClose: () => void;
  /**
   * Runs before the dirty/discard confirm. Return false to consume the close
   * (a nested chooser is open) without discarding the workspace.
   */
  onRequestClose?: () => boolean;
  /** Anything typed — close asks before discarding. */
  dirty?: boolean;
  discardTitle?: string;
  discardBody?: string;
  assistantContext: string;
  assistantScopeKey: string;
  /** Above the rail: the documents / photos cover. The finish card is added by the shell. */
  railHeader?: ReactNode;
  sidePanel?: ReactNode;
  children: ReactNode;
  /** The footer's primary label on the last step — "Add resident", "Schedule tour". */
  lastLabel: string;
  lastDisabled?: boolean;
  /** Continue on a non-last step — a missing required field stays on this step. */
  nextDisabled?: boolean;
  /** Return false to keep the manager on this step (and show the field error). */
  onBeforeNext?: () => boolean;
  busy?: boolean;
  onFinish: () => void;
  saveState?: ReactNode;
  dataAttrPrefix?: string;
  /** Override the last-step button's data-attr (legacy Save selectors). */
  finishDataAttr?: string;
  /** How many individual things remain — the rail card's number. Defaults to the count of incomplete steps. */
  finishCount?: number;
  /** Footer ghost on the left — Delete, not a second layout language. */
  dangerAction?: ReactNode;
  footerNote?: ReactNode;
  /**
   * Sits on top of the workspace without unmounting steps — message preview
   * Back restores the last step with values still filled.
   */
  overlay?: ReactNode;
  /** Icon actions beside Ask PropLane — Generate / Upload on Add lease. */
  headerActions?: ReactNode;
  /**
   * When true, Continue / Back skip `offPath` extras (Add resident Also create).
   * Other doors keep walking every listed step so optional rail rows stay reachable from Continue.
   */
  skipOffPath?: boolean;
  /** F012: numbered rail steps with a check once nothing is missing — Add application / Add lease only. */
  numberedSteps?: boolean;
}) {
  const confirm = useConfirm();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const railSteps = useMemo<StepRailItem[]>(
    () => steps.map((s) => ({ ...s, attention: s.incomplete ? 1 : 0 })),
    [steps],
  );
  const openCount = useMemo(
    () => finishCount ?? steps.filter((s) => s.incomplete && s.id !== "review" && s.id !== "preview").length,
    [steps, finishCount],
  );
  const last = steps.length - 1;
  const nextPath = skipOffPath
    ? nextOnPathIndex(steps, current)
    : current < last
      ? current + 1
      : null;
  const prevPath = skipOffPath
    ? prevOnPathIndex(steps, current)
    : current > 0
      ? current - 1
      : null;
  const isLast = nextPath == null;

  const close = useCallback(() => {
    if (busy) return;
    if (onRequestClose && !onRequestClose()) return;
    if (!dirty) {
      onClose();
      return;
    }
    void confirm({
      title: discardTitle,
      description: discardBody,
      confirmLabel: "Discard",
      note: null,
      tone: "danger",
      dataAttr: `${dataAttrPrefix}-discard`,
    }).then((ok) => {
      if (ok) onClose();
    });
  }, [busy, confirm, dataAttrPrefix, dirty, discardBody, discardTitle, onClose, onRequestClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented) return;
      if (document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      if (document.querySelector('[data-slot="modal-radix-dialog"], [data-slot="modal-vaul-drawer"]')) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const validateFields = () => {
    const invalid = Array.from(workspaceRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("main input, main select, main textarea") ?? []).find((field) => {
      if (!field.willValidate || field.closest('[hidden], [aria-hidden="true"], .hidden')) return false;
      for (let node: HTMLElement | null = field; node && node !== workspaceRef.current; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
      }
      return !field.checkValidity();
    });
    if (invalid) {
      const label = invalid.labels?.[0]?.textContent?.replace(/\s*\(required\)/g, "").trim() || invalid.getAttribute("aria-label") || "Required fields";
      setValidationError(invalid.validity.valueMissing ? `${label}: Required` : invalid.validationMessage);
      invalid.setAttribute("aria-invalid", "true");
      invalid.scrollIntoView?.({ block: "center", behavior: "smooth" });
      invalid.focus();
      invalid.reportValidity();
      return false;
    }
    setValidationError(null);
    return true;
  };

  const finish = () => {
    if (busy || lastDisabled || !validateFields()) return;
    onFinish();
  };

  const goNext = () => {
    if (busy || !validateFields()) return;
    if (onBeforeNext && !onBeforeNext()) return;
    if (nextDisabled || nextPath == null) return;
    onJump(nextPath);
  };

  return (
    <ListingWizardOverlay ariaLabel={title}>
      <div ref={workspaceRef} className="relative h-full w-full" onInput={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
          if (target.validity.valid) target.removeAttribute("aria-invalid");
          setValidationError(null);
        }
      }}>
      <ListingWorkspace
        title={title}
        subtitle={subtitle}
        saveState={saveState}
        onClose={close}
        closeDisabled={busy}
        onContinue={isLast ? finish : goNext}
        headerAside={
          <>
            {headerActions}
            <ModalAssistantStrip contextHint={`${assistantContext} — ${steps[current]?.label ?? title} (Step ${current + 1} of ${steps.length})`} storageScopeKey={assistantScopeKey} />
          </>
        }
        rail={<StepRail steps={railSteps} current={current} onJump={onJump} numbered={numberedSteps} />}
        railHeader={
          <>
            {railHeader}
            <RailNotice count={openCount} onOpen={() => onJump(last)} />
          </>
        }
        sidePanel={sidePanel}
        footer={
          <>
            <div className="flex items-center gap-2.5">
              {dangerAction}
              <button
                type="button"
                disabled={prevPath == null || busy}
                hidden={prevPath == null}
                onClick={() => {
                  if (prevPath != null) onJump(prevPath);
                }}
                data-attr={`${dataAttrPrefix}-back`}
                className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
              >
                Back
              </button>
            </div>
            <span className="min-w-0 flex-1 text-center text-[12.5px] text-muted">
              {validationError ? <span role="alert" className="mb-0.5 block text-destructive">{validationError}</span> : footerNote ? <span className="mb-0.5 block">{footerNote}</span> : null}
              Step {current + 1} of {steps.length}
            </span>
            {isLast ? (
              <button
                type="button"
                onClick={finish}
                disabled={lastDisabled || busy}
                data-attr={finishDataAttr ?? `${dataAttrPrefix}-finish`}
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy ? "Saving…" : lastLabel}
              </button>
            ) : (
              <button
                type="button"
                onClick={goNext}
                disabled={busy}
                aria-disabled={nextDisabled || undefined}
                data-attr={`${dataAttrPrefix}-next`}
                aria-label={nextPath != null ? `Continue to ${steps[nextPath]!.label}` : "Continue"}
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-45 aria-disabled:opacity-45"
              >
                Continue
              </button>
            )}
          </>
        }
      >
        {children}
        <SideBelow>{sidePanel}</SideBelow>
      </ListingWorkspace>
      {overlay ? (
        <div
          className="pointer-events-auto absolute inset-0 z-[20] flex items-stretch justify-center"
          data-attr={`${dataAttrPrefix}-overlay`}
        >
          {overlay}
        </div>
      ) : null}
      </div>
    </ListingWizardOverlay>
  );
}
