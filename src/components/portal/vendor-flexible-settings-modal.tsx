"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  DEFAULT_FLEXIBLE_TIMING_RANK,
  VENDOR_FLEXIBLE_TIMING_LABELS,
  type VendorFlexiblePreferences,
  type VendorFlexibleTiming,
} from "@/lib/vendor-availability";

export function VendorFlexibleSettingsModal({
  open,
  preferences,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  preferences: VendorFlexiblePreferences;
  saving?: boolean;
  onClose: () => void;
  onSave: (next: VendorFlexiblePreferences) => void;
}) {
  const [rank, setRank] = useState<VendorFlexibleTiming[]>(preferences.timingRank);

  useEffect(() => {
    if (open) setRank(preferences.timingRank);
  }, [open, preferences.timingRank]);

  const move = (index: number, direction: -1 | 1) => {
    const next = [...rank];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const current = next[index]!;
    next[index] = next[target]!;
    next[target] = current;
    setRank(next);
  };

  return (
    <Modal
      open={open}
      title="Flexible settings"
      onClose={onClose}
      description="Rank preferred times of day for auto-scheduling flexible visits. A resident's requested time always wins when you're available."
      footer={
        <ModalFooter>
          <Button
            type="button"
            className="rounded-full"
            data-attr="vendor-flexible-settings-save"
            disabled={saving}
            onClick={() => onSave({ timingRank: rank.length > 0 ? rank : [...DEFAULT_FLEXIBLE_TIMING_RANK] })}
          >
            {saving ? "Saving…" : "Save preferences"}
          </Button>
        </ModalFooter>
      }
    >
      <ol className="space-y-2">
        {rank.map((period, index) => (
          <li
            key={period}
            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-accent/20 px-3 py-2.5"
          >
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">#{index + 1}</p>
              <p className="text-sm font-semibold text-foreground">{VENDOR_FLEXIBLE_TIMING_LABELS[period]}</p>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                className="h-8 w-8 rounded-full px-0"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={`Move ${VENDOR_FLEXIBLE_TIMING_LABELS[period]} up`}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-8 w-8 rounded-full px-0"
                disabled={index === rank.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`Move ${VENDOR_FLEXIBLE_TIMING_LABELS[period]} down`}
              >
                ↓
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
