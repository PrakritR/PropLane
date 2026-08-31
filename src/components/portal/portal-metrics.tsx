"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { PortalPageFooterActions, PortalPageTitleBand } from "@/components/portal/portal-section-action-row";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { PortalPreviewOverflowLink, usePortalPreviewSlice } from "@/components/portal/portal-data-table";
import { formatCompactChargeLine, formatCompactPlacementLine } from "@/lib/portal-mobile-preview";
import { PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { cn } from "@/lib/utils";
import { renderPortalStickyBody } from "@/lib/portal-page-chrome-layout";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { usePortalStickyPageChrome } from "@/hooks/use-portal-sticky-page-chrome";

/** Dashboard / KPI link tiles (manager, resident, admin). */
export const PORTAL_DASHBOARD_TILE_LINK =
  "block rounded-xl border border-border bg-card px-5 py-4 shadow-[var(--shadow-sm)] transition-[border-color,box-shadow,transform] duration-200 hover:border-primary/30 hover:shadow-[var(--shadow-card-hover)] hover:-translate-y-0.5 active:translate-y-0";

/** Outer card wrapping most portal sections (matches Properties / Managers shell). */
export const PORTAL_SECTION_SURFACE =
  "rounded-2xl border border-border bg-card p-4 text-foreground shadow-[var(--shadow-card)] backdrop-blur-[1px] max-lg:rounded-2xl max-lg:p-3 sm:rounded-[28px] sm:p-6 [html[data-native]_&]:px-3 [html[data-native]_&]:py-3";

/** Scrollable list body below fixed page chrome (Properties, Leases, Residents, Calendar, …). */
export const PORTAL_LIST_PAGE_SCROLL_BODY =
  "portal-list-page-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]";

export { PortalPageChrome, PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";

/** Flat manager page shell — content sits on the portal gradient canvas. */
export const PORTAL_PAGE_SHELL_BARE = "relative z-0 min-w-0 w-full";

/** Compact inline unlock / status copy (Payments-style), not a stacked empty-state card. */
export const PORTAL_INLINE_STATUS_NOTICE_CLASS =
  "mb-3 rounded-lg border border-border px-3 py-2.5 text-sm leading-snug sm:mb-4 sm:px-4 sm:py-3";

export const PORTAL_INLINE_UNLOCK_NOTICE_CLASS = `${PORTAL_INLINE_STATUS_NOTICE_CLASS} bg-[var(--status-pending-bg)] text-foreground`;

/** Unlock notice flush against a stacked empty state below (no gap between banner and card). */
export const PORTAL_INLINE_UNLOCK_NOTICE_STACKED_CLASS = `${PORTAL_INLINE_UNLOCK_NOTICE_CLASS} mb-0 rounded-b-none border-b-0`;

/** Subtitle under the Dashboard heading — shared across all portal dashboards. */
export function portalDashboardWelcomeSubtitle(displayName?: string | null): string {
  const trimmed = displayName?.trim();
  return trimmed ? `Welcome, ${trimmed}` : "Welcome";
}

/** Calendar week grid outer frame (matches manager calendar chrome). */
export const PORTAL_CALENDAR_FRAME =
  "overflow-hidden rounded-2xl border border-border bg-accent/40 [html[data-theme=dark]_&]:portal-calendar-grid";

/** Pill toggles: Day / Week / Month (Managers filter style). */
export function PortalSegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  optionDisabled,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  /** When true, option is inactive (e.g. paid-only portal arm for Free tier). */
  optionDisabled?: (id: T) => boolean;
}) {
  const pad = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm";
  return (
    <div className="flex w-full max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-accent/30 p-1" role="tablist" aria-label="View">
      {options.map((opt) => {
        const disabled = optionDisabled?.(opt.id) ?? false;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={value === opt.id}
            disabled={disabled}
            onClick={() => {
              if (!disabled) onChange(opt.id);
            }}
            className={`min-h-9 min-w-0 flex-1 basis-0 rounded-full font-semibold transition-all duration-150 ${pad} ${
              disabled
                ? "cursor-not-allowed opacity-45"
                : value === opt.id
                  ? "bg-card text-foreground shadow-[var(--shadow-sm)]"
                  : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Primary page title in portal workspaces (aligned with Axis dashboard). */
export const PORTAL_PAGE_TITLE = "text-[2rem] font-semibold tracking-[-0.03em] text-foreground";

/** Matches admin Managers / Properties filter row (status + tier pill groups). */
export type PortalTierFilterId = "all" | "free" | "pro" | "business";

const TIER_FILTER_OPTIONS: { id: PortalTierFilterId; label: string }[] = [
  { id: "all", label: "All tiers" },
  { id: "free", label: "Free" },
  { id: "pro", label: "Pro" },
  { id: "business", label: "Business" },
];

export function PortalStatusTierFilterBar({
  statusTabs,
  activeStatusId,
  onStatusChange,
  tierFilter,
  onTierChange,
}: {
  statusTabs: { id: string; label: string; count: number }[];
  activeStatusId: string;
  onStatusChange: (id: string) => void;
  tierFilter: PortalTierFilterId;
  onTierChange: (id: PortalTierFilterId) => void;
}) {
  return (
    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl border border-border bg-accent/30 p-1 sm:rounded-full">
        {statusTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onStatusChange(tab.id)}
            className={`flex min-h-9 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 ${
              activeStatusId === tab.id ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="inline-flex flex-wrap items-center gap-1 rounded-2xl border border-border bg-accent/30 p-1 sm:rounded-full">
        {TIER_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onTierChange(opt.id)}
            className={`min-h-9 rounded-full px-4 py-1.5 text-sm font-semibold transition-all duration-150 ${
              tierFilter === opt.id ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export type PortalMetricItem = {
  value: string;
  label: string;
};

/** Large value + muted label (Managers-style stat cards, not selectable). */
export function PortalStatRow({ items }: { items: PortalMetricItem[] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-3">
      {items.map((k) => (
        <div
          key={k.label}
          className="min-w-[10rem] flex-1 rounded-2xl border border-border bg-accent/30 px-5 py-4 sm:min-w-[11rem] sm:flex-none"
        >
          <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">{k.value}</p>
          <p className="mt-1 text-xs font-medium text-muted">{k.label}</p>
        </div>
      ))}
    </div>
  );
}

function tabButtonClass(active: boolean, textAlign: "center" | "left"): string {
  const align = textAlign === "center" ? "text-center" : "text-left";
  return [
    "min-w-[7.5rem] flex-1 basis-[7.5rem] rounded-xl border px-4 py-3 transition-colors duration-150 sm:flex-none sm:basis-auto",
    align,
    active
      ? "border-primary/30 bg-card shadow-[var(--shadow-sm)] ring-1 ring-border"
      : "border-border/60 bg-accent/30 hover:border-border hover:bg-card",
  ].join(" ");
}

/**
 * Selectable KPI tabs (Properties-style): number on top, label below, active = primary border + bottom bar.
 */
export function PortalKpiTabStrip({
  items,
  activeIndex,
  onSelect,
  textAlign = "center",
}: {
  items: PortalMetricItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  textAlign?: "center" | "left";
}) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {items.map((k, i) => {
        const active = i === activeIndex;
        return (
          <button key={k.label} type="button" onClick={() => onSelect(i)} className={tabButtonClass(active, textAlign)}>
            <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">{k.value}</p>
            <p className="mt-1 text-xs font-medium text-muted">{k.label}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Inner well for tables / lists below KPI rows. */
export function PortalContentWell({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]">{children}</div>
  );
}

/** Compact full-width select for mobile section status buckets (Current / Previous, etc.). */
export const PORTAL_MOBILE_STATUS_SELECT_CLASS =
  "h-9 w-auto max-w-[min(100%,18rem)] shrink-0 rounded-full border border-border bg-card px-2.5 pr-8 text-sm font-semibold text-foreground";

/** Mobile inline toolbar: status/tab dropdown + header actions on one row. */
export const PORTAL_MOBILE_TOOLBAR_ROW_CLASS =
  "flex w-full min-w-0 max-md:flex-nowrap max-md:items-center max-md:justify-between max-md:gap-2";

/** Admin portal pattern: pill strip with label + count (Managers / Leases / Applications). */
export function ManagerPortalStatusPills({
  tabs,
  activeId,
  onChange,
  /** `primary` = blue active pill (inbox-style); `monochrome` = text-only active (resident detail). */
  activeTone = "default",
  /** Single-row horizontal scroll with tighter chips (long lease labels on mobile). */
  compact = false,
  /** On phones, use one dropdown instead of a pill strip. */
  mobileSelect = true,
  selectAriaLabel = "Section view",
}: {
  tabs: { id: string; label: string; count: number; alert?: boolean; dataAttr?: string }[];
  activeId: string;
  onChange: (id: string) => void;
  activeTone?: "default" | "primary" | "monochrome";
  compact?: boolean;
  mobileSelect?: boolean;
  selectAriaLabel?: string;
}) {
  const isPrimary = activeTone === "primary";
  const isMonochrome = activeTone === "monochrome";
  const pills = (
    <div
      className={
        compact
          ? "inline-flex max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-accent/30 p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "inline-flex max-w-full flex-wrap items-center gap-x-1 gap-y-2.5 rounded-2xl border border-border bg-accent/30 p-1 sm:rounded-full"
      }
    >
      {tabs.map((tab) => {
        const active = activeId === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            data-attr={tab.dataAttr}
            onClick={() => onChange(tab.id)}
            className={`flex shrink-0 items-center rounded-full font-semibold transition-all duration-150 ${
              compact ? "min-h-8 gap-1 px-2.5 py-1 text-xs" : "min-h-9 gap-1.5 px-4 py-1.5 text-sm"
            } ${
              active
                ? isPrimary
                  ? "bg-primary text-primary-foreground shadow-[var(--shadow-sm)]"
                  : isMonochrome
                    ? "text-foreground underline decoration-border underline-offset-4"
                    : "bg-card text-foreground shadow-[var(--shadow-sm)] [html[data-theme=dark]_&]:portal-status-pill-active"
                : "text-muted hover:text-foreground [html[data-theme=dark]_&]:text-white/78"
            }`}
          >
            {tab.alert ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--status-overdue-fg)]" />
            ) : null}
            {tab.label}
          </button>
        );
      })}
    </div>
  );

  if (!mobileSelect) return pills;

  return (
    <>
      <label className="flex shrink-0 md:hidden">
        <span className="sr-only">{selectAriaLabel}</span>
        <Select
          className={PORTAL_MOBILE_STATUS_SELECT_CLASS}
          value={activeId}
          onChange={(e) => onChange(e.target.value)}
          data-attr="portal-status-mobile-select"
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.label}
            </option>
          ))}
        </Select>
      </label>
      <div className="hidden min-w-0 md:block">{pills}</div>
    </>
  );
}

/** Linked KPI tile on manager / resident dashboards. */
export function PortalDashboardTile({
  label,
  value,
  sub,
  href,
  urgent,
  dataAttr,
}: {
  label: string;
  value: string | number;
  sub?: string;
  href: string;
  urgent?: boolean;
  dataAttr?: string;
}) {
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className={`surface-panel group flex min-h-[88px] flex-col justify-center gap-1 rounded-2xl border p-5 shadow-[var(--shadow-sm)] transition hover:shadow-[var(--shadow-card)] [html[data-native]_&]:min-h-[4.25rem] [html[data-native]_&]:gap-0.5 [html[data-native]_&]:rounded-xl [html[data-native]_&]:p-3.5 ${
        urgent ? "border-[var(--status-pending-bg)] ring-1 ring-[var(--status-pending-bg)]" : "border-border hover:border-primary/25"
      }`}
    >
      <p className="text-[2rem] font-bold leading-none tracking-[-0.03em] text-foreground [html[data-native]_&]:text-[1.5rem]">{value}</p>
      <p className="text-sm font-medium text-muted [html[data-native]_&]:text-xs">{label}</p>
      {sub ? <p className="text-xs text-muted [html[data-native]_&]:text-[11px]">{sub}</p> : null}
    </Link>
  );
}

/** Section title row with optional link (resident / vendor / admin dashboards). */
export function PortalDashboardSectionHeader({
  title,
  href,
  linkLabel,
  badge,
  dataAttr,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  /** Stable notification indicator rendered on the right, next to the section link (e.g. overdue count). */
  badge?: ReactNode;
  dataAttr?: string;
}) {
  const { isNative } = useIsNativeApp();
  const compactLink = isNative && linkLabel ? "→" : linkLabel;

  return (
    <div className="flex items-start justify-between gap-2 [html[data-native]_&]:gap-1.5 sm:items-center sm:gap-3">
      <h2 className="min-w-0 text-xs font-bold uppercase tracking-[0.12em] text-muted [html[data-native]_&]:leading-snug">
        {title}
      </h2>
      {badge || (href && compactLink) ? (
        <div className="flex shrink-0 items-center gap-2 [html[data-native]_&]:gap-1.5">
          {badge ?? null}
          {href && compactLink ? (
            <Link
              href={href}
              data-attr={dataAttr}
              aria-label={isNative && linkLabel ? linkLabel : undefined}
              className="whitespace-nowrap text-xs font-semibold text-primary hover:underline underline-offset-2 [html[data-native]_&]:px-0.5 [html[data-native]_&]:text-sm"
            >
              {compactLink}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Inner card shell for dashboard section panels. */
export const PORTAL_DASHBOARD_SECTION_CARD =
  "rounded-2xl border border-border bg-card p-5 shadow-[0_1px_3px_rgba(15,23,42,0.05)] [html[data-native]_&]:rounded-xl [html[data-native]_&]:p-3";

/** Vertical stack spacing for dashboard sections — tighter on native. */
export const PORTAL_DASHBOARD_STACK = "space-y-5 max-lg:space-y-3 [html[data-native]_&]:space-y-3";

/** KPI row: 2×3 grid on all breakpoints (six manager stats). */
export function PortalDashboardKpiRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-2.5 [&>*]:min-w-0">
      {children}
    </div>
  );
}

/** Small palette for dashboard stat tiles — uses portal status tokens (light + dark safe). */
export type PortalDashboardKpiTone = "brand" | "success" | "warning" | "danger" | "neutral";

const KPI_TONE_STYLES: Record<
  PortalDashboardKpiTone,
  { accent: string; shell: string; value: string; label: string }
> = {
  brand: {
    accent: "border-l-[var(--status-approved-fg)]",
    shell: "bg-[color-mix(in_srgb,var(--status-approved-bg)_42%,var(--card))]",
    value: "text-[var(--status-approved-fg)]",
    label: "text-[color-mix(in_srgb,var(--status-approved-fg)_70%,var(--muted))]",
  },
  success: {
    accent: "border-l-[var(--status-confirmed-fg)]",
    shell: "bg-[color-mix(in_srgb,var(--status-confirmed-bg)_45%,var(--card))]",
    value: "text-[var(--status-confirmed-fg)]",
    label: "text-[color-mix(in_srgb,var(--status-confirmed-fg)_68%,var(--muted))]",
  },
  warning: {
    accent: "border-l-[var(--status-pending-fg)]",
    shell: "bg-[color-mix(in_srgb,var(--status-pending-bg)_50%,var(--card))]",
    value: "text-[var(--status-pending-fg)]",
    label: "text-[color-mix(in_srgb,var(--status-pending-fg)_72%,var(--muted))]",
  },
  danger: {
    accent: "border-l-[var(--status-overdue-fg)]",
    shell: "bg-[color-mix(in_srgb,var(--status-overdue-bg)_48%,var(--card))]",
    value: "text-[var(--status-overdue-fg)]",
    label: "text-[color-mix(in_srgb,var(--status-overdue-fg)_70%,var(--muted))]",
  },
  neutral: {
    accent: "border-l-primary/55",
    shell: "bg-[color-mix(in_srgb,var(--primary)_6%,var(--card))]",
    value: "text-foreground",
    label: "text-muted",
  },
};

/** Restrained KPI tile: centered value on top, label beneath (no subtext). */
export function PortalDashboardKpiTile({
  label,
  value,
  href,
  tone = "neutral",
  emphasis = false,
  dataAttr,
}: {
  label: string;
  value: string | number;
  href: string;
  tone?: PortalDashboardKpiTone;
  /** Stronger value weight when the metric needs attention. */
  emphasis?: boolean;
  dataAttr?: string;
}) {
  const styles = KPI_TONE_STYLES[tone];
  return (
    <Link
      href={href}
      data-attr={dataAttr}
      className={cn(
        "flex min-h-[5.25rem] min-w-0 w-full flex-col items-center justify-between gap-0.5 rounded-xl border border-border border-l-[3px] px-2.5 py-2 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow,transform] duration-150",
        "hover:-translate-y-px hover:border-primary/35 hover:shadow-[0_4px_14px_rgba(15,23,42,0.07)]",
        "sm:min-h-[5.5rem] sm:px-3 sm:py-3 [html[data-native]_&]:min-h-[4.75rem] [html[data-native]_&]:rounded-lg [html[data-native]_&]:px-2 [html[data-native]_&]:py-2",
        styles.accent,
        styles.shell,
      )}
    >
      <span
        className={cn(
          "flex w-full flex-1 items-center justify-center whitespace-nowrap tabular-nums tracking-[-0.02em]",
          "text-[1.5rem] sm:text-[1.65rem] [html[data-native]_&]:text-[1.35rem]",
          emphasis ? "font-bold" : "font-semibold",
          styles.value,
        )}
      >
        {value}
      </span>
      <span
        className={cn(
          "w-full shrink-0 px-0.5 text-center text-[10px] font-medium leading-tight tracking-[-0.01em]",
          "line-clamp-2 sm:text-[11px] [html[data-native]_&]:text-[9px]",
          styles.label,
        )}
      >
        {label}
      </span>
    </Link>
  );
}

/** Compact list row used in dashboard section previews. */
export function PortalDashboardCompactRow({
  title,
  subtitle,
  badge,
  stackBadge,
}: {
  title: string;
  subtitle?: string;
  badge?: ReactNode;
  /** Stack badge below title on narrow/native screens instead of squeezing beside it. */
  stackBadge?: boolean;
}) {
  const { isNative } = useIsNativeApp();
  const stacked = stackBadge ?? isNative;

  return (
    <li
      className={`rounded-xl bg-accent/30 px-3 py-2 [html[data-native]_&]:px-2.5 [html[data-native]_&]:py-1.5 ${
        stacked ? "flex flex-col items-stretch gap-1.5 [html[data-native]_&]:gap-1" : "flex items-start justify-between gap-2.5 [html[data-native]_&]:gap-2"
      }`}
    >
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground [html[data-native]_&]:text-[13px] [html[data-native]_&]:leading-snug">{title}</p>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-muted [html[data-native]_&]:text-[11px] [html[data-native]_&]:leading-snug">{subtitle}</p>
        ) : null}
      </div>
      {badge ? <div className={stacked ? "self-start" : "shrink-0"}>{badge}</div> : null}
    </li>
  );
}

/** Dashboard section list with native/mobile preview limits and optional overflow link. */
export function PortalDashboardPreviewList<T>({
  items,
  href,
  emptyMessage,
  keyForItem,
  renderRow,
}: {
  items: T[];
  href: string;
  emptyMessage: string;
  keyForItem?: (item: T) => string | number;
  renderRow: (item: T) => ReactNode;
}) {
  const { visible, overflow } = usePortalPreviewSlice(items);
  const { isNative } = useIsNativeApp();

  if (items.length === 0) {
    return <p className="mt-3 text-sm text-muted [html[data-native]_&]:mt-2 [html[data-native]_&]:text-xs">{emptyMessage}</p>;
  }

  return (
    <>
      <ul className="mt-3 space-y-1.5 [html[data-native]_&]:mt-2 [html[data-native]_&]:space-y-1">
        {visible.map((item, index) => (
          <Fragment key={keyForItem?.(item) ?? index}>{renderRow(item)}</Fragment>
        ))}
      </ul>
      <PortalPreviewOverflowLink overflow={overflow} href={href} label={isNative ? `View all (${items.length}) →` : undefined} />
    </>
  );
}

export { formatCompactChargeLine, formatCompactPlacementLine };

/** Manager sections aligned with admin portal leases / managers shell. */
export function ManagerPortalPageShell({
  title,
  subtitle,
  titleAside,
  titleInlineFilter,
  titleTrailing,
  filterRow,
  children,
  hideTitleOnNative = false,
  hideTitleOnMobileNav = false,
  welcomeSubtitle = false,
  compactFilterRow = false,
  mobileHideFilterRow = false,
  mobileFlush = false,
  /** Communication thread reading: flex-fill children to the bottom nav on phones. */
  mobileThreadFill = false,
  viewportFillBody = false,
  navigationProvidesTitle = false,
  /** Fixed title + tabs/search; only the body region scrolls (default on). */
  stickyPageChrome = true,
  surfaceCard = false,
  count,
}: {
  title: string;
  subtitle?: string;
  titleAside?: ReactNode;
  /** Filter pill immediately beside the page title (the title band). Pass `null` to opt into the band without a filter. */
  titleInlineFilter?: ReactNode | null;
  /** Inline on the title row (Appendix D4 — direction switch beside page title). */
  titleTrailing?: ReactNode;
  filterRow?: ReactNode;
  children: ReactNode;
  /** Visually hide the page title in the native app (bottom nav shows the section). */
  hideTitleOnNative?: boolean;
  /** Hide page title on mobile when a fixed mobile header shows the section name. */
  hideTitleOnMobileNav?: boolean;
  /** Larger welcome line under the title (portal dashboards). */
  welcomeSubtitle?: boolean;
  /** Tighter filter row spacing (Communication on mobile). */
  compactFilterRow?: boolean;
  /** Omit filter chrome on phones (e.g. Communication thread reading). */
  mobileHideFilterRow?: boolean;
  /** Tighter section chrome on phones (e.g. full-bleed inbox thread). */
  mobileFlush?: boolean;
  /** Flex-fill page body on phones so inbox thread + composer reach the bottom nav. */
  mobileThreadFill?: boolean;
  /** Flex-fill page body at all breakpoints — fixed chrome + scrollable inbox below. */
  viewportFillBody?: boolean;
  /**
   * Top-level queue only: the active portal navigation already names this section.
   * Keeps a semantic h1 while removing the redundant persistent visual title row.
   * Move all page actions into the queue command bar before enabling this.
   */
  navigationProvidesTitle?: boolean;
  /** List pages: pin header/tabs; scroll table or cards in {@link PORTAL_LIST_PAGE_SCROLL_BODY}. */
  stickyPageChrome?: boolean;
  /** Legacy white card shell — default is flat on the page canvas. */
  surfaceCard?: boolean;
  /** Optional record count beside the title. */
  count?: number;
}) {
  const useInlineTitleBand = Boolean(
    hideTitleOnMobileNav &&
      !filterRow &&
      (titleAside != null || titleInlineFilter != null) &&
      (!titleTrailing || titleInlineFilter !== undefined),
  );
  const tightChrome = useInlineTitleBand || compactFilterRow;
  const titleAsideDesktopOnly =
    Boolean(titleAside && filterRow) || Boolean(titleAside && hideTitleOnMobileNav && !useInlineTitleBand);
  const showMobileFooterActions = titleAsideDesktopOnly;
  const showTitleOnMobile = !hideTitleOnMobileNav;
  const filterRowBorder = surfaceCard ? "border-b border-border" : "";
  const pinChrome = stickyPageChrome && !viewportFillBody;
  usePortalStickyPageChrome(pinChrome);
  const fillBody = viewportFillBody || mobileThreadFill || pinChrome;
  const chromeShrink = viewportFillBody || pinChrome ? "shrink-0" : "";
  const bodyChildren = pinChrome ? renderPortalStickyBody(children) : children;
  return (
    <div
      data-slot="portal-page-shell"
      {...(viewportFillBody ? { "data-viewport-fill-body": "" } : {})}
      className={cn(
        surfaceCard ? PORTAL_SECTION_SURFACE : PORTAL_PAGE_SHELL_BARE,
        surfaceCard && "relative z-0 min-w-0 w-full shrink-0",
        mobileFlush &&
          "max-md:rounded-xl max-md:border-0 max-md:bg-transparent max-md:p-0 max-md:shadow-none max-md:backdrop-blur-none",
        fillBody && "flex min-h-0 flex-1 flex-col",
      )}
    >
      {navigationProvidesTitle ? (
        <h1 className="sr-only">{title}</h1>
      ) : useInlineTitleBand ? (
        <PortalPageTitleBand
          className={cn(
            chromeShrink,
            compactFilterRow && "max-lg:mb-0",
            hideTitleOnNative && "[html[data-native]_&_h1]:sr-only",
          )}
          title={title}
          count={count}
          filter={titleInlineFilter}
          titleTrailing={titleTrailing}
          actions={titleAside}
          hideTitleOnMobileNav={hideTitleOnMobileNav}
        />
      ) : (
        <PageHeader
          title={title}
          count={count}
          titleTrailing={titleTrailing}
          primaryAction={titleAside && !titleAsideDesktopOnly ? titleAside : undefined}
          showTitleOnMobile={showTitleOnMobile}
          className={cn(
            chromeShrink,
            compactFilterRow && "!space-y-1.5 max-lg:!space-y-1",
            hideTitleOnNative && "[html[data-native]_&_h1]:sr-only",
            !showTitleOnMobile && "max-md:[&_h1]:sr-only",
            !showTitleOnMobile && titleAside && !titleAsideDesktopOnly && "max-md:mt-3 max-md:w-full [html[data-native]_&]:mt-2",
          )}
        />
      )}
      {subtitle ? (
        <p
          className={cn(
            chromeShrink,
            welcomeSubtitle
              ? "mt-1 text-base font-medium leading-snug text-foreground max-md:text-lg [html[data-native]_&]:text-base"
              : "mt-1 line-clamp-2 text-sm text-muted [html[data-native]_&]:text-xs",
            hideTitleOnNative && "[html[data-native]_&]:sr-only",
            !showTitleOnMobile && !welcomeSubtitle && "max-md:sr-only",
          )}
        >
          {subtitle}
        </p>
      ) : null}
      {titleAside && titleAsideDesktopOnly ? (
        <div className={cn("mt-2 flex w-full flex-wrap items-center justify-end gap-2 max-md:hidden", chromeShrink)}>
          {titleAside}
        </div>
      ) : null}
      {filterRow ? (
        <>
          <div
            className={cn(
              compactFilterRow
                ? `mt-2 ${filterRowBorder} pb-1.5 max-md:mt-0 max-md:pb-1 sm:mt-2 sm:pb-2 [html[data-native]_&]:mt-1.5 [html[data-native]_&]:pb-2`
                : `mt-4 ${filterRowBorder} pb-4 sm:mt-6 sm:pb-6 [html[data-native]_&]:mt-2.5 [html[data-native]_&]:pb-2.5`,
              mobileHideFilterRow && "max-md:hidden",
              mobileFlush && "max-md:mt-0 max-md:border-0 max-md:pb-0",
              pinChrome && "shrink-0",
            )}
          >
            <div className={cn(PORTAL_MOBILE_TOOLBAR_ROW_CLASS, "md:contents")}>{filterRow}</div>
          </div>
          <div
            className={cn(
              compactFilterRow
                ? "mt-1.5 sm:mt-2 [html[data-native]_&]:mt-1.5"
                : "mt-4 sm:mt-6 [html[data-native]_&]:mt-2.5",
              mobileHideFilterRow && "max-md:mt-0",
              mobileFlush && "max-md:mt-0",
              fillBody && "flex min-h-0 flex-1 flex-col",
            )}
          >
            {bodyChildren}
          </div>
        </>
      ) : (
        <div
          className={cn(
            tightChrome
              ? "mt-1.5 max-lg:mt-0 sm:mt-2 [html[data-native]_&]:mt-0"
              : "mt-4 sm:mt-6 max-lg:mt-0 [html[data-native]_&]:mt-0",
            mobileThreadFill && !viewportFillBody && !pinChrome && "max-md:mt-0 max-md:flex max-md:min-h-0 max-md:flex-1 max-md:flex-col",
            (viewportFillBody || pinChrome) && "mt-0 flex min-h-0 flex-1 flex-col",
          )}
        >
          {bodyChildren}
        </div>
      )}
      {showMobileFooterActions ? (
        <PortalPageFooterActions className="md:hidden">{titleAside}</PortalPageFooterActions>
      ) : null}
    </div>
  );
}

/** Table header cell class (admin leases / managers / portal tabs).
 *  `w-0` pairs with {@link PORTAL_TABLE_TD}'s `max-w-0` under `table-fixed` so data
 *  columns share the remaining width instead of shrinking to header label width. */
export const MANAGER_TABLE_TH =
  "portal-table-th w-0 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted sm:px-5";

/** Shared toolbar shell for filters/toggles in portal tabs. */
export const PORTAL_TOOLBAR_GROUP =
  "inline-flex max-w-full flex-wrap items-center gap-1 rounded-full border border-border bg-accent/30 p-1";

/** Shared pill toggle button in portal toolbars. */
export const PORTAL_TOOLBAR_PILL_BUTTON =
  "min-h-9 rounded-full px-4 py-1.5 text-sm font-semibold text-muted transition hover:text-foreground [html[data-theme=dark]_&]:text-white/78";

/** Active variant for toolbar pill buttons. */
export const PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE =
  "bg-card text-foreground shadow-[var(--shadow-sm)] [html[data-theme=dark]_&]:portal-status-pill-active";

/** Label used before toolbar selects (Property/Sort/etc.). */
export const PORTAL_TOOLBAR_LABEL = "text-xs font-semibold text-muted";

/** Shared dropdown style for toolbar selects. */
export const PORTAL_TOOLBAR_SELECT =
  "h-10 appearance-none rounded-full border border-border bg-card px-3.5 pr-9 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring";

/** Wraps a native `<select>` with a trailing chevron (toolbar / filter pills). */
export function PortalToolbarSelectWrap({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative inline-grid min-w-0 [&>*:first-child]:col-start-1 [&>*:first-child]:row-start-1 ${className ?? ""}`.trim()}
    >
      {children}
      <ChevronDown
        className="pointer-events-none col-start-1 row-start-1 mr-3 self-center justify-self-end h-4 w-4 text-muted"
        aria-hidden
      />
    </div>
  );
}

/** Shared action button sizing for page header controls. */
export const PORTAL_HEADER_ACTION_BTN =
  "box-border h-10 rounded-full px-5 text-sm font-semibold max-md:h-9 max-md:px-3.5 max-md:text-xs md:min-h-0 md:py-0 md:leading-none [html[data-native]_&]:h-9 [html[data-native]_&]:px-3.5 [html[data-native]_&]:text-xs";

/** Primary header CTA — transparent border matches outline pills on web. */
export const PORTAL_HEADER_PRIMARY_ACTION_BTN = `${PORTAL_HEADER_ACTION_BTN} md:border md:border-transparent`;

/** Full-width on mobile, auto width from md (header action rows). */
export const PORTAL_HEADER_ACTION_BTN_RESPONSIVE = `w-full shrink-0 md:w-auto ${PORTAL_HEADER_ACTION_BTN}`;

export const PORTAL_HEADER_PRIMARY_ACTION_BTN_RESPONSIVE =
  `w-full shrink-0 md:w-auto ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`;

/** Outline action inside an adaptive command strip — matches Properties Share. */
export const PORTAL_COMMAND_ACTION_BTN =
  "box-border h-10 min-h-10 shrink-0 rounded-lg border border-border bg-card px-3.5 text-sm font-semibold shadow-none";

/** Primary action inside an adaptive command strip — compact, not title-sized. */
export const PORTAL_COMMAND_PRIMARY_ACTION_BTN =
  "portal-command-primary box-border !h-10 !min-h-10 shrink-0 rounded-lg border border-transparent px-3 text-sm font-semibold shadow-none";

export const PORTAL_COMMAND_PRIMARY_ACTION_STYLE: CSSProperties = {
  background: "color-mix(in srgb, var(--btn-primary) 92%, #000)",
};

/** Full-width header tool row (Filter | Reminders | … | primary) — edge-to-edge in the content column. */
export const PORTAL_HEADER_FULL_WIDTH_ACTION_GRID =
  "mb-2 grid w-full gap-2.5 sm:gap-2 [&>div]:min-w-0 [&_button]:w-full [&_button]:min-w-0";

/** Compact toolbar buttons (resident profile sections on mobile). */
export const RESIDENT_DETAIL_HEADER_ACTION_BTN =
  "h-7 shrink-0 whitespace-nowrap rounded-full px-2 text-[10px] font-semibold sm:h-9 sm:px-3.5 sm:text-xs [html[data-native]_&]:h-7 [html[data-native]_&]:px-2 [html[data-native]_&]:text-[10px]";

export const RESIDENT_DETAIL_HEADER_ACTIONS_ROW = cn(
  "flex max-w-full min-w-0 shrink-0 flex-nowrap items-center justify-start gap-1 pb-0.5",
  PORTAL_HORIZONTAL_SCROLL_ROW_CLASS,
  "overscroll-x-contain scroll-px-1 sm:justify-end sm:gap-2 sm:pb-0",
);

/** Desktop-only page actions — pair with {@link PORTAL_FILTER_ACTIONS_MOBILE} in filter rows. */
export const PORTAL_PAGE_ACTIONS_DESKTOP = "hidden shrink-0 flex-wrap items-center justify-end gap-2 lg:flex";

/** Mobile page actions — place inside {@link ManagerPortalFilterRow}. */
export const PORTAL_FILTER_ACTIONS_MOBILE = "flex max-w-full flex-wrap items-center gap-2 lg:hidden";

/** Shared sort dropdown shell for portal section toolbars. */
export function PortalToolbarSortSelect<T extends string>({
  label,
  value,
  onChange,
  options,
  ariaLabel,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  ariaLabel?: string;
}) {
  return (
    <div className="inline-flex min-w-0 items-center gap-2">
      <span className={PORTAL_TOOLBAR_LABEL}>{label}</span>
      <FieldSingleSelect
        hideLabel
        label={ariaLabel ?? label}
        variant="pill"
        value={value}
        options={options.map((opt) => ({ value: opt.value, label: opt.label }))}
        onChange={(next) => onChange(next as T)}
        dataAttr={`portal-sort-${label.toLowerCase().replace(/\s+/g, "-")}`}
      />
    </div>
  );
}

/** Standard filter row wrapper (status pills + optional sort). */
export function ManagerPortalFilterRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full min-w-0 max-w-full flex-wrap items-center gap-4 max-md:gap-2", className)}>
      {children}
    </div>
  );
}

/** Right-aligned property / resident / sort controls inside {@link ManagerPortalFilterRow}. */

/** Status bucket pills with optional right-aligned filters on the same row (Payments-style). */
export function ManagerPortalStatusFilterRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex w-full min-w-0 flex-wrap items-center gap-3 max-md:mb-2 max-md:gap-2", className)}>{children}</div>
  );
}

export function ManagerPortalFilterActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3", className)}>
      {children}
    </div>
  );
}

/** Shared inactive / active chip styles for toolbar toggles (e.g. Events calendar KPI row). */
export const PORTAL_KPI_CHIP_INACTIVE =
  "rounded-xl border border-border/60 bg-accent/30 px-4 py-3 text-left transition-colors duration-150 hover:border-border hover:bg-card";

export const PORTAL_KPI_CHIP_ACTIVE =
  "rounded-xl border border-primary bg-card px-4 py-3 text-left shadow-[inset_0_-3px_0_0_#007aff] ring-1 ring-primary/20 transition-colors duration-150";

export const PORTAL_KPI_CHIP_STATIC =
  "rounded-xl border border-border/60 bg-accent/30 px-4 py-3 text-left";

export const PORTAL_KPI_VALUE = "text-2xl font-bold tabular-nums tracking-tight text-foreground";
export const PORTAL_KPI_LABEL = "mt-1 text-xs font-medium text-muted";
