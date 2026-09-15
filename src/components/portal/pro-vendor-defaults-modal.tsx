"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
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

const ADD_VENDOR_OPTION = "__add_vendor__";

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
        <ul className="space-y-3">
          {VENDOR_TRADE_OPTIONS.map((trade) => {
            const matches = vendorsMatchingTrade(ownVendors, trade);
            const highlighted = focusTrade === trade;
            return (
              <li
                key={trade}
                className={`rounded-xl p-2 ${highlighted ? "bg-accent/30 ring-1 ring-primary/20" : ""}`}
              >
                <FieldSingleSelect
                  label={trade}
                  labelClassName="mb-1 block text-sm font-medium text-foreground"
                  value={defaults[trade] ?? ""}
                  options={[
                    { value: "", label: "No default" },
                    ...matches.map((vendor) => ({ value: vendor.id, label: vendor.name })),
                    // The last option opens Add vendor with this trade preset — what
                    // the separate full-width Add button beside every row used to do.
                    ...(onAddForCategory ? [{ value: ADD_VENDOR_OPTION, label: "+ Add a vendor for this trade…" }] : []),
                  ]}
                  onChange={(value) => {
                    if (value === ADD_VENDOR_OPTION) {
                      onClose();
                      onAddForCategory?.(trade);
                      return;
                    }
                    setDefaults((prev) => {
                      const next = { ...prev };
                      if (value) next[trade] = value;
                      else delete next[trade];
                      return next;
                    });
                  }}
                  dataAttr={`vendor-default-trade-${trade}`}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
