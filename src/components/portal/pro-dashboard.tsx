"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import {
  getPartnerInquiryWindows,
  readPartnerInquiries,
  readPlannedEvents,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { ADMIN_UI_EVENT } from "@/lib/demo-admin-ui";
import {
  PROPERTY_PIPELINE_EVENT,
  readScopedExtraListings,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import {
  chargeDueLabel,
  HOUSEHOLD_CHARGES_EVENT,
  householdChargeManagerBucket,
  isHouseholdChargeOverdue,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import {
  LEASE_PIPELINE_EVENT,
  readLeasePipeline,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  readManagerPaymentsLedgerCharges,
  unpaidManagerPaymentCharges,
} from "@/lib/manager-payments-scope";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import {
  applicationVisibleToPortalUser,
  moduleRowVisibleToPortalUser,
} from "@/lib/manager-portfolio-access";
import {
  bucketByMonth,
  lastNMonths,
  mergeMonthlyCashflow,
  parseMoneyLabel,
} from "@/lib/portal-monthly-profit";
import {
  MANAGER_WORK_ORDERS_EVENT,
  readManagerWorkOrderRows,
  syncManagerWorkOrdersFromServer,
} from "@/lib/manager-work-orders-storage";
import {
  readAllServiceRequests,
  SERVICE_REQUESTS_EVENT,
  syncServiceRequestsFromServer,
} from "@/lib/service-requests-storage";
import {
  MANAGER_OUTGOING_PAYMENTS_EVENT,
  readManagerOutgoingExpenses,
  syncManagerOutgoingExpensesFromServer,
} from "@/lib/manager-outgoing-payments";
import {
  countUnopenedPersistedInbox,
  loadPersistedInbox,
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  syncPersistedInboxFromServer,
} from "@/lib/portal-inbox-storage";
import {
  ManagerPortalPageShell,
  portalDashboardWelcomeSubtitle,
  PORTAL_DASHBOARD_STACK,
  PortalDashboardKpiRow,
  PortalDashboardKpiTile,
  formatCompactChargeLine,
  formatCompactPlacementLine,
} from "@/components/portal/portal-metrics";
import {
  PortalTableExpandChevron,
  isPortalRowClickIgnored,
  usePortalPreviewSlice,
} from "@/components/portal/portal-data-table";
import type { DashboardSectionId } from "@/lib/dashboard-preferences";
import { loadDocumentExpirationSummary } from "@/lib/manager-document-expiry-client";
import { DashboardCustomizeModal } from "@/components/portal/dashboard-customize-modal";
import { useDashboardVisibility } from "@/hooks/use-dashboard-visibility";
import { useAgentPendingActions } from "@/hooks/use-agent-pending-actions";
import {
  pendingActionChipContent,
  type PendingActionListItem,
} from "@/lib/axis-assistant/pending-action-display";
import { SlidersHorizontal } from "lucide-react";
import { PORTAL_FILTER_ICON_CLASS } from "@/components/portal/filter-field-lists";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { DocumentExpirationSummary } from "@/lib/documents/document-expiration";

const BASE = "/portal";

/** Semantic status foreground tokens for the leading issue-row dots. */
const DOT_INFO = "var(--status-approved-fg)";
const DOT_CONFIRMED = "var(--status-confirmed-fg)";

type PillTone = "pending" | "success" | "danger" | "info";

/**
 * Status accent tokens for a whole "Needs attention" group — the header rail,
 * title colour and count badge all read in the group's status colour.
 * Yellow = pending, red = danger/overdue, green = confirmed/active, blue = info.
 */
type AttentionTone = PillTone;
const ATTENTION_TONE: Record<AttentionTone, { fg: string; bg: string }> = {
  danger: { fg: "var(--status-overdue-fg)", bg: "var(--status-overdue-bg)" },
  pending: { fg: "var(--status-pending-fg)", bg: "var(--status-pending-bg)" },
  info: { fg: "var(--status-approved-fg)", bg: "var(--status-approved-bg)" },
  success: { fg: "var(--status-confirmed-fg)", bg: "var(--status-confirmed-bg)" },
};

function sectionAccentDot(tone: AttentionTone): string {
  return ATTENTION_TONE[tone].fg;
}

/** Consistent circular count in attention group headers (including zero). */
function AttentionCountBadge({
  count,
  tone,
  isEmpty,
}: {
  count: number;
  tone: AttentionTone;
  isEmpty: boolean;
}) {
  const accent = ATTENTION_TONE[tone];
  return (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold leading-none tabular-nums [html[data-native]_&]:size-[1.125rem] [html[data-native]_&]:text-[10px]"
      style={
        isEmpty
          ? {
              color: "color-mix(in srgb, var(--muted) 72%, transparent)",
              background: "color-mix(in srgb, var(--muted) 14%, var(--card))",
            }
          : { background: accent.bg, color: accent.fg }
      }
    >
      {count}
    </span>
  );
}

type DashboardServiceAttentionItem = {
  id: string;
  title: string;
  subtitle: string;
  sortKey: number;
  rowTone: AttentionTone;
  pillLabel: string;
};

type DashboardResidentAttentionItem = {
  lease: LeasePipelineRow;
  activated: boolean;
};

/**
 * Compact relative-time label ("in 3d", "2h ago", "now") for time-bearing
 * attention rows — the live, at-a-glance timing the queue leans on. Falls back
 * to `null` for unparseable input so callers can drop the meta entirely.
 */
function relativeFromNow(iso: string | undefined | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - nowMs;
  const past = diff < 0;
  const abs = Math.abs(diff);
  // Floor at every unit so a label never overstates elapsed/remaining time
  // (1h31m reads "in 1h", not "in 2h").
  const min = Math.floor(abs / 60000);
  if (min < 1) return "now";
  const suffix = (n: number, unit: string) => (past ? `${n}${unit} ago` : `in ${n}${unit}`);
  if (min < 60) return suffix(min, "m");
  const hr = Math.floor(min / 60);
  if (hr < 24) return suffix(hr, "h");
  const day = Math.floor(hr / 24);
  if (day < 7) return suffix(day, "d");
  const wk = Math.floor(day / 7);
  return suffix(wk, "w");
}

/** Small theme-aware status pill (light/dark flip via `.portal-badge-*`). */
function StatusPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold portal-badge-${tone} [html[data-native]_&]:text-[9px]`}
    >
      {children}
    </span>
  );
}

/** Dense Linear "issue" row: status dot · label + subtitle · meta · status pill · chevron. */
function IssueRow({
  href,
  dot,
  title,
  subtitle,
  meta,
  pill,
  dataAttr,
}: {
  href: string;
  dot?: string;
  title: string;
  subtitle?: string;
  meta?: string | null;
  pill?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className="group flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--attn-section-bg)_40%,transparent)] [html[data-native]_&]:gap-2.5 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
    >
      {dot ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: dot }} />
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground [html[data-native]_&]:text-[13px]">
          {title}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-xs text-muted [html[data-native]_&]:text-[11px]">
            {subtitle}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-muted sm:block">
          {meta}
        </span>
      ) : null}
      {pill ? <span className="shrink-0">{pill}</span> : null}
      <span
        aria-hidden
        className="shrink-0 text-sm text-muted/40 transition-colors group-hover:text-muted [html[data-native]_&]:hidden"
      >
        ›
      </span>
    </Link>
  );
}

/**
 * One "Needs attention" group, now a collapsible card: a clickable header (tiny
 * uppercase label · count · overflow badge · chevron) over a hairline-bordered
 * stack of dense issue rows (preview-sliced so native/mobile row limits +
 * overflow link are preserved).
 *
 * Collapse behaviour is what makes the dashboard survive a phone: a group opens
 * by default only when it has items, so the wall of "nothing here" empty states
 * collapses to one-line headers. The manager can tap any header to override.
 */
function AttentionGroup<T>({
  title,
  href,
  sectionId,
  tone,
  order = 0,
  badge,
  headerCount,
  items,
  emptyMessage,
  keyForItem,
  renderRow,
}: {
  title: string;
  href: string;
  sectionId: DashboardSectionId;
  /** Status colour for the whole group (rail + title + count when non-empty). */
  tone: AttentionTone;
  /** Stable position for the staggered entrance delay (0-based). */
  order?: number;
  badge?: ReactNode;
  /** When set, shown in the header circle instead of `items.length`. */
  headerCount?: number;
  items: T[];
  emptyMessage: string;
  keyForItem: (item: T) => string;
  renderRow: (item: T, sectionTone: AttentionTone) => ReactNode;
}) {
  const { visible, overflow } = usePortalPreviewSlice(items);
  const { isNative } = useIsNativeApp();
  const count = headerCount ?? items.length;
  const isEmpty = count === 0;
  const accent = ATTENTION_TONE[tone];
  // null → follow the "open when non-empty" default (reactive to async loads);
  // boolean → the manager's explicit tap wins.
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? !isEmpty;

  return (
    <div
      className="pl-attn-enter overflow-hidden rounded-xl border border-border bg-card"
      style={{
        animationDelay: `${Math.min(order, 8) * 55}ms`,
        borderLeftWidth: isEmpty ? undefined : 3,
        borderLeftColor: isEmpty ? undefined : accent.fg,
        background: isEmpty ? undefined : `color-mix(in srgb, ${accent.bg} 32%, var(--card))`,
        // Row hover wash matches this section (IssueRow).
        ["--attn-section-bg" as string]: accent.bg,
        ["--attn-section-fg" as string]: accent.fg,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-attr={`dashboard-attention-toggle-${sectionId}`}
        onClick={() => setOverride(!open)}
        onKeyDown={(e) => {
          if (isPortalRowClickIgnored(e.target)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOverride(!open);
          }
        }}
        className="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-[color-mix(in_srgb,var(--attn-section-bg)_45%,transparent)] [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
      >
        <span className="flex shrink-0 items-center self-center">
          <PortalTableExpandChevron expanded={open} />
        </span>
        <h3
          className="min-w-0 flex-1 self-center text-sm font-semibold leading-none tracking-[-0.01em] [html[data-native]_&]:text-[13px]"
          style={{ color: isEmpty ? "var(--muted)" : accent.fg }}
        >
          {title}
        </h3>
        <span className="flex shrink-0 items-center gap-1.5 self-center">
          <AttentionCountBadge count={count} tone={tone} isEmpty={isEmpty} />
          {badge ? <span className="inline-flex items-center">{badge}</span> : null}
        </span>
        <Link
          href={href}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open ${title}`}
          data-attr="dashboard-attention-link"
          className="ml-auto shrink-0 self-center whitespace-nowrap text-xs font-semibold leading-none hover:underline underline-offset-2 [html[data-native]_&]:text-sm"
          style={{ color: isEmpty ? "var(--muted)" : accent.fg }}
        >
          →
        </Link>
      </div>
      {open ? (
        isEmpty ? (
          <p className="border-t border-border px-3.5 py-2.5 text-xs text-muted [html[data-native]_&]:px-3 [html[data-native]_&]:py-2">
            {emptyMessage}
          </p>
        ) : (
          <div className="border-t border-border">
            <div className="divide-y divide-border/80">
              {visible.map((item) => (
                <Fragment key={keyForItem(item)}>{renderRow(item, tone)}</Fragment>
              ))}
            </div>
            {overflow > 0 ? (
              <div className="border-t border-border/80 px-3.5 py-2 [html[data-native]_&]:px-3">
                <Link
                  href={href}
                  className="inline-block text-xs font-semibold hover:underline underline-offset-2"
                  style={{ color: accent.fg }}
                >
                  {isNative ? `View all (${count}) →` : `View all ${count} →`}
                </Link>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

/**
 * The "AI drafts" attention group: assistant-proposed write actions the manager
 * can approve or discard inline. Approve/Discard route through the SAME gated
 * confirm path used by the assistant chat (the server's `claimPendingAction`
 * re-validates the stored input and runs the handler) — this row is presentation
 * only. It never executes a write client-side and never bypasses the
 * preview/confirm gate. Collapsible like every other attention group.
 */
function AiDraftsGroup({
  items,
  order = 0,
  resolvingId,
  onResolve,
}: {
  items: PendingActionListItem[];
  order?: number;
  resolvingId: string | null;
  onResolve: (
    id: string,
    decision: "confirm" | "deny",
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const accent = ATTENTION_TONE.info;
  const [override, setOverride] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = override ?? true;
  const count = items.length;

  const handle = async (id: string, decision: "confirm" | "deny") => {
    setError(null);
    const res = await onResolve(id, decision);
    if (!res.ok && res.error) setError(res.error);
  };

  return (
    <div
      className="pl-attn-enter overflow-hidden rounded-lg border border-border bg-card"
      style={{
        animationDelay: `${Math.min(order, 8) * 55}ms`,
        borderLeftWidth: 3,
        borderLeftColor: accent.fg,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        data-attr="dashboard-attention-toggle-aiDrafts"
        onClick={() => setOverride(!open)}
        onKeyDown={(e) => {
          if (isPortalRowClickIgnored(e.target)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOverride(!open);
          }
        }}
        className="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-[var(--secondary)] [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
      >
        <span className="flex shrink-0 items-center self-center">
          <PortalTableExpandChevron expanded={open} />
        </span>
        <h3
          className="min-w-0 flex-1 self-center text-sm font-semibold leading-none tracking-[-0.01em] [html[data-native]_&]:text-[13px]"
          style={{ color: accent.fg }}
        >
          AI drafts
        </h3>
        <AttentionCountBadge count={count} tone="info" isEmpty={count === 0} />
        <span className="ml-auto inline-flex shrink-0 items-center self-center gap-1 whitespace-nowrap [html[data-native]_&]:text-xs">
          <StatusPill tone="info">Pending approval</StatusPill>
        </span>
      </div>
      {open ? (
        <div className="border-t border-border">
          <div className="divide-y divide-border">
            {items.map((item) => {
              const { title, subtitle } = pendingActionChipContent(item);
              const busy = resolvingId === item.id;
              return (
                <div
                  key={item.id}
                  data-attr="dashboard-attention-ai-draft"
                  className="flex items-center gap-3 px-3.5 py-2.5 [html[data-native]_&]:gap-2 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2"
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: DOT_INFO }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground [html[data-native]_&]:text-[13px]">
                      {title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted [html[data-native]_&]:text-[11px]">
                      {subtitle}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handle(item.id, "confirm")}
                      data-attr="dashboard-ai-draft-approve"
                      className="rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-white outline-none transition hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50"
                    >
                      {busy ? "…" : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handle(item.id, "deny")}
                      data-attr="dashboard-ai-draft-discard"
                      className="rounded-full border border-border px-3 py-1 text-[11px] font-semibold text-muted outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {error ? (
            <p className="border-t border-border px-3.5 py-2 text-xs text-danger [html[data-native]_&]:px-3">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "soon";
  return formatPacificDateTime(d);
}


function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function ManagerDashboard({ displayName = "there" }: { displayName?: string }) {
  const { userId, ready: authReady } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  // `nowMs` is frozen for the whole session: it only feeds the 6-month cash-flow
  // buckets in the heavy `data` memo, where a boundary stale by minutes is fine.
  const [nowMs] = useState(() => Date.now());
  // `nowTick` is a SEPARATE, lightweight clock that ticks every minute and is
  // used ONLY for the live relative timestamps (tour rows). Keeping it out of the
  // `data` memo deps means the minute tick refreshes the labels without re-running
  // the dashboard's store reads/filters/sorts.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  const [docExpirySummary, setDocExpirySummary] = useState<DocumentExpirationSummary | null>(null);
  const { visibility, setVisible, reset } = useDashboardVisibility(userId);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [residentAccountEmails, setResidentAccountEmails] = useState<Set<string>>(new Set());

  // The assistant dock + AI-draft chips are live, auth-gated manager surfaces:
  // off in the /demo sandbox (which uses its own scripted assistant and must
  // never hit the real, authenticated `/api/agent/*` routes) and until the
  // session is known.
  const assistantEnabled = authReady && !!userId && !isDemoModeActive();
  const {
    items: pendingDrafts,
    resolve: resolveDraft,
    resolvingId: resolvingDraftId,
  } = useAgentPendingActions({ enabled: assistantEnabled });

  useEffect(() => {
    if (!authReady || !userId || isDemoModeActive()) {
      setDocExpirySummary(null);
      return;
    }
    // TTL-guarded: `tick` is bumped by ~10 unrelated store events, so an
    // unguarded fetch here refetched this banner 6x during first paint.
    void loadDocumentExpirationSummary({ userId })
      .then((summary) => {
        if (summary) setDocExpirySummary(summary);
      })
      .catch(() => setDocExpirySummary(null));
  }, [authReady, userId, tick]);

  useEffect(() => {
    if (!authReady || !userId) {
      setResidentAccountEmails(new Set());
      return;
    }
    const emails = [
      ...new Set(
        readLeasePipeline(userId)
          .filter((l) => l.status === "Fully Signed")
          .map((l) => l.residentEmail.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    let cancelled = false;
    if (emails.length === 0) {
      setResidentAccountEmails(new Set());
      return;
    }
    if (isDemoModeActive()) {
      setResidentAccountEmails(new Set(emails));
      return;
    }
    void fetch("/api/manager/resident-account-emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    })
      .then(async (res) => {
        const body = (await res.json()) as { emails?: string[] };
        if (!cancelled && res.ok) {
          setResidentAccountEmails(
            new Set((body.emails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean)),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setResidentAccountEmails(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId, tick]);

  useEffect(() => {
    if (!authReady || !userId) {
      return;
    }
    void Promise.allSettled([
      syncManagerApplicationsFromServer({ managerUserId: userId }),
      syncLeasePipelineFromServer(userId),
      syncPropertyPipelineFromServer(),
      syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY),
      syncHouseholdChargesFromServer(true),
      syncScheduleRecordsFromServer(),
      syncManagerWorkOrdersFromServer(),
      syncServiceRequestsFromServer(),
      syncManagerOutgoingExpensesFromServer(),
    ]).then(bump);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, bump);
    window.addEventListener(LEASE_PIPELINE_EVENT, bump);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    window.addEventListener(ADMIN_UI_EVENT, bump);
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
    window.addEventListener(SERVICE_REQUESTS_EVENT, bump);
    window.addEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, bump);
      window.removeEventListener(LEASE_PIPELINE_EVENT, bump);
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
      window.removeEventListener(ADMIN_UI_EVENT, bump);
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, bump);
      window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, bump);
      window.removeEventListener(SERVICE_REQUESTS_EVENT, bump);
      window.removeEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, [userId, authReady]);

  const data = useMemo(() => {
    void tick;
    if (!userId) return null;

    const allApps = readManagerApplicationRows().filter((a) => applicationVisibleToPortalUser(a, userId));
    const pendingApps = allApps.filter((a) => isSubmittedPendingApplicationRow(a));

    const leases = readLeasePipeline(userId);
    const pendingLeaseRows = leases
      .filter((l) => l.status === "Manager Signature Pending" || l.status === "Resident Signature Pending")
      .sort((a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime());

    // Scoped exactly like /portal/payments — this group's "View all N →" links
    // straight there, so the two must count the same rows (F-PAY-1).
    const charges = readManagerPaymentsLedgerCharges(userId);
    const pendingCharges = unpaidManagerPaymentCharges(charges).sort((a, b) => {
      const aOverdue = isHouseholdChargeOverdue(a);
      const bOverdue = isHouseholdChargeOverdue(b);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const managerWorkOrders = readManagerWorkOrderRows().filter((w) =>
      moduleRowVisibleToPortalUser(w, userId, "services"),
    );
    const pendingServiceRequests = readAllServiceRequests().filter(
      (r) => moduleRowVisibleToPortalUser(r, userId, "services") && r.status === "pending",
    );
    const pendingWorkOrders = managerWorkOrders.filter((w) => w.bucket === "open" || w.bucket === "scheduled");
    const serviceItems: DashboardServiceAttentionItem[] = [
      ...pendingServiceRequests.map((r) => ({
        id: `sr-${r.id}`,
        title: r.offerName || "Add-on service",
        subtitle: [r.residentName || r.residentEmail, r.price].filter(Boolean).join(" · ") || "—",
        rowTone: "pending" as const,
        pillLabel: "Scheduled",
        sortKey: new Date(r.requestedAt).getTime() || 0,
      })),
      ...pendingWorkOrders.map((w) => ({
        id: `wo-${w.id}`,
        title: w.title || "Work order",
        subtitle: [w.propertyName, w.unit].filter(Boolean).join(" · ") || "—",
        rowTone: (w.bucket === "open" ? "danger" : "pending") as AttentionTone,
        pillLabel: w.bucket === "open" ? "Open" : "Scheduled",
        // Undated work sorts first (the list is descending by sortKey). This used to be
        // `Date.now()`, which put it first only incidentally and made the render impure,
        // so two renders in the same tick could order the list differently.
        sortKey: w.scheduledAtIso ? new Date(w.scheduledAtIso).getTime() : Number.MAX_SAFE_INTEGER,
      })),
    ].sort((a, b) => b.sortKey - a.sortKey);
    const pendingServiceCount = serviceItems.length;

    const inboxThreads = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []).filter(
      (t) => t.folder === "inbox" && t.unread,
    );
    const inboxCount = countUnopenedPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []);

    const cutoff = nowMs - 30 * 60 * 1000;
    const tours = [
      ...readPartnerInquiries()
        .filter((r) => r.kind === "tour" && r.status === "pending" && r.managerUserId === userId)
        .flatMap((r) =>
          getPartnerInquiryWindows(r).map((w) => ({
            id: `${r.id}-${w.start}`,
            label: r.name,
            propertyTitle: r.propertyTitle ?? "",
            status: "pending" as const,
            startMs: new Date(w.start).getTime(),
            start: w.start,
          })),
        ),
      ...readPlannedEvents()
        .filter((e) => e.kind === "tour" && e.managerUserId === userId)
        .map((e) => ({
          id: e.id,
          label: e.attendeeName ?? "Confirmed tour",
          propertyTitle: e.propertyTitle ?? "",
          status: "confirmed" as const,
          startMs: new Date(e.start).getTime(),
          start: e.start,
        })),
    ]
      .filter((t) => Number.isFinite(t.startMs) && t.startMs >= cutoff)
      .sort((a, b) => a.startMs - b.startMs);

    const livePropertyCount = readScopedExtraListings(userId).filter(
      (p) => p.adminPublishLive === true,
    ).length;

    const activeResidents = leases
      .filter((l) => l.status === "Fully Signed")
      .sort((a, b) => new Date(b.updatedAtIso).getTime() - new Date(a.updatedAtIso).getTime());

    // Cash-flow trend series (last 6 months), computed from real local stores:
    // payments = PAID charges bucketed by paid/created date; expenses = logged
    // outgoing expenses bucketed by expense date.
    const months = lastNMonths(nowMs, 24);
    const paymentsByMonth = bucketByMonth(
      charges.filter((c) => c.status === "paid"),
      months,
      (c) => c.paidAt ?? c.createdAt,
      (c) => parseMoneyLabel(c.amountLabel || c.balanceLabel),
    );
    const expensesByMonth = bucketByMonth(
      readManagerOutgoingExpenses(),
      months,
      (e) => e.expenseDate,
      (e) => e.amountCents / 100,
    );

    // Leases specifically awaiting the MANAGER's signature (their action).
    const managerSignatureLeaseCount = pendingLeaseRows.filter(
      (l) => l.status === "Manager Signature Pending",
    ).length;
    // Vacant = units actively listed for rent (a live listing is a unit to fill).
    const roomsVacant = livePropertyCount;

    return {
      pendingApps,
      pendingLeaseRows,
      pendingCharges,
      inboxThreads,
      inboxCount,
      serviceItems,
      pendingServiceCount,
      tours,
      livePropertyCount,
      activeResidents,
      paymentsByMonth,
      expensesByMonth,
      managerSignatureLeaseCount,
      roomsVacant,
    };
  }, [tick, userId, nowMs]);

  if (!data) return null;

  const {
    pendingApps,
    pendingLeaseRows,
    pendingCharges,
    inboxThreads,
    inboxCount,
    serviceItems,
    pendingServiceCount,
    tours,
    activeResidents,
    paymentsByMonth,
    expensesByMonth,
    managerSignatureLeaseCount,
    roomsVacant,
  } = data;

  const pendingTours = tours.filter((t) => t.status === "pending");
  // Same Pending/Overdue split the Payments tabs render (F-PAY-1) — a clearing
  // ACH charge counts as Pending on both, never Overdue.
  const overdueCharges = pendingCharges.filter((c) => householdChargeManagerBucket(c) === "overdue");
  const overdueChargeCount = overdueCharges.length;
  const pendingPaymentCount = pendingCharges.length - overdueChargeCount;
  const overdueBalanceLabel = formatUsd(
    overdueCharges.reduce((sum, c) => sum + parseMoneyLabel(c.balanceLabel), 0),
  );

  const residentAttentionItems: DashboardResidentAttentionItem[] = activeResidents.map((lease) => ({
    lease,
    activated: residentAccountEmails.has(lease.residentEmail.trim().toLowerCase()),
  }));

  const residentsSectionTone: AttentionTone =
    residentAttentionItems.length === 0
      ? "success"
      : residentAttentionItems.some((r) => !r.activated)
        ? "pending"
        : "success";

  const paymentsSectionTone: AttentionTone = overdueChargeCount > 0 ? "danger" : "pending";

  const servicesSectionTone: AttentionTone = serviceItems.some((i) => i.rowTone === "danger")
    ? "danger"
    : "pending";

  // Reflect only the sections the manager keeps visible, so the "N open" badge
  // matches what's actually on their dashboard.
  const showAiDrafts = visibility.aiDrafts && pendingDrafts.length > 0;
  const openCount =
    (showAiDrafts ? pendingDrafts.length : 0) +
    (visibility.tours ? pendingTours.length : 0) +
    (visibility.applications ? pendingApps.length : 0) +
    (visibility.leases ? pendingLeaseRows.length : 0) +
    (visibility.residents ? residentAttentionItems.length : 0) +
    (visibility.payments ? pendingCharges.length : 0) +
    (visibility.services ? serviceItems.length : 0) +
    (visibility.inbox ? inboxCount : 0);

  const anyAttentionVisible =
    visibility.aiDrafts ||
    visibility.tours ||
    visibility.applications ||
    visibility.leases ||
    visibility.residents ||
    visibility.payments ||
    visibility.services ||
    visibility.inbox;

  const showDocExpiryBanner =
    docExpirySummary && (docExpirySummary.expired > 0 || docExpirySummary.within30 > 0);
  const docExpiryHref =
    docExpirySummary && docExpirySummary.expired > 0
      ? `${BASE}/documents/library?expiry=expired`
      : `${BASE}/documents/library?expiry=expiring30`;

  return (
    <ManagerPortalPageShell
      title="Dashboard"
      subtitle={portalDashboardWelcomeSubtitle(displayName)}
      hideTitleOnNative
      hideTitleOnMobileNav
      welcomeSubtitle
    >
      {/* Full width: Ask PropLane opens a popup by default, and a
          manager who pins it gets the portal-wide rail from the shell layout
          (`PortalAssistantDockRail`) rather than a dashboard-only column.
          `min-w-0` keeps the horizontally-scrolling KPI row from forcing page
          overflow. */}
      <div className={`min-w-0 ${PORTAL_DASHBOARD_STACK}`}>
        {showDocExpiryBanner ? (
          <Link
            href={docExpiryHref}
            className={`block rounded-lg border px-4 py-3 text-sm transition-opacity hover:opacity-90 ${
              docExpirySummary!.expired > 0 ? "portal-banner-danger" : "portal-banner-pending"
            }`}
            data-attr="dashboard-document-expiry-banner"
          >
            <p className="font-semibold tracking-[-0.01em]">
              Document compliance
              {docExpirySummary!.expired > 0
                ? ` · ${docExpirySummary!.expired} expired`
                : ` · ${docExpirySummary!.within30} expiring within 30 days`}
            </p>
            <p className="mt-0.5 text-xs opacity-90">Open your document library to review renewals →</p>
          </Link>
        ) : null}

        {/* Command center — restrained KPI stat row (scrolls horizontally on narrow screens). */}
        <PortalDashboardKpiRow>
            <PortalDashboardKpiTile
              label="Rooms vacant"
              value={roomsVacant}
              tone={roomsVacant > 0 ? "warning" : "success"}
              emphasis={roomsVacant > 0}
              href={`${BASE}/properties`}
              dataAttr="dashboard-kpi-vacant"
            />
            <PortalDashboardKpiTile
              label="Leases"
              value={pendingLeaseRows.length}
              tone="brand"
              emphasis={managerSignatureLeaseCount > 0 || pendingLeaseRows.length > 0}
              href={`${BASE}/leases`}
              dataAttr="dashboard-kpi-leases"
            />
            <PortalDashboardKpiTile
              label="Applications"
              value={pendingApps.length}
              tone={pendingApps.length > 0 ? "warning" : "brand"}
              emphasis={pendingApps.length > 0}
              href={`${BASE}/applications`}
              dataAttr="dashboard-kpi-applications"
            />
            <PortalDashboardKpiTile
              label="Overdue"
              value={overdueBalanceLabel}
              tone={overdueChargeCount > 0 ? "danger" : "success"}
              emphasis={overdueChargeCount > 0}
              href={`${BASE}/payments`}
              dataAttr="dashboard-kpi-overdue"
            />
            <PortalDashboardKpiTile
              label="Services"
              value={serviceItems.length}
              tone={serviceItems.length > 0 ? "warning" : "neutral"}
              emphasis={serviceItems.length > 0}
              href={`${BASE}/services/requests`}
              dataAttr="dashboard-kpi-services"
            />
            <PortalDashboardKpiTile
              label="Messages"
              value={inboxCount}
              tone={inboxCount > 0 ? "brand" : "neutral"}
              emphasis={inboxCount > 0}
              href={`${BASE}/communication/inbox/unopened`}
              dataAttr="dashboard-kpi-messages"
            />
        </PortalDashboardKpiRow>

        {/* Financial trend graphs — payments collected vs. expenses, last 6 months. */}
        {visibility.cashflow ? (
          <MonthlyProfitChart points={mergeMonthlyCashflow(paymentsByMonth, expensesByMonth)} />
        ) : null}

        {/* Needs attention — a live, colour-coded queue: big all-caps heading over
            status-railed group cards that stream in with a staggered entrance. */}
        <div className="space-y-4 [html[data-native]_&]:space-y-3">
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="text-primary text-xl leading-none [html[data-native]_&]:text-lg">
              ✦
            </span>
            <h2 className="text-xl font-bold leading-tight tracking-[-0.02em] text-foreground [html[data-native]_&]:text-lg">
              Needs attention
            </h2>
            {openCount > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-[var(--secondary)] px-2.5 py-0.5 text-[11px] font-medium text-muted">
                <span
                  aria-hidden
                  className="pl-attn-pulse size-1.5 rounded-full"
                  style={{ background: DOT_CONFIRMED }}
                />
                {openCount} open
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setCustomizeOpen(true)}
              data-attr="dashboard-customize-open"
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-muted transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <SlidersHorizontal className={PORTAL_FILTER_ICON_CLASS} aria-hidden />
              <span className="[html[data-native]_&]:sr-only">Customize</span>
            </button>
          </div>

          {showAiDrafts ? (
            <AiDraftsGroup
              items={pendingDrafts}
              order={0}
              resolvingId={resolvingDraftId}
              onResolve={resolveDraft}
            />
          ) : null}

          {visibility.tours ? (
            <AttentionGroup
              title="Tour requests"
              href={`${BASE}/calendar`}
              sectionId="tours"
              tone="pending"
              order={0}
              items={pendingTours}
              emptyMessage="No pending tour requests right now."
              keyForItem={(tour) => tour.id}
              renderRow={(tour, sectionTone) => (
                <IssueRow
                  href={`${BASE}/calendar`}
                  dot={sectionAccentDot(sectionTone)}
                  title={tour.label}
                  subtitle={tour.propertyTitle || "—"}
                  meta={[fmt(tour.start), relativeFromNow(tour.start, nowTick)].filter(Boolean).join(" · ")}
                  pill={<StatusPill tone={sectionTone}>Pending</StatusPill>}
                  dataAttr="dashboard-attention-tour"
                />
              )}
            />
          ) : null}

          {visibility.applications ? (
            <AttentionGroup
              title="Applications to approve"
              href={`${BASE}/applications`}
              sectionId="applications"
              tone="pending"
              order={1}
              items={pendingApps}
              emptyMessage="No applications waiting for your review."
              keyForItem={(app) => app.id}
              renderRow={(app: DemoApplicantRow, sectionTone) => (
                <IssueRow
                  href={`${BASE}/applications`}
                  dot={sectionAccentDot(sectionTone)}
                  title={app.name || app.email || "Unknown"}
                  subtitle={app.property || "—"}
                  pill={<StatusPill tone={sectionTone}>{app.stage || "To approve"}</StatusPill>}
                  dataAttr="dashboard-attention-application"
                />
              )}
            />
          ) : null}

          {visibility.leases ? (
            <AttentionGroup
              title="Leases to sign"
              href={`${BASE}/leases`}
              sectionId="leases"
              tone="pending"
              order={2}
              items={pendingLeaseRows}
              emptyMessage="No leases waiting for a signature."
              keyForItem={(lease) => lease.id}
              renderRow={(lease: LeasePipelineRow, sectionTone) => {
                const yourTurn = lease.status === "Manager Signature Pending";
                return (
                  <IssueRow
                    href={`${BASE}/leases`}
                    dot={sectionAccentDot(sectionTone)}
                    title={lease.residentName || lease.residentEmail}
                    subtitle={formatCompactPlacementLine(lease.unit || "—")}
                    meta={lease.signedRentLabel}
                    pill={
                      <StatusPill tone={sectionTone}>
                        {yourTurn ? "Your signature" : "Resident signing"}
                      </StatusPill>
                    }
                    dataAttr="dashboard-attention-lease"
                  />
                );
              }}
            />
          ) : null}

          {visibility.residents ? (
            <AttentionGroup
              title="Residents"
              href={`${BASE}/residents/current`}
              sectionId="residents"
              tone={residentsSectionTone}
              order={3}
              items={residentAttentionItems}
              emptyMessage="No current residents yet."
              keyForItem={(item) => item.lease.id}
              renderRow={(item: DashboardResidentAttentionItem) => {
                const rowTone: AttentionTone = item.activated ? "success" : "pending";
                const lease = item.lease;
                return (
                  <IssueRow
                    href={`${BASE}/residents/current`}
                    dot={sectionAccentDot(rowTone)}
                    title={lease.residentName || lease.residentEmail}
                    subtitle={formatCompactPlacementLine(lease.unit || "—")}
                    meta={lease.signedRentLabel}
                    pill={
                      <StatusPill tone={rowTone}>
                        {item.activated ? "Activated" : "No account yet"}
                      </StatusPill>
                    }
                    dataAttr="dashboard-attention-resident"
                  />
                );
              }}
            />
          ) : null}

          {visibility.payments ? (
            <AttentionGroup
              title="Payments"
              href={`${BASE}/payments`}
              sectionId="payments"
              tone={paymentsSectionTone}
              order={4}
              badge={
                pendingPaymentCount > 0 || overdueChargeCount > 0 ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {pendingPaymentCount > 0 ? (
                      <StatusPill tone="pending">{pendingPaymentCount} pending</StatusPill>
                    ) : null}
                    {overdueChargeCount > 0 ? (
                      <StatusPill tone="danger">{overdueChargeCount} overdue</StatusPill>
                    ) : null}
                  </span>
                ) : null
              }
              items={pendingCharges}
              emptyMessage="No pending or overdue payments right now."
              keyForItem={(charge) => charge.id}
              renderRow={(charge) => {
                const overdue = householdChargeManagerBucket(charge) === "overdue";
                const rowTone: AttentionTone = overdue ? "danger" : "pending";
                return (
                  <IssueRow
                    href={`${BASE}/payments`}
                    dot={sectionAccentDot(rowTone)}
                    title={charge.residentName || charge.residentEmail}
                    subtitle={formatCompactChargeLine(
                      charge.title || "Charge",
                      charge.balanceLabel,
                      chargeDueLabel(charge),
                      { omitBalance: true },
                    )}
                    meta={charge.balanceLabel}
                    pill={<StatusPill tone={rowTone}>{overdue ? "Overdue" : "Pending"}</StatusPill>}
                    dataAttr="dashboard-attention-payment"
                  />
                );
              }}
            />
          ) : null}

          {visibility.services ? (
            <AttentionGroup
              title="Services needed"
              href={`${BASE}/services/requests`}
              sectionId="services"
              tone={servicesSectionTone}
              order={5}
              items={serviceItems}
              emptyMessage="No open or scheduled services right now."
              keyForItem={(item) => item.id}
              renderRow={(item: DashboardServiceAttentionItem) => (
                <IssueRow
                  href={`${BASE}/services/requests`}
                  dot={sectionAccentDot(item.rowTone)}
                  title={item.title}
                  subtitle={item.subtitle}
                  pill={<StatusPill tone={item.rowTone}>{item.pillLabel}</StatusPill>}
                  dataAttr="dashboard-attention-service"
                />
              )}
            />
          ) : null}

          {visibility.inbox ? (
            <AttentionGroup
              title="Unread messages"
              href={`${BASE}/communication/inbox/unopened`}
              sectionId="inbox"
              tone="danger"
              order={6}
              headerCount={inboxCount}
              items={inboxThreads}
              emptyMessage="No unread messages. Communication is clear."
              keyForItem={(thread) => thread.id}
              renderRow={(thread, sectionTone) => (
                <IssueRow
                  href={`${BASE}/communication/inbox/unopened`}
                  dot={sectionAccentDot(sectionTone)}
                  title={thread.from || "Unknown sender"}
                  subtitle={thread.subject || thread.preview || "—"}
                  pill={<StatusPill tone={sectionTone}>Unread</StatusPill>}
                  dataAttr="dashboard-attention-inbox"
                />
              )}
            />
          ) : null}

          {!anyAttentionVisible ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm text-muted">All attention sections are hidden.</p>
              <button
                type="button"
                onClick={() => setCustomizeOpen(true)}
                className="mt-1 text-xs font-semibold text-primary hover:underline underline-offset-2"
              >
                Customize your dashboard →
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <DashboardCustomizeModal
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        visibility={visibility}
        onToggle={(id, visible) => setVisible(id as DashboardSectionId, visible)}
        onReset={reset}
      />
    </ManagerPortalPageShell>
  );
}
