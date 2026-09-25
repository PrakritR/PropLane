"use client";

/**
 * The vendor page — Profile · Messages · Check-ins · Jobs.
 *
 * Everything here autosaves: one `useAutosaveDraft` over the editable subset of
 * the row, one Saved mark in the header. The pure rules live in
 * `vendor-messaging.ts` and `vendor-check-ins.ts`; this file only draws them.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ManagerInbox } from "@/components/portal/pro-inbox";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal-styles";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { SaveStatus } from "@/components/ui/save-status";
import { useAutosaveDraft } from "@/hooks/use-autosave-draft";
import { useManagerMessagingNumberStatus } from "@/hooks/use-manager-messaging-number-status";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import type { ManagerVendorSummary } from "@/lib/manager-vendor-summary.server";
import { invalidateManagerVendorSummary, loadManagerVendorSummary } from "@/lib/manager-vendor-summary-client";
import { computeTypicalPriceFromAcceptedBids } from "@/lib/manager-vendor-typical-rates";
import {
  persistManagerVendorToServer,
  readManagerVendorCategorySettings,
  saveManagerVendorCategorySettings,
  upsertManagerVendor,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { MANAGER_WORK_ORDERS_EVENT } from "@/lib/manager-work-orders-storage";
import {
  cadenceId,
  cadenceLabel,
  makeVendorCheckInId,
  nextCheckInAt,
  VENDOR_CHECK_IN_CADENCE_OPTIONS,
  WEEKDAY_LABELS,
  type VendorCheckIn,
  type VendorCheckInOnNoOrSilent,
} from "@/lib/vendor-check-ins";
import {
  normalizeVendorMessaging,
  resolveVendorChannel,
  VENDOR_CHANNELS,
  vendorChannelLabel,
  type VendorChannel,
  type VendorMessaging,
} from "@/lib/vendor-messaging";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import { workOrderDetailHref, vendorDetailHref, type WorkOrderBucketId } from "@/lib/portal-detail-routes";
import { cn } from "@/lib/utils";
import { ArrowRight, BriefcaseBusiness, ChevronDown, ChevronUp, CircleDollarSign, Contact, Star, X } from "lucide-react";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import { formatVendorReviewAggregate, type VendorReviewAggregate } from "@/lib/vendor-reviews";

type ManagerFacingVendorReview = {
  id: string;
  stars: number;
  body: string;
  reviewerLabel: string;
  isOwnWorkspace: boolean;
  vendorReply: string | null;
  createdAt: string;
};

// PLAN-0921-1029, area 2: the manager's OWN vendor kind trims its picker to
// Overview · Services · Invoices · Communication · Documents. "profile",
// "jobs", "pricing", "reviews" and "check-ins" stay valid ids — their content
// now lives inside Overview's own fact cards and the Services tab — so the
// content itself is never deleted, only no longer linked from the picker.
export type VendorDetailTab = "overview" | "profile" | "jobs" | "pricing" | "reviews" | "check-ins" | "services" | "invoices" | "communication" | "documents" | "activity";

/** The editable subset of a vendor row. Everything else on the row is left untouched by a save. */
type VendorDraft = {
  name: string;
  preferredName: string;
  trade: string;
  trades: string[];
  phone: string;
  email: string;
  notes: string;
  preferredLanguage: string;
  preferredChannel: VendorChannel;
  active: boolean;
  propertyIds: string[];
  defaultForTrades: string[];
  messaging: VendorMessaging;
  checkIns: VendorCheckIn[];
};

function draftFromRow(row: ManagerVendorRow, defaultForTrades: string[]): VendorDraft {
  const trades = row.trades?.length ? row.trades : row.trade ? [row.trade] : [];
  return {
    name: row.name ?? "",
    preferredName: row.preferredName ?? "",
    trade: row.trade ?? trades[0] ?? "",
    trades,
    phone: row.phone ?? "",
    email: row.email ?? "",
    notes: row.notes ?? "",
    preferredLanguage: row.preferredLanguage ?? "en",
    preferredChannel: row.preferredChannel ?? "sms",
    active: row.active !== false,
    propertyIds: row.propertyIds ?? [],
    defaultForTrades,
    messaging: normalizeVendorMessaging(row.messaging),
    checkIns: row.checkIns ?? [],
  };
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  dataAttr,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-attr={dataAttr}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[21px] w-[36px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-[2.5px] h-4 w-4 rounded-full bg-white transition-all",
          checked ? "right-[2.5px]" : "left-[2.5px]",
        )}
      />
    </button>
  );
}

