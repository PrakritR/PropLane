"use client";

/**
 * The home demo's pop-ups: the REAL portal pop-up shell, fed fixture props, with nothing behind it.
 *
 * Captain 2026-10-08: "a lot of the pop ups in home page are not accurate to real portal". The real
 * add / view pop-ups (`AddWorkspace`, `MoveInFormFrame`, the property wizard) are the house workspace:
 * one header (title, save state, Ask PropLane, x), a step rail on the left, the step in the centre, a
 * right-hand preview, and a footer with Delete at the left, the centred "Step N of M" and Back + one
 * primary at the right. The doors themselves fetch (residents, templates, records) and mount the whole
 * assistant, so the demo cannot mount them; this file draws the SAME shell from the same exported pieces
 * (`ListingWorkspace`, `StepRail`, `StepHeading`, `PanelSection`, `WizardStepProgress`, `editorFooterState`,
 * `WizardField` / `WizardSelect`) and each panel supplies the door's real step names, field labels and
 * footer words with fixture values. Two differences from the real overlay, both for the page they sit on:
 * the pop-up fills the demo window instead of the browser (`DemoPopupHostContext`), and Ask PropLane is
 * the real icon with nothing behind it.
 *
 * Nothing here fetches or saves: the primary button only closes the pop-up and the panel shows a small
 * "(sample)" toast.
 */

import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { AxisAssistantSparkleIcon } from "@/components/portal/assistant-shared";
import { Sparkles } from "lucide-react";
import {
  ListingWorkspace,
  RailNotice,
  SideBelow,
  StepHeading,
  StepRail,
  WizardStepProgress,
  type StepRailItem,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { WorkspaceDeleteButton } from "@/components/portal/add-workspace/frame";
import { FIELD_SELECT_MENU_DATA_ATTR } from "@/components/ui/field-select-portal-interaction";
import { editorFooterState } from "@/lib/editor-footer-state";
import { cn } from "@/lib/utils";


/** Same single-step rule `AddWorkspace` uses: a one-step dialog draws no rail and gives its column back to the body. */
const SINGLE_STEP_NO_RAIL_CLASS =
  "[&_nav[aria-label^=Listing]]:hidden [&_div:has(>nav[aria-label^=Listing])]:!grid-rows-[minmax(0,1fr)] lg:[&_div:has(>nav[aria-label^=Listing])]:!grid-cols-[minmax(0,1fr)]";
const SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS =
  "[&_nav[aria-label^=Listing]]:hidden [&_div:has(>nav[aria-label^=Listing])]:!grid-rows-[minmax(0,1fr)] lg:[&_div:has(>nav[aria-label^=Listing])]:!grid-cols-[minmax(0,1fr)_260px]";

/** The real overlay's scrim and 920 x 640 centred window, inside the demo window. */
export function DemoPopupLayer({ label, children }: { label: string; children: ReactNode }) {
  const host = useContext(DemoPopupHostContext);
  const layer = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-demo-popup=""
      className="demo-popup-layer pointer-events-auto absolute inset-0 z-[40] flex min-h-0 min-w-0 bg-foreground/30 p-0 backdrop-blur-sm sm:p-4"
    >
      <div className="flex min-h-0 min-w-0 flex-1 items-stretch justify-center p-0 sm:items-center">
        <div className="demo-popup-window h-full w-full max-w-[920px] sm:h-[min(640px,100%)]">{children}</div>
      </div>
    </div>
  );
  return host ? createPortal(layer, host) : layer;
}

/** Escape closes, like the real frames (the demo has no nested menus to defer to besides the field selects). */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(`[${FIELD_SELECT_MENU_DATA_ATTR}]`)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** Ask PropLane: the real trigger's icon, with nothing behind it in the demo. */
export function DemoAskPropLane() {
  return (
    <PortalIconAction
      icon={Sparkles}
      iconSlot={<AxisAssistantSparkleIcon className="size-[18px]" />}
      label="Ask PropLane"
      ring
      data-attr="modal-assistant-strip"
    />
  );
}

export type DemoPopupFooter =
  | {
      kind: "wizard";
      /** The commit word on the last step ("Send", "Schedule tour", "Create"). */
      lastLabel: string;
      onFinish: () => void;
      /** Edit pop-ups only: the red Delete at the footer's left. */
      onDelete?: () => void;
      /** Property form pop-ups: no centred "Step N of M". */
      hideStepCount?: boolean;
    }
  | {
      /** A viewer: no steps to commit, one right-hand primary ("Done"). */
      kind: "done";
      label?: string;
      onDone: () => void;
      /** Left of the primary (Cancel, a secondary action). */
      left?: ReactNode;
    };

