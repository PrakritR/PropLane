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
import { cn } from "@/lib/utils";
import { WizardInvalidFields, missingWizardFields, summarizeMissingFields } from "./validation";
import { WorkspaceDeleteButton } from "./frame";

export { WORKSPACE_PREVIEW_TITLE_CLASS, WorkspaceDeleteButton, WorkspacePreviewTitle, workspaceSaveState } from "./frame";

export { nextOnPathIndex, prevOnPathIndex } from "@/components/portal/add-workspace/path";

/*
 * A one-step dialog draws no rail: the shell (`ListingWorkspace`, shared with the listing wizard) always
 * renders its section nav, so the single-step case hides that nav and collapses the grid column it held.
 */
const SINGLE_STEP_NO_RAIL_CLASS =
  "[&_nav[aria-label^=Listing]]:hidden [&_div:has(>nav[aria-label^=Listing])]:!grid-rows-[minmax(0,1fr)] lg:[&_div:has(>nav[aria-label^=Listing])]:!grid-cols-[minmax(0,1fr)]";
const SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS =
  "[&_nav[aria-label^=Listing]]:hidden [&_div:has(>nav[aria-label^=Listing])]:!grid-rows-[minmax(0,1fr)] lg:[&_div:has(>nav[aria-label^=Listing])]:!grid-cols-[minmax(0,1fr)_300px] xl:[&_div:has(>nav[aria-label^=Listing])]:!grid-cols-[minmax(0,1fr)_380px]";

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
  saveState,
  keepsDraft = false,
  onDiscardDraft,
  dataAttrPrefix = "add-workspace",
  finishDataAttr,
  finishCount,
  dangerAction,
  onDelete,
  deleteDisabled = false,
  deleteDataAttr,
  footerNote,
  overlay,
  headerActions,
  skipOffPath = false,
  numberedSteps = false,
  hideFooterStepCount = false,
  reviewEditLinks = true,
  tabRail = false,
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
  /**
   * The x keeps what was typed: no Discard confirm, and the header says "Draft saved".
   * The caller keeps the answers (`useWizardDraft`) and restores them when the same
   * form opens again.
   */
  keepsDraft?: boolean;
  /** With `keepsDraft`: forget the draft and close. Drawn as a Discard draft icon beside Ask PropLane. */
  onDiscardDraft?: () => void;
  dataAttrPrefix?: string;
  /** Override the last-step button's data-attr (legacy Save selectors). */
  finishDataAttr?: string;
  /** How many individual things remain — the rail card's number. Defaults to the count of incomplete steps. */
  finishCount?: number;
  /** Footer ghost on the left — Delete, not a second layout language. */
  dangerAction?: ReactNode;
  /** Edit only: the standard red Delete text at the footer's left. Prefer this to `dangerAction`. */
  onDelete?: () => void;
  deleteDisabled?: boolean;
  deleteDataAttr?: string;
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
  /** Property form popups: Back left, primary right — no centered step count. */
  hideFooterStepCount?: boolean;
  /**
   * The Review step gets an Edit link per section above its body. A Review that already draws its own
   * Edit on every section card (Add resident) passes false so the link is not offered twice.
   */
  reviewEditLinks?: boolean;
  /**
   * The rail rows are TABS of one screen, not steps to walk through (the property Pricing popup lists the
   * leasing options this way): the primary button is always the finish action, Back and the progress bar
   * are not drawn, and the rail shows no step numbers.
   */
  tabRail?: boolean;
}) {
  const confirm = useConfirm();
  // A rail with one item has nowhere to go: a one-step dialog draws the body (and any live panel) alone.
  const singleStep = steps.length < 2;
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(new Set());
  const [readiness, setReadiness] = useState("");
  const [attemptedSteps, setAttemptedSteps] = useState<ReadonlySet<number>>(new Set());
  const [visitedSteps, setVisitedSteps] = useState<ReadonlySet<string>>(new Set());
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [validationError, setValidationError] = useState<{ step: number; message: string } | null>(null);
  const railSteps = useMemo<StepRailItem[]>(
    () => steps.map((s) => ({ ...s, attention: s.incomplete ? 1 : 0 })),
    [steps],
  );
  const openCount = useMemo(
    () => finishCount ?? steps.filter((s) => s.incomplete && s.id !== "review" && s.id !== "preview").length,
    [steps, finishCount],
  );
  const last = steps.length - 1;
  const discardDraft = useCallback(() => {
    if (busy || !onDiscardDraft) return;
    void confirm({
      title: discardTitle,
      description: discardBody,
      confirmLabel: "Discard",
      note: null,
      tone: "danger",
      guard: "tap",
      dataAttr: `${dataAttrPrefix}-discard-draft`,
    }).then((ok) => {
      if (!ok) return;
      onDiscardDraft();
      onClose();
    });
  }, [busy, confirm, dataAttrPrefix, discardBody, discardTitle, onClose, onDiscardDraft]);
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
  const isLast = tabRail || nextPath == null;

  const close = useCallback(() => {
    if (busy) return;
    if (onRequestClose && !onRequestClose()) return;
    if (!dirty || keepsDraft) {
      onClose();
      return;
    }
    void confirm({
      title: discardTitle,
      description: discardBody,
      confirmLabel: "Discard",
      note: null,
      tone: "danger",
      guard: "tap",
      dataAttr: `${dataAttrPrefix}-discard`,
    }).then((ok) => {
      if (ok) onClose();
    });
  }, [busy, confirm, dataAttrPrefix, dirty, discardBody, discardTitle, keepsDraft, onClose, onRequestClose]);

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

  useEffect(() => {
    const label = summarizeMissingFields(missingWizardFields(workspaceRef.current));
    setReadiness((previous) => previous === label ? previous : label);
  }, [children, current]);

  useEffect(() => {
    const id = steps[current]?.id;
    if (id) setVisitedSteps((previous) => previous.has(id) ? previous : new Set([...previous, id]));
  }, [current, steps]);

  const validateFields = () => {
    const missing = missingWizardFields(workspaceRef.current);
    setAttemptedSteps((previous) => new Set([...previous, current]));
    setInvalidFields(new Set(missing.map((field) => field.id)));
    if (missing.length) {
      const first = missing[0]!;
      setValidationError({ step: current, message: `${first.label}: Required` });
      first.element.setAttribute("aria-invalid", "true");
      first.element.scrollIntoView?.({ block: "center", behavior: "smooth" });
      first.element.focus();
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
    if (onBeforeNext && !onBeforeNext()) {
      setAttemptedSteps((previous) => new Set([...previous, current]));
      setValidationError({ step: current, message: `Complete ${steps[current]?.label ?? "the required fields"}` });
      return;
    }
    if (nextDisabled || nextPath == null) return;
    onJump(nextPath);
  };

  return (
    <WizardInvalidFields.Provider value={invalidFields}>
    <ListingWizardOverlay ariaLabel={title}>
      <div ref={workspaceRef} data-rail={singleStep ? "none" : undefined} className={cn("relative h-full w-full", singleStep && (sidePanel ? SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS : SINGLE_STEP_NO_RAIL_CLASS))} onInput={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
          if (target.validity.valid) target.removeAttribute("aria-invalid");
          setValidationError(null);
          const missing = missingWizardFields(workspaceRef.current);
          setReadiness(summarizeMissingFields(missing));
          setInvalidFields((previous) => new Set(missing.filter((field) => previous.has(field.id)).map((field) => field.id)));
        }
      }}>
      <ListingWorkspace
        title={title}
        subtitle={subtitle}
        saveState={saveState ?? (keepsDraft && dirty ? "Draft saved" : "Not saved yet")}
        onClose={close}
        closeDisabled={busy}
        onContinue={isLast ? finish : goNext}
        headerAside={
          <>
            {headerActions}
            <ModalAssistantStrip contextHint={`${assistantContext} — ${steps[current]?.label ?? title} (Step ${current + 1} of ${steps.length})`} storageScopeKey={assistantScopeKey} />
          </>
        }
        rail={<StepRail steps={railSteps} current={current} onJump={onJump} numbered={numberedSteps} visited={visitedSteps} todoCount={openCount} />}
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
              {onDelete ? <WorkspaceDeleteButton onClick={onDelete} disabled={deleteDisabled || busy} dataAttr={deleteDataAttr} /> : null}
              {dangerAction}
              {/* No trash in the header (captain, Oct 3): a kept draft is discarded from the footer. */}
              {!dangerAction && keepsDraft && dirty && onDiscardDraft ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={discardDraft}
                  data-attr={`${dataAttrPrefix}-discard-draft`}
                  className="text-[13px] font-semibold text-danger hover:underline disabled:opacity-50"
                >
                  Discard draft
                </button>
              ) : null}
              <button
                type="button"
                disabled={prevPath == null || busy}
                hidden={tabRail || prevPath == null}
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
              {validationError?.step === current ? <span role="alert" className="mb-0.5 block text-destructive">{validationError.message}</span> : footerNote ? <span className="mb-0.5 block">{footerNote}</span> : readiness ? <span className="mb-0.5 block">{readiness}</span> : null}
              {hideFooterStepCount || steps.length < 2 ? null : <>Step {current + 1} of {steps.length}</>}
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
                aria-disabled={nextDisabled || Boolean(readiness) || steps[current]?.incomplete || undefined}
                data-attr={`${dataAttrPrefix}-next`}
                aria-label={nextPath != null ? `Continue to ${steps[nextPath]!.label}` : "Continue"}
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-45 aria-disabled:bg-border aria-disabled:text-muted"
              >
                Continue
              </button>
            )}
          </>
        }
      >
        {/* No bar for a one-step popup, nor for a tab rail (options, not steps). */}
        {singleStep || tabRail ? null : <div className="mb-5 hidden gap-1 lg:flex" aria-label="Step progress">
          {steps.map((step, index) => <span key={step.id} data-step-progress={step.id} data-error={attemptedSteps.has(index) && Boolean(step.incomplete || (index === current && invalidFields.size)) || undefined} className={`h-1 flex-1 rounded-full ${attemptedSteps.has(index) && (step.incomplete || (index === current && invalidFields.size)) ? "bg-destructive" : index <= current ? "bg-primary" : "bg-border"}`} />)}
        </div>}
        {reviewEditLinks && (steps[current]?.id === "review" || steps[current]?.id === "preview") ? <nav aria-label="Edit reviewed sections" className="mb-5 flex flex-wrap gap-x-4 gap-y-2">
          {steps.filter((step) => step.id !== "review" && step.id !== "preview").map((step) => <button key={step.id} type="button" onClick={() => onJump(steps.indexOf(step))} className="min-h-11 text-sm font-semibold text-primary">Edit {step.label}</button>)}
        </nav> : null}
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
    </WizardInvalidFields.Provider>
  );
}