export function ChipSelect({
  options,
  value,
  onChange,
  multiple = true,
  dataAttr,
}: {
  options: readonly { id: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  dataAttr?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" data-attr={dataAttr}>
      {options.map((opt) => {
        const on = value.includes(opt.id);
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={on}
            onClick={() => {
              if (multiple) onChange(on ? value.filter((v) => v !== opt.id) : [...value, opt.id]);
              else onChange(on ? [] : [opt.id]);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
              on
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-card text-muted hover:border-foreground/30 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function ChannelSegments({
  value,
  onChange,
  dataAttr,
}: {
  value: VendorChannel;
  onChange: (next: VendorChannel) => void;
  dataAttr?: string;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-full bg-muted/60 p-0.5" data-attr={dataAttr}>
      {VENDOR_CHANNELS.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={value === c.id}
          onClick={() => onChange(c.id)}
          className={cn(
            "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
            value === c.id ? "bg-card text-foreground shadow-sm" : "text-muted hover:text-foreground",
          )}
        >
          {c.short}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children, help, className }: { label: string; children: ReactNode; help?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className={MODAL_FIELD_LABEL_CLASS}>{label}</span>
      {children}
      {help ? <p className="text-xs text-muted">{help}</p> : null}
    </div>
  );
}

const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
] as const;

function greeting(language: string, name: string): string {
  return language === "es" ? `Hola ${name}` : `Hi ${name}`;
}

function jobMoney(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;
}

/**
 * C080: "Typical job" derived from this vendor's own accepted-bid history on
 * completed services, when there is any — a real observed figure rather than
 * the manually entered `typicalRates[0]` rate. Falls back to that manual rate
 * (unchanged label/behavior) when there's no accepted-bid history yet; the
 * manual-rate entry capability itself is untouched (still set via the Edit
 * vendor form / defaults modal).
 */
function typicalJobFigure(
  jobs: readonly Pick<ManagerVendorSummary["jobs"][number], "status" | "acceptedQuoteCents">[],
  row: ManagerVendorRow,
): { label: string; value: string } {
  const completedAcceptedCents = jobs
    .filter((job) => job.status === "completed" || job.status === "paid")
    .map((job) => job.acceptedQuoteCents);
  const derived = computeTypicalPriceFromAcceptedBids(completedAcceptedCents);
  if (derived) {
    return {
      label: "Typical job",
      value: `${jobMoney(derived.averageCents)} · from ${derived.jobCount} completed job${derived.jobCount === 1 ? "" : "s"}`,
    };
  }
  return {
    label: "Typical service",
    value: row.typicalRates?.[0]?.serviceCents != null ? jobMoney(row.typicalRates[0].serviceCents) : "—",
  };
}

/** Summary status is the only client-safe routing signal for a manager-visible job. */
export function managerVendorSummaryJobHref(
  basePath: string,
  job: Pick<ManagerVendorSummary["jobs"][number], "id" | "status">,
): string {
  const bucket: WorkOrderBucketId = job.status === "completed" || job.status === "paid"
    ? "completed"
    : job.status === "scheduled"
      ? "scheduled"
      : "open";
  return workOrderDetailHref(basePath, bucket, job.id);
}

type VendorPreferenceRow = { id: string; propertyId: string; trade: string; vendorId: string; priority: number };

/**
 * N006: an ordered preferred-vendor list per (property, trade), viewed and
 * edited from this vendor's own record page. `suggestVendorsForWorkOrder`
 * consults these rows first, in priority order, before its fairness ranking
 * (`src/lib/work-order-auto-match.ts`). Reordering swaps this row's priority
 * with its neighbor's — small and dependency-free rather than full
 * drag-and-drop.
 */
function VendorPreferredForCard({
  vendorId,
  vendorTrades,
  propertyOptions,
}: {
  vendorId: string;
  vendorTrades: string[];
  propertyOptions: { id: string; label: string }[];
}) {
  const [rows, setRows] = useState<VendorPreferenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [addPropertyId, setAddPropertyId] = useState("");
  const [addTrade, setAddTrade] = useState(vendorTrades[0] ?? VENDOR_TRADE_OPTIONS[0]);

  const refresh = useCallback(() => {
    fetch(`/api/manager/vendor-preferences?vendorId=${encodeURIComponent(vendorId)}`, { credentials: "include" })
      .then((res) => res.json())
      .then((data: { rows?: VendorPreferenceRow[] }) => setRows(data.rows ?? []))
      .catch(() => setRows([]));
  }, [vendorId]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const propertyLabel = (id: string) => propertyOptions.find((p) => p.id === id)?.label ?? id;

  const savePreference = async (propertyId: string, trade: string, priority: number) => {
    const res = await fetch("/api/manager/vendor-preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ propertyId, trade, vendorId, priority }),
    });
    return res.ok;
  };

  const addPreference = async () => {
    if (!addPropertyId || !addTrade) return;
    setBusy(true);
    try {
      const siblingCount = (rows ?? []).filter((r) => r.propertyId === addPropertyId && r.trade === addTrade).length;
      if (await savePreference(addPropertyId, addTrade, siblingCount)) {
        setAddPropertyId("");
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const removePreference = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/manager/vendor-preferences", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ id }),
      });
      if (res.ok) refresh();
    } finally {
      setBusy(false);
    }
  };

  const movePreference = async (row: VendorPreferenceRow, direction: -1 | 1) => {
    const siblings = (rows ?? [])
      .filter((r) => r.propertyId === row.propertyId && r.trade === row.trade)
      .sort((a, b) => a.priority - b.priority);
    const index = siblings.findIndex((r) => r.id === row.id);
    const swapWith = siblings[index + direction];
    if (!swapWith) return;
    setBusy(true);
    try {
      await Promise.all([
        savePreference(row.propertyId, row.trade, swapWith.priority),
        savePreference(swapWith.propertyId, swapWith.trade, row.priority),
      ]);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:col-span-2" data-attr="vendor-preferred-for">
      <h2 className="text-sm font-semibold">Preferred for</h2>
      <p className="mt-1 text-xs text-muted">
        When a property + trade has an ordered preferred-vendor list, assignment suggestions try it first, in order.
      </p>
      {rows === null ? null : rows.length === 0 ? (
        <p className="py-3 text-sm text-muted">Not set as a preferred vendor for any property yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {rows
            .slice()
            .sort((a, b) => a.propertyId.localeCompare(b.propertyId) || a.trade.localeCompare(b.trade) || a.priority - b.priority)
            .map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {propertyLabel(r.propertyId)} · {r.trade}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void movePreference(r, -1)}
                    aria-label="Move up"
                    className="rounded p-1 hover:bg-muted/40 disabled:opacity-40"
                  >
                    <ChevronUp className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void movePreference(r, 1)}
                    aria-label="Move down"
                    className="rounded p-1 hover:bg-muted/40 disabled:opacity-40"
                  >
                    <ChevronDown className="size-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void removePreference(r.id)}
                    aria-label="Remove preference"
                    className="rounded p-1 hover:bg-muted/40 disabled:opacity-40"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </span>
              </li>
            ))}
        </ul>
      )}
      {propertyOptions.length ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Select
            value={addPropertyId}
            onChange={(e) => setAddPropertyId(e.target.value)}
            data-attr="vendor-preferred-add-property"
          >
            <option value="">Choose a property…</option>
            {propertyOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
          <Select value={addTrade} onChange={(e) => setAddTrade(e.target.value)} data-attr="vendor-preferred-add-trade">
            {VENDOR_TRADE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="outline"
            disabled={!addPropertyId || busy}
            onClick={() => void addPreference()}
            data-attr="vendor-preferred-add"
          >
            Add
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function ManagerVendorDetail({
  row,
  managerUserId,
  basePath = "/portal",
  onNavigate,
  detailHref,
  tab: tabProp,
  extraNeedsYou = [],
  onEdit: _onEdit,
  onSendCheckInNow,
}: {
  row: ManagerVendorRow;
  managerUserId: string | null;
  basePath?: string;
  onNavigate: (href: string) => void;
  /** Catalog profiles retain their catalog URL while showing the matched roster record. */
  detailHref?: (tab: VendorDetailTab) => string;
  tab?: VendorDetailTab;
  extraNeedsYou?: readonly { id: string; title: string; detail: string }[];
  onEdit?: () => void;
  /** Slice E wires the real send; until then the button is hidden when absent. */
  onSendCheckInNow?: (checkIn: VendorCheckIn) => Promise<void>;
}) {
  const tab = tabProp ?? "overview";
  const [inboxTab, setInboxTab] = useState<"all" | "trash">("all");
  const messaging = useManagerMessagingNumberStatus();
  const smsAvailable = Boolean(messaging.status?.sendingAvailable && messaging.status?.number);

  const initialDefaults = useMemo(() => {
    const map = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade;
    return Object.entries(map)
      .filter(([, id]) => id === row.id)
      .map(([trade]) => trade);
    // The row id is the identity; re-reading on every row change is what we want.
  }, [managerUserId, row.id]);

  const [draft, setDraft] = useState<VendorDraft>(() => draftFromRow(row, initialDefaults));
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setDraft(draftFromRow(row, initialDefaults));
    setHydrated(false);
    const t = setTimeout(() => setHydrated(true), 0);
    return () => clearTimeout(t);
    // Re-hydrate only when the record changes identity, not on every server echo
    // of our own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const patch = useCallback((next: Partial<VendorDraft>) => setDraft((d) => ({ ...d, ...next })), []);

  const persist = useCallback(
    async (d: VendorDraft) => {
      if (!managerUserId) throw new Error("Not signed in.");
      const now = new Date().toISOString();
      const nextRow: ManagerVendorRow = {
        ...row,
        name: d.name.trim(),
        preferredName: d.preferredName.trim() || undefined,
        trade: d.trades[0] ?? d.trade.trim() ?? VENDOR_TRADE_OPTIONS[0],
        trades: d.trades.length ? d.trades : undefined,
        phone: d.phone.trim(),
        email: d.email.trim(),
        notes: d.notes.trim(),
        preferredLanguage: d.preferredLanguage,
        preferredChannel: d.preferredChannel,
        active: d.active,
        propertyIds: d.propertyIds.length ? d.propertyIds : undefined,
        messaging: d.messaging,
        checkIns: d.checkIns,
        updatedAt: now,
      };
      upsertManagerVendor(nextRow, managerUserId);
      const settings = readManagerVendorCategorySettings(managerUserId).defaultVendorIdByTrade;
      const nextSettings = { ...settings };
      for (const trade of Object.keys(nextSettings)) {
        if (nextSettings[trade] === row.id && !d.defaultForTrades.includes(trade)) delete nextSettings[trade];
      }
      for (const trade of d.defaultForTrades) nextSettings[trade] = row.id;
      if (JSON.stringify(nextSettings) !== JSON.stringify(settings)) {
        saveManagerVendorCategorySettings({ defaultVendorIdByTrade: nextSettings }, managerUserId);
      }
      const ok = await persistManagerVendorToServer(nextRow);
      if (!ok) throw new Error("Could not save vendor.");
      invalidateManagerVendorSummary(managerUserId, row.id);
    },
    [managerUserId, row],
  );

  const autosave = useAutosaveDraft({
    draft,
    enabled: hydrated && Boolean(managerUserId),
    validate: (d) => (d.name.trim() ? null : "Needs a name"),
    save: persist,
  });

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(managerUserId).map((o) => ({ id: o.id, label: o.label })),
    [managerUserId],
  );

  // History amounts are server-projected from stable directory identity, invoices, bids and payouts.
  const [summary, setSummary] = useState<ManagerVendorSummary | null>(null);
  const [summaryState, setSummaryState] = useState<"loading" | "ready" | "error">("loading");
  const summaryRequest = useRef(0);
  const refreshSummary = useCallback((force = false) => {
    const request = ++summaryRequest.current;
    setSummaryState("loading");
    return loadManagerVendorSummary(managerUserId, row.id, force)
      .then((next) => {
        if (summaryRequest.current !== request) return;
        setSummary(next);
        setSummaryState("ready");
      })
      .catch(() => {
        if (summaryRequest.current !== request) return;
        setSummary(null);
        setSummaryState("error");
      });
  }, [managerUserId, row.id]);
  useEffect(() => {
    void refreshSummary();
    return () => { summaryRequest.current += 1; };
  }, [refreshSummary]);
  useEffect(() => {
    const reload = () => {
      invalidateManagerVendorSummary(managerUserId, row.id);
      void refreshSummary(true);
    };
    window.addEventListener(MANAGER_WORK_ORDERS_EVENT, reload);
    return () => window.removeEventListener(MANAGER_WORK_ORDERS_EVENT, reload);
  }, [managerUserId, refreshSummary, row.id]);
  const jobs = summary?.jobs ?? [];
  const openJobs = jobs.filter((job) => job.status !== "completed" && job.status !== "paid");
  const typicalJob = useMemo(() => typicalJobFigure(jobs, row), [jobs, row]);
  const ratings = jobs.filter((job) => job.residentRating != null).map((job) => ({ id: job.id, rating: job.residentRating!, title: job.title }));

  // Manager-authored reviews (stars + notes + a vendor reply) — separate from
  // the resident "was this fixed?" ratings above. Aggregated across every
  // workspace that hired this vendor; another workspace's own review is
  // redacted to "A PropLane manager" server-side (docs/agents/vendor-portal.md).
  const [managerReviews, setManagerReviews] = useState<ManagerFacingVendorReview[] | null>(null);
  const [managerReviewAggregate, setManagerReviewAggregate] = useState<VendorReviewAggregate>({ average: null, count: 0 });
  const [managerReviewsState, setManagerReviewsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    if (tab !== "reviews" && tab !== "overview") return;
    if (!row.vendorUserId) {
      setManagerReviews([]);
      setManagerReviewAggregate({ average: null, count: 0 });
      setManagerReviewsState("ready");
      return;
    }
    let cancelled = false;
    setManagerReviewsState("loading");
    fetch(`/api/portal/vendor-reviews?vendorUserId=${encodeURIComponent(row.vendorUserId)}`)
      .then((res) => res.json())
      .then((data: { reviews?: ManagerFacingVendorReview[]; aggregate?: VendorReviewAggregate; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setManagerReviewsState("error");
          return;
        }
        setManagerReviews(data.reviews ?? []);
        setManagerReviewAggregate(data.aggregate ?? { average: null, count: 0 });
        setManagerReviewsState("ready");
      })
      .catch(() => {
        if (!cancelled) setManagerReviewsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [tab, row.vendorUserId]);

  const callName = draft.preferredName.trim() || draft.name.trim().split(" ")[0] || "there";
  const reach = resolveVendorChannel({
    preferred: draft.preferredChannel,
    phone: draft.phone,
    email: draft.email,
    vendorUserId: row.vendorUserId,
    smsAvailable,
  });

  const fact = (label: string, value: string) => (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <span className="text-[13px] font-medium">{label}</span>
      <span className="min-w-0 break-words text-right text-[13.5px]">{value || "—"}</span>
    </div>
  );

  const propertyLabels = draft.propertyIds.length
    ? propertyOptions.filter((option) => draft.propertyIds.includes(option.id)).map((option) => option.label).join(", ")
    : "Every property";
  const profileCards = (
    <div className="grid gap-3 px-3 pb-4 sm:grid-cols-2 sm:px-4" data-attr="vendor-profile-facts">
      <section className="min-w-0 rounded-xl border border-border bg-card p-4" data-attr="vendor-profile-business">
        <h2 className="text-sm font-semibold">Business</h2>
        {fact("Name", draft.name)}
        {fact("Call them", callName)}
        {fact("Trades", draft.trades.join(", "))}
        {fact("Service area", propertyLabels)}
        {fact("Status", draft.active ? "Active" : "Inactive")}
      </section>
      <section className="min-w-0 rounded-xl border border-border bg-card p-4" data-attr="vendor-profile-contact">
        <h2 className="text-sm font-semibold">Contact</h2>
        {fact("Phone", draft.phone)}
        {fact("Email", draft.email)}
        {fact("Reach them by", vendorChannelLabel(reach.channel))}
        {fact("Language", draft.preferredLanguage === "es" ? "Español" : "English")}
        {fact("Portal account", row.vendorUserId ? "Signed up" : row.invitedAt ? `Invite sent ${formatPacificDateTime(row.invitedAt)}` : "Not invited")}
      </section>
      <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:col-span-2" data-attr="vendor-profile-about">
        <h2 className="text-sm font-semibold">About</h2>
        <p className="mt-3 break-words text-sm text-foreground">{draft.notes.trim() || "—"}</p>
      </section>
      <VendorPreferredForCard vendorId={row.id} vendorTrades={draft.trades} propertyOptions={propertyOptions} />
    </div>
  );

  const overviewLink = (title: string, destination: VendorDetailTab) => (
    <PortalIconAction
      icon={ArrowRight}
      label={`View ${title.toLowerCase()}`}
      onClick={() => onNavigate(detailHref?.(destination) ?? vendorDetailHref(basePath, row.id, destination))}
    />
  );

  return (
    <div className="space-y-3" data-attr="vendor-detail">
      {tab === "overview" || tab === "profile" ? (
        <div className="flex items-center justify-end px-3 sm:px-4">
          <SaveStatus status={autosave} />
        </div>
      ) : (
        <div className="flex items-center justify-end px-3 sm:px-4">
          <SaveStatus status={autosave} />
        </div>
      )}

      {tab === "overview" ? (
        <div className="space-y-4 px-3 pb-4 sm:px-4" data-attr="vendor-overview">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-attr="vendor-overview-metrics">
            {[["Hourly", row.typicalRates?.[0]?.hourlyCents != null ? jobMoney(row.typicalRates[0].hourlyCents) : "—"], [typicalJob.label, typicalJob.value], ["Your completed jobs", summaryState === "ready" ? String(summary?.completedJobCount ?? 0) : "—"], ["Your job ratings", summaryState === "ready" && summary?.ratingAverage != null ? `${summary.ratingAverage} / 5` : "—"]].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border bg-card p-3"><span className="block text-xs font-medium text-muted">{label}</span><strong className="mt-1 block text-base">{value}</strong></div>
            ))}
          </div>
          <div className="grid gap-3 lg:grid-cols-2" data-attr="vendor-overview-desktop" data-mobile-layout="390-compact">
            <section className="min-w-0 rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><Contact className="size-4" aria-hidden />Profile</h2>{overviewLink("Profile", "profile")}</div>{fact("Trade", draft.trades.join(", "))}{fact("Work contact", draft.email || draft.phone)}</section>
            <section className="min-w-0 rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><CircleDollarSign className="size-4" aria-hidden />Pricing</h2>{overviewLink("Pricing", "pricing")}</div>{fact("Hourly", row.typicalRates?.[0]?.hourlyCents != null ? `${jobMoney(row.typicalRates[0].hourlyCents)} / hr` : "—")}{fact(typicalJob.label, typicalJob.value)}</section>
            <section className="min-w-0 rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><BriefcaseBusiness className="size-4" aria-hidden />Services</h2>{overviewLink("Services", "services")}</div>{jobs.slice(0, 2).map((job) => <div key={job.id} className="border-b border-border/60 py-2 last:border-b-0"><p className="truncate text-sm font-medium">{job.title}</p><p className="truncate text-[13px] text-muted">{[job.propertyName, job.unit].filter(Boolean).join(" · ")}</p></div>)}{summaryState === "ready" && jobs.length === 0 ? <p className="py-3 text-sm text-muted">No services with you yet</p> : null}</section>
            <section className="min-w-0 rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-2"><h2 className="flex items-center gap-2 text-sm font-semibold"><Star className="size-4" aria-hidden />Reviews</h2>{overviewLink("Reviews", "reviews")}</div>{fact("Rated jobs", summaryState === "ready" ? String(summary?.ratingCount ?? 0) : "—")}{fact("Average", summaryState === "ready" && summary?.ratingAverage != null ? `${summary.ratingAverage} / 5` : "—")}{fact("Manager reviews", managerReviewsState === "ready" ? formatVendorReviewAggregate(managerReviewAggregate) : "—")}</section>
          </div>
          {summaryState === "error" ? <p role="alert" className="text-sm text-destructive">Could not load vendor history.</p> : null}
          {extraNeedsYou.length ? (
            <div className="space-y-2" data-attr="vendor-needs-you">
              {extraNeedsYou.map((item) => (
                <div key={item.id} className="rounded-xl border border-border bg-card px-3 py-2.5"><strong className="text-[13.5px]">{item.title}</strong></div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "profile" ? profileCards : null}

      {tab === "pricing" ? (
        <div className="grid gap-3 px-3 pb-4 sm:grid-cols-2 sm:px-4" data-attr="vendor-detail-pricing">
          <section className="min-w-0 rounded-xl border border-border bg-card p-4" data-attr="vendor-pricing-published"><h2 className="text-sm font-semibold">Published rates</h2>{fact("Hourly", row.typicalRates?.[0]?.hourlyCents != null ? `${jobMoney(row.typicalRates[0].hourlyCents)} / hr` : "—")}{fact(typicalJob.label, typicalJob.value)}</section>
          <section className="min-w-0 rounded-xl border border-border bg-card p-4" data-attr="vendor-pricing-history"><h2 className="text-sm font-semibold">Your completed jobs</h2>{fact("Jobs", summaryState === "ready" ? String(summary?.completedJobCount ?? 0) : "—")}{fact("Final invoiced", summary?.completedInvoiceTotalCents == null ? "—" : jobMoney(summary.completedInvoiceTotalCents))}{fact("Average final invoice", summary?.completedInvoiceAverageCents == null ? "—" : jobMoney(summary.completedInvoiceAverageCents))}</section>
          {summaryState === "error" ? <p role="alert" className="sm:col-span-2 text-sm text-destructive">Could not load vendor history.</p> : null}
        </div>
      ) : null}

      {tab === "reviews" ? (
        <div className="space-y-5 px-3 pb-4 sm:px-4" data-attr="vendor-detail-reviews">
          <section data-attr="vendor-detail-manager-reviews">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Manager reviews</h2>
              <span className="text-[13px] text-muted">
                {managerReviewsState === "ready" ? formatVendorReviewAggregate(managerReviewAggregate) : "—"}
              </span>
            </div>
            {managerReviewsState === "loading" ? (
              <p className="py-6 text-center text-sm">Loading reviews…</p>
            ) : managerReviewsState === "error" ? (
              <p className="py-6 text-center text-sm">Could not load reviews.</p>
            ) : !managerReviews || managerReviews.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">No reviews from PropLane managers yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {managerReviews.map((review) => (
                  <li key={review.id} className="space-y-1 px-3 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <VendorReviewStarDisplay stars={review.stars} />
                      <span className="text-[13px] text-muted">{review.reviewerLabel}</span>
                    </div>
                    {review.body ? <p className="text-[13.5px]">{review.body}</p> : null}
                    {review.vendorReply ? (
                      <p className="rounded-lg bg-muted/10 px-2.5 py-1.5 text-[13px] text-muted">
                        <span className="font-medium text-foreground">Vendor reply: </span>
                        {review.vendorReply}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section data-attr="vendor-detail-resident-ratings">
            <h2 className="text-sm font-semibold">Resident ratings</h2>
            {summaryState === "loading" ? <p className="py-8 text-center text-sm">Loading ratings…</p> : summaryState === "error" ? <p className="py-8 text-center text-sm">Could not load ratings.</p> : ratings.length === 0 ? <p className="py-8 text-center text-sm">No completed-service ratings from your portfolio yet.</p> : (
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
                {ratings.map((rating) => <li key={rating.id} className="flex items-center justify-between px-3 py-2.5 text-sm"><span>{rating.title}</span><strong>{rating.rating} / 5</strong></li>)}
              </ul>
            )}
          </section>
        </div>
      ) : null}

      {tab === "communication" ? (
        <div className="min-h-[520px] px-1 sm:px-2" data-attr="vendor-detail-inbox">
          <div className="px-2 pb-2 sm:px-3">
            <ManagerPortalStatusPills
              tabs={[
                { id: "all", label: "Active", count: 0 },
                { id: "trash", label: "Archived", count: 0 },
              ]}
              activeId={inboxTab}
              onChange={(id) => setInboxTab(id === "trash" ? "trash" : "all")}
            />
          </div>
          <ManagerInbox
            tabId={inboxTab}
            embeddedInCommunication
            filterVendorEmail={draft.email}
            filterVendorPhone={draft.phone}
            emptyThreadFallback={
              <p className="px-4 py-10 text-center text-sm text-muted">
                No messages with {callName} yet.
              </p>
            }
          />
        </div>
      ) : null}

      {tab === "check-ins" ? (
        <VendorCheckInsTab
          checkIns={draft.checkIns}
          callName={callName}
          language={draft.preferredLanguage}
          defaultChannel={draft.preferredChannel}
          reach={reach}
          propertyOptions={propertyOptions}
          onChange={(checkIns) => patch({ checkIns })}
          onSendNow={onSendCheckInNow}
        />
      ) : null}

      {tab === "jobs" || tab === "services" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-services-list">
          {summaryState === "loading" ? <p className="py-8 text-center text-sm">Loading services…</p> : summaryState === "error" ? <p className="py-8 text-center text-sm">Could not load services.</p> : jobs.length === 0 ? (
            <p className="py-8 text-center text-sm">No services assigned to {callName} yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {jobs.map((job) => {
                return (
                  <li key={job.id}>
                    <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30" onClick={() => onNavigate(managerVendorSummaryJobHref(basePath, job))} aria-label={`Open service ${job.title}`} data-attr="vendor-job-open">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{job.title}</p>
                      <p className="truncate text-[13px]">
                        {[job.propertyName, job.unit].filter(Boolean).join(" · ")}
                      </p>
                      <p className="text-[13px]">Accepted quote {jobMoney(job.acceptedQuoteCents)} · Final invoice {jobMoney(job.finalInvoiceCents)} · Paid {jobMoney(job.paidCents)}</p>
                    </div>
                    <span className="shrink-0 text-[13px]">{job.status}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {tab === "invoices" ? (
        <div className="px-3 pb-4 sm:px-4" data-attr="vendor-invoices-list">
          {summaryState === "loading" ? <p className="py-8 text-center text-sm">Loading invoices…</p> : summaryState === "error" ? <p className="py-8 text-center text-sm">Could not load invoices.</p> : jobs.filter((job) => job.finalInvoiceCents != null).length === 0 ? (
            <p className="py-8 text-center text-sm">No invoices from {callName} yet.</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {jobs.filter((job) => job.finalInvoiceCents != null).map((job) => (
                <li key={job.id}>
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30" onClick={() => onNavigate(managerVendorSummaryJobHref(basePath, job))} data-attr="vendor-invoice-open">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground">{job.title}</p>
                      <p className="truncate text-[13px]">{[job.propertyName, job.unit].filter(Boolean).join(" · ")}</p>
                    </div>
                    <div className="shrink-0 text-right text-[13px]">
                      <strong className="block">{jobMoney(job.finalInvoiceCents)}</strong>
                      <span>{job.paidCents != null && job.paidCents >= (job.finalInvoiceCents ?? 0) ? "Paid" : "Pending"}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  id: String(h),
  label: `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`,
}));

const ON_NO_OPTIONS: { id: VendorCheckInOnNoOrSilent; label: string }[] = [
  { id: "task", label: "Create a task for me, due next morning" },
  { id: "inbox", label: "Notify me in the inbox" },
  { id: "log", label: "Just log it" },
];

function VendorCheckInsTab({
  checkIns,
  callName,
  language,
  defaultChannel,
  reach,
  propertyOptions,
  onChange,
  onSendNow,
}: {
  checkIns: VendorCheckIn[];
  callName: string;
  language: string;
  defaultChannel: VendorChannel;
  reach: ReturnType<typeof resolveVendorChannel>;
  propertyOptions: { id: string; label: string }[];
  onChange: (next: VendorCheckIn[]) => void;
  onSendNow?: (checkIn: VendorCheckIn) => Promise<void>;
}) {
  const [adding, setAdding] = useState(checkIns.length === 0);
  const [question, setQuestion] = useState("");
  const [cadence, setCadence] = useState("biweekly");
  const [weekday, setWeekday] = useState(1);
  const [hour, setHour] = useState(9);
  const [channel, setChannel] = useState<VendorChannel>(defaultChannel);
  const [propertyId, setPropertyId] = useState("");
  const [onNo, setOnNo] = useState<VendorCheckInOnNoOrSilent>("task");
  const [sendingId, setSendingId] = useState<string | null>(null);

  const update = (id: string, next: Partial<VendorCheckIn>) =>
    onChange(checkIns.map((c) => (c.id === id ? { ...c, ...next } : c)));

  const add = () => {
    const q = question.trim();
    if (!q) return;
    const cad = VENDOR_CHECK_IN_CADENCE_OPTIONS.find((o) => o.id === cadence)?.cadence ?? "biweekly";
    const now = new Date();
    const next: VendorCheckIn = {
      id: makeVendorCheckInId(),
      question: q,
      cadence: cad,
      weekday,
      hour,
      minute: 0,
      channel,
      propertyId: propertyId || null,
      enabled: true,
      onNoOrSilent: onNo,
      anchorDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
      createdAt: now.toISOString(),
      log: [],
    };
    onChange([...checkIns, next]);
    setQuestion("");
    setAdding(false);
  };

  return (
    <div className="space-y-4 px-3 pb-4 sm:px-4">
      {checkIns.length === 0 && !adding ? (
        <p className="py-4 text-center text-sm text-muted">No check-ins yet.</p>
      ) : null}
      {checkIns.map((c) => {
        const next = nextCheckInAt(c);
        const last = c.log.at(-1);
        return (
          <div key={c.id} className="rounded-xl border border-border" data-attr="vendor-check-in">
            <div className="flex items-start gap-3 px-3 py-3">
              <Toggle checked={c.enabled} onChange={(enabled) => update(c.id, { enabled })} label="Check-in on" dataAttr="vendor-check-in-enabled" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">“{c.question}”</p>
                <p className="text-xs text-muted">
                  {cadenceLabel(c.cadence)}
                  {typeof c.cadence === "string" ? ` · ${WEEKDAY_LABELS[c.weekday]}` : ""} · {HOURS[c.hour]?.label} ·{" "}
                  {vendorChannelLabel(c.channel ?? defaultChannel)}
                  {next && c.enabled ? (
                    <>
                      {" "}
                      · next <span className="font-semibold text-foreground">{formatPacificDateTime(new Date(next).toISOString())}</span>
                    </>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {c.onNoOrSilent === "task"
                    ? "If “no” or no reply by the next morning → a task for you."
                    : c.onNoOrSilent === "inbox"
                      ? "If “no” or no reply by the next morning → a note in your inbox."
                      : "Replies are logged; nothing else happens."}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {onSendNow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full px-3 py-1 text-xs"
                    disabled={sendingId === c.id || !reach.channel}
                    data-attr="vendor-check-in-send-now"
                    onClick={async () => {
                      setSendingId(c.id);
                      try {
                        await onSendNow(c);
                      } finally {
                        setSendingId(null);
                      }
                    }}
                  >
                    {sendingId === c.id ? "Sending…" : "Send now"}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="danger"
                  className="px-2 py-1 text-xs"
                  data-attr="vendor-check-in-remove"
                  onClick={() => onChange(checkIns.filter((x) => x.id !== c.id))}
                >
                  Remove
                </Button>
              </div>
            </div>
            {c.log.length ? (
              <div className="border-t border-border px-3 py-2">
                <p className="mb-1 text-xs font-semibold text-foreground">Replies</p>
                <ul className="space-y-1 text-xs">
                  {c.log
                    .slice()
                    .reverse()
                    .slice(0, 6)
                    .map((e) => (
                      <li key={e.sentAt} className="flex flex-wrap items-center gap-2">
                        <span className="w-32 shrink-0 text-muted">{formatPacificDateTime(e.sentAt)}</span>
                        {e.reply ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                                e.reply.verdict === "yes" && "bg-emerald-50 text-emerald-700",
                                e.reply.verdict === "no" && "bg-rose-50 text-rose-700",
                                e.reply.verdict === "unclear" && "bg-amber-50 text-amber-700",
                              )}
                            >
                              {e.reply.verdict === "yes" ? "Yes" : e.reply.verdict === "no" ? "No" : "Unclear"}
                            </span>
                            <span className="truncate text-foreground/90">“{e.reply.text}”</span>
                          </>
                        ) : e.ruleRanAt ? (
                          <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">No reply{e.taskId ? " → task created" : ""}</span>
                        ) : (
                          <span className="text-muted">Waiting for a reply</span>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ) : last ? null : null}
          </div>
        );
      })}

      {adding ? (
        <div className="rounded-xl border border-dashed border-border p-3" data-attr="vendor-check-in-form">
          <p className="mb-3 text-sm font-semibold text-foreground">New check-in</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Question"
              className="sm:col-span-2"
              help={`Sent as written, after “${greeting(language, callName)} —”. Variables: {vendor} {property}.`}
            >
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={language === "es" ? "¿Limpiaste hoy?" : "Did you clean today?"}
                data-attr="vendor-check-in-question"
              />
            </Field>
            <Field label="Every">
              <Select value={cadence} onChange={(e) => setCadence(e.target.value)} data-attr="vendor-check-in-cadence">
                {VENDOR_CHECK_IN_CADENCE_OPTIONS.map((o) => (
                  <option key={o.id} value={cadenceId(o.cadence)}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On">
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={String(weekday)}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                  disabled={cadence.startsWith("every") && !["weekly", "biweekly", "monthly"].includes(cadence)}
                  data-attr="vendor-check-in-weekday"
                >
                  {WEEKDAY_LABELS.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </Select>
                <Select value={String(hour)} onChange={(e) => setHour(Number(e.target.value))} data-attr="vendor-check-in-hour">
                  {HOURS.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.label}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Channel">
              <ChannelSegments value={channel} onChange={setChannel} dataAttr="vendor-check-in-channel" />
            </Field>
            {propertyOptions.length ? (
              <Field label="Property (optional)">
                <Select value={propertyId} onChange={(e) => setPropertyId(e.target.value)} data-attr="vendor-check-in-property">
                  <option value="">All of {callName}&apos;s</option>
                  {propertyOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="If “no” or no reply" className="sm:col-span-2">
              <Select value={onNo} onChange={(e) => setOnNo(e.target.value as VendorCheckInOnNoOrSilent)} data-attr="vendor-check-in-on-no">
                {ON_NO_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            {checkIns.length ? (
              <Button type="button" variant="outline" className="rounded-full" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="button" variant="primary" className="rounded-full" disabled={!question.trim()} onClick={add} data-attr="vendor-check-in-add">
              Add check-in
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="w-full rounded-xl border-2 border-dashed border-border py-2.5 text-sm font-semibold text-muted hover:border-foreground/30 hover:text-foreground"
          onClick={() => setAdding(true)}
          data-attr="vendor-check-in-new"
        >
          + Add check-in
        </button>
      )}
    </div>
  );
}