export function DemoWorkspacePopup({
  title,
  subtitle,
  saveState,
  headerActions,
  steps,
  railHeader,
  sidePanel,
  footer,
  onClose,
  step,
  onStep,
  children,
  showProgress = true,
  stepHeading,
  dataAttr,
}: {
  title: string;
  subtitle?: string;
  /** "Not saved yet" for a new record, "Saved" for an opened one. */
  saveState?: ReactNode;
  headerActions?: ReactNode;
  steps: readonly StepRailItem[];
  railHeader?: ReactNode;
  sidePanel?: ReactNode;
  footer: DemoPopupFooter;
  onClose: () => void;
  /** Controlled step index (the panel may need it); omit to let the popup own it. */
  step?: number;
  onStep?: (index: number) => void;
  /** The current step's body. */
  children: (index: number) => ReactNode;
  showProgress?: boolean;
  /** Heading above the body; defaults to the current step's label. Pass "" for none. */
  stepHeading?: string;
  dataAttr?: string;
}) {
  const [innerStep, setInnerStep] = useState(0);
  const current = step ?? innerStep;
  const setStep = onStep ?? setInnerStep;
  useEscapeToClose(onClose);
  const singleStep = steps.length < 2;
  const last = steps.length - 1;
  const railSteps = useMemo(() => steps.map((s) => ({ ...s })), [steps]);
  const openCount = steps.filter((s) => (s.attention ?? 0) > 0).length;
  const wizard = footer.kind === "wizard" ? footer : null;
  const state = wizard
    ? editorFooterState({ hasPrev: current > 0, hasNext: current < last, lastLabel: wizard.lastLabel })
    : null;
  const heading = stepHeading ?? steps[current]?.label ?? title;

  return (
    <DemoPopupLayer label={title}>
      <div className={cn("relative h-full w-full", singleStep && (sidePanel ? SINGLE_STEP_NO_RAIL_WITH_PANEL_CLASS : SINGLE_STEP_NO_RAIL_CLASS))} data-attr={dataAttr}>
        <ListingWorkspace
          title={title}
          subtitle={subtitle}
          saveState={saveState}
          onClose={onClose}
          headerAside={
            <>
              {headerActions}
              <DemoAskPropLane />
            </>
          }
          rail={<StepRail steps={railSteps} current={current} onJump={setStep} />}
          railHeader={
            <>
              {railHeader}
              {openCount > 0 ? <RailNotice count={openCount} onOpen={() => setStep(last)} /> : null}
            </>
          }
          sidePanel={sidePanel}
          previewInEye
          footer={
            wizard && state ? (
              <>
                <div className="flex items-center gap-2.5">
                  {wizard.onDelete ? <WorkspaceDeleteButton onClick={wizard.onDelete} /> : null}
                </div>
                <span className="min-w-0 flex-1 text-center text-[13px] text-muted">
                  {wizard.hideStepCount || steps.length < 2 ? null : (
                    <>
                      Step {current + 1} of {steps.length}
                    </>
                  )}
                </span>
                <div className="flex items-center gap-2.5">
                  {state.showBack ? (
                    <button
                      type="button"
                      onClick={() => setStep(current - 1)}
                      data-attr="demo-popup-back"
                      className="min-h-[44px] rounded-lg border border-[var(--input)] bg-card px-4 text-[13.5px] font-semibold text-foreground lg:min-h-9"
                    >
                      Back
                    </button>
                  ) : null}
                  {state.isLast ? (
                    <button
                      type="button"
                      onClick={wizard.onFinish}
                      data-demo-target="sheet-primary"
                      data-attr="demo-popup-finish"
                      className="min-h-[44px] rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white lg:min-h-9"
                    >
                      {state.primaryLabel}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setStep(current + 1)}
                      data-attr="demo-popup-next"
                      aria-label={`Next: ${steps[current + 1]?.label ?? ""}`}
                      className="min-h-[44px] rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white lg:min-h-9"
                    >
                      {state.primaryLabel}
                    </button>
                  )}
                </div>
              </>
            ) : footer.kind === "done" ? (
              <>
                <div className="flex items-center gap-2.5">{footer.left}</div>
                <button
                  type="button"
                  data-demo-target="sheet-primary"
                  onClick={footer.onDone}
                  data-attr="demo-popup-done"
                  className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white lg:min-h-9"
                >
                  {footer.label ?? "Done"}
                </button>
              </>
            ) : null
          }
        >
          {singleStep || !showProgress ? null : <WizardStepProgress steps={steps} current={current} />}
          {heading ? <StepHeading title={heading} /> : null}
          {children(current)}
          <SideBelow>{sidePanel}</SideBelow>
        </ListingWorkspace>
      </div>
    </DemoPopupLayer>
  );
}

/** A small hook for a panel's pop-up state: which pop-up is open, and a close that never saves. */
export function useDemoPopup<T = true>() {
  const [open, setOpen] = useState<T | null>(null);
  return { open, show: (value: T = true as T) => setOpen(value), close: () => setOpen(null) };
}
