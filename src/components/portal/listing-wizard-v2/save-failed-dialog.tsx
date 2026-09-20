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
 *  - Keep editing — the safe default (primary, autofocused). Esc and an
 *    outside click mean this too, so nothing is discarded by accident.
 *  - Try again — the text secondary; run the same single save once more.
 *  - Leave without saving — the only destructive choice, so it lives as a
 *    `PortalIconAction` (trash, danger tone) in the header, never a third
 *    footer button (`docs/agents/ui-change-checklist.md` § Pop-ups).
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
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalContainer } from "@/components/ui/portal-container-context";

export function ListingSaveFailedDialog({
  open,
  reason,
  onKeepEditing,
  onTryAgain,
  onLeaveWithoutSaving,
}: {
  open: boolean;
  /** The server's own refusal, shown verbatim (e.g. "Select an owned workspace before adding a property."). */
  reason: string;
  /** Esc, an outside click, and the Keep editing button all route here. */
  onKeepEditing: () => void;
  /** Runs the same single save again; return the promise so the button spins. */
  onTryAgain: () => void | Promise<void>;
  /** Close the editor and discard the unsaved work. */
  onLeaveWithoutSaving: () => void;
}) {
  const portalContainer = usePortalContainer();
  const keepRef = useRef<HTMLButtonElement>(null);
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
            </div>
            <Dialog.Description
              className="mt-2 text-sm leading-relaxed text-muted"
              data-attr="listing-save-failed-reason"
            >
              {reason}
            </Dialog.Description>
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
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
