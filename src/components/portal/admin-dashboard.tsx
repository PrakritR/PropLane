"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ManagerPortalPageShell,
  portalDashboardWelcomeSubtitle,
  PORTAL_DASHBOARD_STACK,
} from "@/components/portal/portal-metrics";
import { AttentionPanel, KpiCard, PanelShell, type AttentionRow } from "@/components/portal/pro-dashboard-kpis";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDate } from "@/lib/pacific-time";
import { adminAccountCategory, adminAccountKey, ADMIN_ACCOUNT_ROLE_LABEL } from "@/lib/admin/admin-account-keys";
import type { AdminOverview } from "@/lib/admin/admin-overview.server";

const FETCH_TIMEOUT_MS = 20_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function initialsOf(label: string): string {
  return (
    label
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

/**
 * The attention queue, built only from figures the server actually sourced: a
 * count that came back `null` (its source was unreadable) draws no row, and a
 * count of zero draws no row either. Exported for the tests.
 */
export function buildAdminAttentionRows(overview: AdminOverview): AttentionRow[] {
  const rows: AttentionRow[] = [];
  if (overview.openFeedback !== null && overview.openFeedback > 0) {
    rows.push({
      id: "feedback",
      title: `${plural(overview.openFeedback, "feedback item")} open`,
      detail: "",
      actionLabel: "Review",
      href: "/admin/bugs-feedback",
      tone: "pending",
    });
  }
  if (overview.smsFailures24h !== null && overview.smsFailures24h > 0) {
    rows.push({
      id: "sms-failures",
      title: `${plural(overview.smsFailures24h, "text")} failed in the last 24 hours`,
      detail: "",
      actionLabel: "Review",
      href: "/admin/health",
      tone: "danger",
    });
  }
  if (overview.openDisputes !== null && overview.openDisputes > 0) {
    rows.push({
      id: "disputes",
      title: `${plural(overview.openDisputes, "Stripe dispute")} open`,
      detail: "",
      actionLabel: "Review",
      href: "/admin/health",
      tone: "danger",
    });
  }
  if (overview.managersWithoutPayouts > 0) {
    rows.push({
      id: "payouts",
      title: `${plural(overview.managersWithoutPayouts, "manager")} without payouts set up`,
      detail: "",
      actionLabel: "Review",
      href: "/admin/axis-users?category=management",
      tone: "pending",
    });
  }
  return rows;
}

export function AdminDashboard({ displayName }: { displayName: string }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const retry = useCallback(() => {
    setError(null);
    setOverview(null);
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/overview", {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as Partial<AdminOverview> & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "Could not load the dashboard.");
          return;
        }
        setOverview(json as AdminOverview);
      } catch {
        if (!cancelled) setError("Could not load the dashboard.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
    >
      <div className={PORTAL_DASHBOARD_STACK}>
        {error ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center" data-attr="admin-dashboard-error">
            <p className="text-[15px] font-semibold text-foreground">{error}</p>
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : !overview ? (
          <PortalDataTableEmpty icon="data" message="Loading…" />
        ) : (
          <>
            {/* Hairline KPI cards. A card whose figure could not be sourced is left out, never zeroed. */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <KpiCard
                label="Managers"
                value={String(overview.activeManagers)}
                detail="Active"
                href="/admin/axis-users?category=management"
                dataAttr="admin-dashboard-kpi-managers"
              />
              <KpiCard
                label="Residents"
                value={String(overview.activeResidents)}
                detail="Active"
                href="/admin/axis-users?category=resident"
                dataAttr="admin-dashboard-kpi-residents"
              />
              <KpiCard
                label="Vendors"
                value={String(overview.activeVendors)}
                detail="Active"
                href="/admin/axis-users?category=vendor"
                dataAttr="admin-dashboard-kpi-vendors"
              />
              {overview.openFeedback !== null ? (
                <KpiCard
                  label="Open feedback"
                  value={String(overview.openFeedback)}
                  href="/admin/bugs-feedback"
                  dataAttr="admin-dashboard-kpi-feedback"
                />
              ) : null}
              {overview.smsFailures24h !== null ? (
                <KpiCard
                  label="Failed texts"
                  value={String(overview.smsFailures24h)}
                  detail="Last 24 hours"
                  href="/admin/health"
                  dataAttr="admin-dashboard-kpi-sms-failures"
                />
              ) : null}
              {overview.openDisputes !== null ? (
                <KpiCard
                  label="Open disputes"
                  value={String(overview.openDisputes)}
                  href="/admin/health"
                  dataAttr="admin-dashboard-kpi-disputes"
                />
              ) : null}
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <AttentionPanel
                rows={buildAdminAttentionRows(overview)}
                hideRowDetail
                emptyCopy="Nothing is waiting on you. Nice."
              />
              {overview.recentSignups === null ? null : (
              <PanelShell title="Recent sign-ups" dataAttr="admin-dashboard-recent-signups">
                {overview.recentSignups.length === 0 ? (
                  <p className="px-4 py-6 text-center text-[13px] text-muted">No sign-ups yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {overview.recentSignups.map((signup) => (
                      <li key={`${signup.kind}-${signup.id}`}>
                        <Link
                          href={`/admin/axis-users/${encodeURIComponent(adminAccountKey(signup.kind, signup.id))}`}
                          className="flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-[var(--secondary)]"
                          data-attr="admin-dashboard-signup-row"
                          data-category={adminAccountCategory(signup.kind)}
                        >
                          <span
                            aria-hidden
                            className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/[0.08] text-[11px] font-extrabold text-primary"
                          >
                            {initialsOf(signup.name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-foreground">{signup.name}</span>
                            <span className="block truncate text-[12.5px] text-muted">
                              {signup.email && signup.email !== signup.name ? `${signup.email} · ` : ""}
                              {ADMIN_ACCOUNT_ROLE_LABEL[signup.kind]}
                            </span>
                          </span>
                          <span className="shrink-0 text-[12.5px] tabular-nums text-muted">
                            {signup.joinedAt
                              ? formatPacificDate(signup.joinedAt, { month: "short", day: "numeric" })
                              : ""}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelShell>
              )}
            </div>
          </>
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
