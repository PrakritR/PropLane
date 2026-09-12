"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { SaveStatus } from "@/components/ui/save-status";
import { useAutosaveDraft } from "@/hooks/use-autosave-draft";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  MANAGER_VENDORS_EVENT,
  readManagerVendorCategorySettings,
  readOwnManagerVendorRows,
  saveManagerVendorCategorySettings,
  syncManagerVendorsFromServer,
  vendorsMatchingTrade,
} from "@/lib/manager-vendors-storage";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

export function ManagerVendorDefaultsModal({
  open,
  onClose,
  initialTrade,
  onAddForCategory,
}: {
  open: boolean;
  onClose: () => void;
  /** Scroll focus / pre-select a trade row when opened from a category context. */
  initialTrade?: string;
  /** Opens the add-vendor form with the trade pre-filled. */
  onAddForCategory?: (trade: string) => void;
}) {
  const { userId } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!open) {
      setHydrated(false);
      return;
    }
    void syncManagerVendorsFromServer({ force: true }).then(() => setTick((n) => n + 1));
    setDefaults(readManagerVendorCategorySettings(userId).defaultVendorIdByTrade);
    const t = setTimeout(() => setHydrated(true), 0);
    return () => clearTimeout(t);
  }, [open, userId]);

  useEffect(() => {
    if (!open) return;
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onChange);
  }, [open]);

  const ownVendors = useMemo(() => {
    void tick;
    return readOwnManagerVendorRows(userId);
  }, [tick, userId]);

  const persist = useCallback(
    async (next: Record<string, string>) => {
      if (!userId) throw new Error("Not signed in.");
      saveManagerVendorCategorySettings({ defaultVendorIdByTrade: next }, userId);
    },
    [userId],
  );
  const autosave = useAutosaveDraft({ draft: defaults, enabled: open && hydrated && Boolean(userId), save: persist });
  const handleClose = useCallback(() => {
    void autosave.flush().finally(onClose);
  }, [autosave, onClose]);

  const focusTrade = initialTrade?.trim();

  return (
    <Modal
      open={open}
      title="Vendor defaults"
      onClose={handleClose}
      panelClassName="max-w-lg"
      dense
      status={<SaveStatus status={autosave} />}
    >
      <div className="space-y-4 text-sm">
        <p className="text-xs text-muted">
          Pick a default vendor for each major trade. Outgoing payments pre-select the matching default.
        </p>
        <ul className="space-y-3">
          {VENDOR_TRADE_OPTIONS.map((trade) => {
            const matches = vendorsMatchingTrade(ownVendors, trade);
            const highlighted = focusTrade === trade;
            return (
              <li
                key={trade}
                className={`grid gap-2 rounded-xl p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center ${
                  highlighted ? "bg-accent/30 ring-1 ring-primary/20" : ""
                }`}
              >
                <span className="font-medium text-foreground">{trade}</span>
                <Select
                  value={defaults[trade] ?? ""}
                  onChange={(e) =>
                    setDefaults((prev) => {
                      const next = { ...prev };
                      const value = e.target.value;
                      if (value) next[trade] = value;
                      else delete next[trade];
                      return next;
                    })
                  }
                  data-attr={`vendor-default-trade-${trade}`}
                >
                  <option value="">No default</option>
                  {matches.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </option>
                  ))}
                </Select>
                {onAddForCategory ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-full text-xs"
                    onClick={() => {
                      onClose();
                      onAddForCategory(trade);
                    }}
                    data-attr={`vendor-default-add-${trade}`}
                  >
                    Add
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
