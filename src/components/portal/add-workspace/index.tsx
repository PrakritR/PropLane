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

import { useCallback, useMemo, type ReactNode } from "react";
import { ListingWizardOverlay } from "@/components/portal/listing-wizard-v2/wizard-overlay";
import {
  ListingWorkspace,
  RailNotice,
  SideBelow,
  StepRail,
  type StepRailItem,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { useConfirm } from "@/components/providers/app-ui-provider";

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
  busy = false,
  onFinish,
  saveState = "Not saved yet",
  dataAttrPrefix = "add-workspace",
  finishCount,
}: {
  title: string;
  subtitle?: string;
  steps: readonly AddWorkspaceStep[];
  current: number;
  onJump: (index: number) => void;
  onClose: () => void;
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
  busy?: boolean;
  onFinish: () => void;
  saveState?: ReactNode;
  dataAttrPrefix?: string;
  /** How many individual things remain — the rail card's number. Defaults to the count of incomplete steps. */
  finishCount?: number;
}) {
  const confirm = useConfirm();
  const railSteps = useMemo<StepRailItem[]>(
    () => steps.map((s) => ({ ...s, attention: s.incomplete ? 1 : 0 })),
    [steps],
  );
  const openCount = useMemo(() => finishCount ?? steps.filter((s) => s.incomplete && s.id !== "review").length, [steps, finishCount]);
  const last = steps.length - 1;
  const isLast = current === last;

  const close = useCallback(() => {
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
  }, [confirm, dataAttrPrefix, dirty, discardBody, discardTitle, onClose]);

  return (
    <ListingWizardOverlay>
      <ListingWorkspace
        title={title}
        subtitle={subtitle}
        saveState={saveState}
        onClose={close}
        headerAside={<ModalAssistantStrip contextHint={assistantContext} storageScopeKey={assistantScopeKey} />}
        rail={<StepRail steps={railSteps} current={current} onJump={onJump} />}
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
              <button
                type="button"
                disabled={current === 0}
                onClick={() => onJump(current - 1)}
                data-attr={`${dataAttrPrefix}-back`}
                className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
              >
                Back
              </button>
            </div>
            <span className="min-w-0 flex-1 truncate text-center text-[12.5px] text-muted">
              Step {current + 1} of {steps.length}
            </span>
            {isLast ? (
              <button
                type="button"
                onClick={onFinish}
                disabled={lastDisabled || busy}
                data-attr={`${dataAttrPrefix}-finish`}
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy ? "Saving…" : lastLabel}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onJump(current + 1)}
                data-attr={`${dataAttrPrefix}-next`}
                aria-label={`Continue to ${steps[current + 1]!.label}`}
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
              >
                <span className="sm:hidden">Continue</span>
                <span className="hidden sm:inline">Continue to {steps[current + 1]!.label}</span>
              </button>
            )}
          </>
        }
      >
        {children}
        <SideBelow>{sidePanel}</SideBelow>
      </ListingWorkspace>
    </ListingWizardOverlay>
  );
}
