"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Copy, Power, PowerOff, Tag, Users } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { RecordFactCard, RecordFactRow, RecordRowsCard } from "@/components/portal/portal-record-overview-kit";
import { AdminNewPromoCodeWizard } from "@/components/portal/admin-new-promo-code-wizard";
import { Button } from "@/components/ui/button";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { adminAccountKey } from "@/lib/admin/admin-account-keys";
import { describePromoPlans, formatPromoDate } from "@/lib/admin/promo-code-terms";
import { formatCents } from "@/lib/admin/platform-expense-rules";
import type { AdminPromoCode, AdminPromoCodeList, PromoStatus } from "@/lib/admin/admin-promo-codes.server";

const FETCH_TIMEOUT_MS = 30_000;

const TABS: { id: PromoStatus; label: string }[] = [
  { id: "active", label: "Active" },
  { id: "expired", label: "Expired" },
  { id: "inactive", label: "Inactive" },
];

const EMPTY_COPY: Record<PromoStatus, string> = {
  active: "No active promo codes",
  expired: "No expired promo codes",
  inactive: "No inactive promo codes",
};

const STATUS_LABEL: Record<PromoStatus, string> = { active: "Active", expired: "Expired", inactive: "Inactive" };

function usesLabel(code: Pick<AdminPromoCode, "timesRedeemed" | "maxRedemptions">): string {
  return code.maxRedemptions ? `${code.timesRedeemed} of ${code.maxRedemptions} used` : `${code.timesRedeemed} used`;
}

function expiryLabel(code: Pick<AdminPromoCode, "expiresAt" | "status">): string {
  if (!code.expiresAt) return "No expiry";
  return `${code.status === "expired" ? "Expired" : "Expires"} ${formatPromoDate(code.expiresAt)}`;
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

/**
 * Money > Promo codes. Stripe is the source of truth (decision D1): the list reads Stripe promotion codes
 * with the discounts Stripe applied to invoices, the round + creates a coupon and promotion code, and a
 * row opens the code's record (terms and who redeemed it). Another builder registers this section in
 * the admin nav; the panel only needs its own path.
 */
export function AdminPromoCodesPanel({ detailId }: { detailId?: string } = {}) {
  return detailId ? <PromoCodeRecord id={detailId} /> : <PromoCodeList />;
}

/** The list route; a code's record is `/admin/promo-codes/<id>` (see the admin section renderer). */
const PROMO_CODES_PATH = "/admin/promo-codes";
const promoCodeHref = (id: string) => `${PROMO_CODES_PATH}/${encodeURIComponent(id)}`;

function PromoCodeList() {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const [data, setData] = useState<AdminPromoCodeList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [tab, setTab] = useState<PromoStatus>("active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    setData(null);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/promo-codes", { credentials: "include" }, FETCH_TIMEOUT_MS);
        const json = await readJson<AdminPromoCodeList>(res);
        if (cancelled) return;
        if (!res.ok || !json.codes) {
          setLoadError(json.error ?? "Couldn't reach Stripe.");
          return;
        }
        setData({ codes: json.codes, counts: json.counts });
      } catch {
        if (!cancelled) setLoadError("Couldn't reach Stripe.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.codes ?? []).filter(
      (code) => code.status === tab && (!q || code.code.toLowerCase().includes(q) || code.name.toLowerCase().includes(q)),
    );
  }, [data, tab, query]);
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const copyCode = useCallback(
    async (code: AdminPromoCode) => {
      try {
        await navigator.clipboard.writeText(code.code);
        showToast("Code copied.");
      } catch {
        showToast("Could not copy the code.");
      }
    },
    [showToast],
  );

  const setActive = useCallback(
    async (code: AdminPromoCode, active: boolean) => {
      setBusyId(code.id);
      try {
        const res = await fetch("/api/admin/promo-codes", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: code.id, active }),
        });
        const json = await readJson<Record<string, unknown>>(res);
        if (!res.ok) {
          showToast(json.error ?? "Could not update the code.");
          return;
        }
        showToast(active ? "Code activated." : "Code deactivated.");
        setSelectedId(null);
        reload();
      } catch {
        showToast("Could not update the code.");
      } finally {
        setBusyId(null);
      }
    },
    [reload, showToast],
  );

  const bulkActions = selected ? (
    <>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-promo-open" onClick={() => navigate(promoCodeHref(selected.id))}>
        Open
      </Button>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-promo-copy" onClick={() => void copyCode(selected)}>
        Copy code
      </Button>
      {selected.status === "active" ? (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} disabled={busyId === selected.id} data-attr="admin-promo-deactivate" onClick={() => void setActive(selected, false)}>
          Deactivate
        </Button>
      ) : selected.status === "inactive" ? (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} disabled={busyId === selected.id} data-attr="admin-promo-activate" onClick={() => void setActive(selected, true)}>
          Activate
        </Button>
      ) : null}
    </>
  ) : null;

  return (
    <ManagerPortalPageShell title="Promo codes" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            items={TABS.map((t) => ({
              id: t.id,
              label: t.label,
              count: data?.counts[t.id],
              dataAttr: `admin-promo-tab-${t.id}`,
            }))}
            activeId={tab}
            onChange={(id) => {
              setTab(id as PromoStatus);
              setSelectedId(null);
            }}
            ariaLabel="Promo code status"
          />
        }
        search={{ value: query, onChange: setQuery, placeholder: "Search promo codes", dataAttr: "admin-promo-search", ariaLabel: "Search promo codes" }}
        primary={<PortalPrimaryIconAction label="Add promo code" data-attr="admin-promo-add" onClick={() => setWizardOpen(true)} />}
      />
      <PortalRecordListSurface
        loading={!data && !loadError}
        loadError={loadError ?? undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="data"
            message={query.trim() && (data?.codes.length ?? 0) > 0 ? "No promo codes match your search" : EMPTY_COPY[tab]}
          />
        }
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-promo-list"
      >
        {rows.map((code) => (
          <PortalEntryRow
            key={code.id}
            tile={{ kind: "glyph", icon: Tag, label: "Promo code" }}
            title={code.code}
            place={`${code.summary} · ${describePromoPlans(code.plans)}`}
            facts={[
              { icon: Users, label: usesLabel(code), srLabel: "Uses" },
              { icon: CalendarClock, label: expiryLabel(code), srLabel: "Expiry" },
            ]}
            figure={{ value: code.givenCents > 0 ? `−${formatCents(code.givenCents)}` : formatCents(0), subLabel: "given" }}
            checked={selectedId === code.id}
            onSelectedChange={(on) => setSelectedId(on ? code.id : null)}
            onOpen={() => navigate(promoCodeHref(code.id))}
            dataAttr="admin-promo-row"
          />
        ))}
      </PortalRecordListSurface>
      <AdminNewPromoCodeWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(code) => {
          setWizardOpen(false);
          setTab("active");
          showToast(`${code} created.`);
          reload();
        }}
      />
    </ManagerPortalPageShell>
  );
}

