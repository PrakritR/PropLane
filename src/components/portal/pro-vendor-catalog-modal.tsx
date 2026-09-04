"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  makeVendorId,
  MANAGER_VENDORS_EVENT,
  readOwnManagerVendorRows,
  syncManagerVendorsFromServer,
  upsertManagerVendor,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import {
  managerOwnsCatalogVendor,
  searchAxisVendorCatalog,
  vendorCatalogEntryMatchesQuery,
  type AxisCatalogVendor,
} from "@/lib/axis-vendor-catalog";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

export function ManagerVendorCatalogModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { showToast } = useAppUi();
  const { userId } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [sharedCatalog, setSharedCatalog] = useState<ManagerVendorRow[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    void syncManagerVendorsFromServer({ force: true }).then(() => setTick((n) => n + 1));
    setCatalogQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onChange);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onChange);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalogLoading(true);
    void fetch("/api/portal-vendors?catalog=1", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return [];
        const body = (await res.json()) as { rows?: ManagerVendorRow[] };
        return Array.isArray(body.rows) ? body.rows : [];
      })
      .then((rows) => {
        if (!cancelled) setSharedCatalog(rows);
      })
      .catch(() => {
        if (!cancelled) setSharedCatalog([]);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ownVendors = useMemo(() => {
    void tick;
    return readOwnManagerVendorRows(userId);
  }, [tick, userId]);

  const curatedCatalogVisible = useMemo(
    () =>
      searchAxisVendorCatalog(catalogQuery).filter(
        (row) => !managerOwnsCatalogVendor(ownVendors, row.name, row.trade),
      ),
    [catalogQuery, ownVendors],
  );

  const sharedCatalogVisible = useMemo(
    () =>
      sharedCatalog.filter(
        (row) =>
          vendorCatalogEntryMatchesQuery(
            { name: row.name, trade: row.trade, email: row.email, phone: row.phone, notes: row.notes },
            catalogQuery,
          ) && !managerOwnsCatalogVendor(ownVendors, row.name, row.trade),
      ),
    [sharedCatalog, catalogQuery, ownVendors],
  );

  const addCatalogVendor = useCallback(
    (entry: AxisCatalogVendor | ManagerVendorRow) => {
      if (!userId) return;
      const now = new Date().toISOString();
      const name = entry.name.trim();
      const trade = entry.trade.trim() || VENDOR_TRADE_OPTIONS[0]!;
      const existing = ownVendors.find(
        (row) => row.name.trim().toLowerCase() === name.toLowerCase() && row.trade === trade,
      );
      if (existing) {
        showToast(`${name} is already on your vendor list.`);
        return;
      }
      upsertManagerVendor(
        {
          id: makeVendorId(),
          managerUserId: userId,
          name,
          trade,
          phone: entry.phone?.trim() ?? "",
          email: entry.email?.trim() ?? "",
          notes: ("notes" in entry ? entry.notes : "")?.trim() ?? "",
          active: true,
          sharedWithManagers: false,
          createdAt: now,
          updatedAt: now,
        },
        userId,
      );
      showToast(`${name} added to your vendors.`);
    },
    [ownVendors, showToast, userId],
  );

  return (
    <Modal open={open} title="Vendor catalog" onClose={onClose} panelClassName="max-w-lg">
      <div className="space-y-4 text-sm">
        <p className="text-xs text-muted">
          Search curated vendors and vendors shared by other managers on PropLane, then add them to your account.
        </p>
        <Input
          value={catalogQuery}
          onChange={(e) => setCatalogQuery(e.target.value)}
          placeholder="Search by name, trade, city, or ZIP…"
          data-attr="vendor-catalog-search"
        />
        <div className="max-h-[min(24rem,50vh)] space-y-2 overflow-y-auto pr-1">
          {catalogLoading ? <p className="text-xs text-muted">Searching catalog…</p> : null}
          {sharedCatalogVisible.map((row) => (
            <div
              key={`shared-${row.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2"
            >
              <div>
                <p className="font-medium text-foreground">{row.name}</p>
                <p className="text-xs text-muted">
                  {row.trade || "—"}
                  {row.email ? ` · ${row.email}` : ""}
                </p>
                <p className="text-[11px] text-muted">Shared on PropLane</p>
              </div>
              <Button type="button" variant="outline" className="h-8 rounded-full text-xs" onClick={() => addCatalogVendor(row)}>
                Add
              </Button>
            </div>
          ))}
          {curatedCatalogVisible.map((row) => (
            <div
              key={row.catalogId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2"
            >
              <div>
                <p className="font-medium text-foreground">{row.name}</p>
                <p className="text-xs text-muted">
                  {row.trade} · {row.city} · {row.zip}
                </p>
                <p className="text-[11px] text-muted">PropLane catalog</p>
              </div>
              <Button type="button" variant="outline" className="h-8 rounded-full text-xs" onClick={() => addCatalogVendor(row)}>
                Add
              </Button>
            </div>
          ))}
          {!catalogLoading && sharedCatalogVisible.length === 0 && curatedCatalogVisible.length === 0 ? (
            <p className="text-xs text-muted">No catalog matches yet.</p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
