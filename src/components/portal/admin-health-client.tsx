"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Clock, MessageSquare, Webhook, Wallet, ClipboardList, type LucideIcon } from "lucide-react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { adminAccountKey } from "@/lib/admin/admin-account-keys";
import type { AdminHealth, AdminHealthGroupId, AdminHealthRow } from "@/lib/admin/admin-health.server";

const FETCH_TIMEOUT_MS = 20_000;

const GROUP_ICON: Record<AdminHealthGroupId, LucideIcon> = {
  sms: MessageSquare,
  webhooks: Webhook,
  disputes: Wallet,
  applications: ClipboardList,
};

/** Tab labels: the group's noun, not a sentence. */
const GROUP_TAB_LABEL: Record<AdminHealthGroupId, string> = {
  sms: "Texts",
  webhooks: "Webhooks",
  disputes: "Disputes",
  applications: "Applications",
};

function groupFromParam(raw: string | null, groups: AdminHealth["groups"]): AdminHealthGroupId {
  const match = groups.find((g) => g.id === raw);
  return match ? match.id : (groups.find((g) => g.rows.length > 0) ?? groups[0])?.id ?? "sms";
}

/**
 * Health: what is failing or stuck right now, one tab per kind. Every row
 * opens the account it belongs to; nothing here retries or changes anything
 * (no existing retry action covers these rows).
 */
export function AdminHealthClient() {
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setLoadError(null);
    setHealth(null);
    setTick((n) => n + 1);
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/health", {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as Partial<AdminHealth> & { error?: string };
        if (cancelled) return;
        if (!res.ok || !json.groups) {
          setLoadError(json.error ?? "Could not load health.");
          return;
        }
        setHealth({ groups: json.groups });
      } catch {
        if (!cancelled) setLoadError("Could not load health.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const groups = useMemo(() => health?.groups ?? [], [health]);
  const active = groupFromParam(searchParams.get("group"), groups);
  const activeGroup = groups.find((g) => g.id === active);
  const rows = useMemo(() => activeGroup?.rows ?? [], [activeGroup]);

  const tabs = groups.map((g) => ({
    id: g.id,
    label: GROUP_TAB_LABEL[g.id],
    count: g.rows.length,
    href: `/admin/health?group=${g.id}`,
    dataAttr: `admin-health-tab-${g.id}`,
  }));

  const openAccount = useCallback(
    (row: AdminHealthRow) => {
      if (row.accountId) navigate(`/admin/axis-users/${encodeURIComponent(adminAccountKey("manager", row.accountId))}`);
    },
    [navigate],
  );

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const bulkActions =
    selected && selected.accountId ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-health-open"
        onClick={() => openAccount(selected)}
      >
        Open
      </Button>
    ) : null;

  const Icon = GROUP_ICON[active];

  return (
    <ManagerPortalPageShell
      title="Health"
      hideTitleOnMobileNav
      navigationProvidesTitle
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinations={tabs}
        activeDestinationId={active}
        destinationAriaLabel="Health category"
      />
      <PortalRecordListSurface
        loading={!health && !loadError}
        loadError={loadError ?? undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={<PortalDataTableEmpty icon="data" message="Nothing is failing here" />}
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-health-list"
      >
        {rows.map((row) => (
          <PortalEntryRow
            key={row.id}
            tile={{ kind: "glyph", icon: row.fact.toLowerCase().includes("error") ? AlertTriangle : Icon, label: GROUP_TAB_LABEL[active] }}
            title={row.title}
            facts={[
              { label: row.fact },
              ...(row.at ? [{ icon: Clock, label: formatPacificDateTime(row.at), srLabel: "When" }] : []),
            ]}
            checked={selectedId === row.id}
            onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
            onOpen={row.accountId ? () => openAccount(row) : undefined}
            dataAttr="admin-health-row"
          />
        ))}
      </PortalRecordListSurface>
    </ManagerPortalPageShell>
  );
}