function PromoCodeRecord({ id }: { id: string }) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const [code, setCode] = useState<AdminPromoCode | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/admin/promo-codes?id=${encodeURIComponent(id)}`, { credentials: "include" }, FETCH_TIMEOUT_MS);
        const json = await readJson<{ code?: AdminPromoCode }>(res);
        if (cancelled) return;
        if (res.status === 404 || res.status === 400) {
          setState("missing");
          return;
        }
        if (!res.ok || !json.code) {
          setState("error");
          return;
        }
        setCode(json.code);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, tick]);

  const setActive = async (active: boolean) => {
    if (!code) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/promo-codes", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: code.id, active }),
      });
      const json = await readJson<Record<string, unknown>>(res);
      if (!res.ok) {
        showToast(json.error ?? "Could not update the code.");
        return;
      }
      showToast(active ? "Code activated." : "Code deactivated.");
      setTick((n) => n + 1);
    } catch {
      showToast("Could not update the code.");
    } finally {
      setBusy(false);
    }
  };

  if (state !== "ready" || !code) {
    return (
      <ManagerPortalPageShell title="Promo codes" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null}>
        <PortalDataTableEmpty
          icon="data"
          message={state === "loading" ? "Loading promo code" : state === "missing" ? "Promo code not found" : "Couldn't reach Stripe"}
        />
        {state === "error" ? (
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" onClick={() => setTick((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : null}
      </ManagerPortalPageShell>
    );
  }

  const redemptions = code.redemptions ?? [];

  return (
    <PortalRecordDetailPage
      title={code.code}
      subtitle={code.summary}
      backHref={PROMO_CODES_PATH}
      backLabel="Promo codes"
      iconTitleActions
      actions={
        <PortalRecordActions>
          <PortalIconAction
            ring
            ringPrimary
            icon={Copy}
            label="Copy code"
            data-attr="admin-promo-record-copy"
            onClick={() => {
              void navigator.clipboard.writeText(code.code).then(
                () => showToast("Code copied."),
                () => showToast("Could not copy the code."),
              );
            }}
          />
          {code.status === "active" ? (
            <PortalIconAction ring tone="danger" icon={PowerOff} label="Deactivate" disabled={busy} data-attr="admin-promo-record-deactivate" onClick={() => void setActive(false)} />
          ) : code.status === "inactive" ? (
            <PortalIconAction ring icon={Power} label="Activate" disabled={busy} data-attr="admin-promo-record-activate" onClick={() => void setActive(true)} />
          ) : null}
        </PortalRecordActions>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6">
        <RecordFactCard title="Terms" dataAttr="admin-promo-terms">
          <RecordFactRow label="Status" value={STATUS_LABEL[code.status]} tone={code.status === "active" ? "ok" : undefined} />
          <RecordFactRow label="Discount" value={code.summary} />
          <RecordFactRow label="Applies to" value={describePromoPlans(code.plans)} />
          <RecordFactRow label="New customers only" value={code.firstTimeOnly ? "Yes" : "No"} />
          <RecordFactRow label="Uses" value={usesLabel(code)} />
          <RecordFactRow label="Expires" value={code.expiresAt ? formatPromoDate(code.expiresAt) : "Never"} />
          <RecordFactRow label="Given" value={code.givenCents > 0 ? `−${formatCents(code.givenCents)}` : formatCents(0)} />
          <RecordFactRow label="Created" value={formatPromoDate(code.createdAt)} />
        </RecordFactCard>
        <RecordRowsCard
          title={`Redemptions${redemptions.length ? ` (${redemptions.length})` : ""}`}
          dataAttr="admin-promo-redemptions"
          emptyLabel="Nobody has used this code yet."
          rows={redemptions.map((r) => ({
            id: `${r.customerId}-${r.firstAt}`,
            title: r.name || r.email || r.customerId || "Customer",
            sub: `${r.name && r.email ? `${r.email} · ` : ""}${formatPromoDate(r.firstAt)}`,
            figure: <span className="text-[13.5px] font-semibold tabular-nums">{r.givenCents > 0 ? `−${formatCents(r.givenCents)}` : formatCents(0)}</span>,
            onClick: r.userId ? () => navigate(`/admin/axis-users/${encodeURIComponent(adminAccountKey("manager", r.userId!))}`) : undefined,
          }))}
        />
      </div>
    </PortalRecordDetailPage>
  );
}
