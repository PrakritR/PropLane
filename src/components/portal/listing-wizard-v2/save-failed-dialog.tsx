"use client";

/**
 * The one place a listing SAVE failure is shown.
 *
 * The editor no longer autosaves on a timer, so it writes exactly once — when
 * the manager presses ✕. When that write is refused, the reason used to land as
 * a toast that came back on every keystroke (the timer re-armed the save, the
 * save failed again, the toast returned). This dialog replaces that loop: the
 * server's reason is shown ONCE, in the manager's own words, and they choose
 * what happens next.
 *
 * Two variants:
 *
 *  - **Ordinary (transient) refusal** — a dropped connection, an expired
 *    session, a validation the manager can fix by editing. "Try again" is a
 *    genuine option here, so it stays:
 *    - Keep editing — the safe default (primary, autofocused). Esc and an
 *      outside click mean this too, so nothing is discarded by accident.
 *    - Try again — the text secondary; run the same single save once more.
 *    - Leave without saving — the only destructive choice, so it lives as a
 *      `PortalIconAction` (trash, danger tone) in the header, never a third
 *      footer button (`docs/agents/ui-change-checklist.md` § Pop-ups).
 *  - **`kind="plan_limit"`** — the workspace's own record cap (drafts
 *    included, `WORKSPACE_PROPERTY_LIMIT_ERROR_CODE`). "Try again" would fail
 *    identically forever, so it is never offered here: the dialog instead
 *    names the numbers and offers the two things that actually clear it
 *    (upgrade for a second workspace, or delete an old draft) alongside
 *    Keep editing. Nothing is at risk of being lost — this refusal fires
 *    before anything writes — so there is no destructive "leave" choice and
 *    no trash icon (PLAN-0921-1648).
 *
 * Built on the Radix Dialog primitive this app already uses for its modals (the
 * same one `ui/modal.tsx` wraps and `import-upload-step` opens directly), with
 * `role="alertdialog"` and focus trapped. It portals above the listing editor's
 * own full-screen overlay (z-80), so its z-index sits higher — this is NOT a
 * `PortalDialog`: that shared shape has no `alertdialog` role, no control over
 * stacking above the editor's own overlay, and no "focus the safe button"
 * autofocus hook, all load-bearing for a data-loss-prevention confirm.
 */

import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { ArrowUpCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmRows } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalContainer } from "@/components/ui/portal-container-context";
import type { PropertyRecordLimitInfo } from "@/lib/demo-property-pipeline";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { propertyListHref } from "@/lib/portal-detail-routes";
import { WORKSPACE_PROPERTY_LIMIT } from "@/lib/workspaces/types";

/** This editor is manager-only; the Properties list always lives here. */
const MANAGER_PORTAL_BASE = "/portal";

export function ListingSaveFailedDialog({
  open,
  reason,
  kind,
  limitInfo,
  onKeepEditing,
  onTryAgain,
  onLeaveWithoutSaving,
}: {
  open: boolean;
  /** The server's own refusal, shown verbatim (e.g. "Select an owned workspace before adding a property."). */
  reason: string;
  /** Undefined = an ordinary transient refusal. "plan_limit" = the workspace's record cap; see file docs. */
  kind?: "plan_limit";
  /** Numbers for the `plan_limit` variant's fact rows. Any field may be absent. */
  limitInfo?: PropertyRecordLimitInfo;
  /** Esc, an outside click, and the Keep editing button all route here. */
  onKeepEditing: () => void;
  /** Runs the same single save again; return the promise so the button spins. Unused when `kind` is "plan_limit". */
  onTryAgain: () => void | Promise<void>;
  /** Close the editor and discard the unsaved work. Unused when `kind` is "plan_limit". */
  onLeaveWithoutSaving: () => void;
}) {
  const portalContainer = usePortalContainer();
  const keepRef = useRef<HTMLButtonElement>(null);
  const isPlanLimit = kind === "plan_limit";
  const limit = limitInfo?.limit ?? WORKSPACE_PROPERTY_LIMIT;
  const current = limitInfo?.current ?? limit;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
    >
      <Dialog.Portal container={portalContainer ?? undefined}>
        <Dialog.Overlay className="fixed inset-0 z-[95] bg-foreground/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
        <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
          <Dialog.Content
            role="alertdialog"
            data-attr="listing-save-failed-dialog"
            // The safe choice is the default: focus Keep editing on open rather
            // than the first tabbable, which is the destructive Leave button.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              keepRef.current?.focus();
            }}
            className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none"
          >
            <div className="flex items-start justify-between gap-3">
              {isPlanLimit ? (
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-primary">
                    <ArrowUpCircle className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <Dialog.Title className="min-w-0 flex-1 text-lg font-bold tracking-tight text-foreground">
                    Workspace is full
                  </Dialog.Title>
                </div>
              ) : (
                <>
                  <Dialog.Title className="min-w-0 flex-1 text-lg font-bold tracking-tight text-foreground">
                    Couldn&rsquo;t save this listing
                  </Dialog.Title>
                  <PortalIconAction
                    icon={Trash2}
                    label="Leave without saving"
                    tone="danger"
                    data-attr="listing-save-failed-leave"
                    onClick={() => onLeaveWithoutSaving()}
                  />
                </>
              )}
            </div>
            {isPlanLimit ? (
              <div className="mt-4" data-attr="listing-save-failed-plan-limit">
                <ConfirmRows
                  rows={[
                    { label: "Property records", value: `${current} of ${limit}` },
                    ...(limitInfo?.draftCount != null
                      ? [{ label: "Includes drafts", value: `${limitInfo.draftCount} drafts` }]
                      : []),
                    { label: "Your work", value: "Kept in this window" },
                  ]}
                />
              </div>
            ) : (
              <Dialog.Description
                className="mt-2 text-sm leading-relaxed text-muted"
                data-attr="listing-save-failed-reason"
              >
                {reason}
              </Dialog.Description>
            )}
            {isPlanLimit ? (
              <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
                <Button
                  ref={keepRef}
                  variant="ghost"
                  className="rounded-full"
                  data-attr="listing-save-limit-keep-editing"
                  onClick={() => onKeepEditing()}
                >
                  Keep editing
                </Button>
                {/*
                  * Both open in a NEW tab. The editor is still mounted behind
                  * this dialog holding the listing that could not be saved, so
                  * navigating this tab away would discard exactly the work the
                  * "Kept in this window" row promises is safe.
                  */}
                <Button asChild variant="secondary" className="rounded-full">
                  <Link
                    href={propertyListHref(MANAGER_PORTAL_BASE, "drafts")}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-attr="listing-save-limit-manage-drafts"
                  >
                    Manage drafts
                  </Link>
                </Button>
                <Button asChild variant="primary" className="rounded-full">
                  <Link
                    href={MANAGER_PLAN_PORTAL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-attr="listing-save-limit-upgrade"
                  >
                    Upgrade plan
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  className="rounded-full"
                  data-attr="listing-save-failed-retry"
                  onClick={() => onTryAgain()}
                >
                  Try again
                </Button>
                <Button
                  ref={keepRef}
                  variant="primary"
                  className="rounded-full"
                  data-attr="listing-save-failed-keep"
                  onClick={() => onKeepEditing()}
                >
                  Keep editing
                </Button>
              </div>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
