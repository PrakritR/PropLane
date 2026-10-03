"use client";

import { Button } from "@/components/ui/button";

export function SharedRoomBedConflictModal({
  open,
  message,
  nextBedLabel,
  onSwitch,
  onDismiss,
}: {
  open: boolean;
  message: string;
  nextBedLabel?: string;
  onSwitch: () => void;
  onDismiss: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-lg">
        <h2 className="text-lg font-bold text-foreground">Bed no longer available</h2>
        <p className="mt-2 text-sm text-foreground">{message}</p>
        {nextBedLabel ? (
          <p className="mt-2 text-sm font-semibold text-foreground">Next open: {nextBedLabel}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onDismiss}>Keep editing</Button>
          {nextBedLabel ? (
            <Button type="button" onClick={onSwitch} data-attr="sr-apply-switch-bed">
              Switch to {nextBedLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
