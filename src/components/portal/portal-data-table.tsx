import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { portalListPreviewLimit, sliceForPortalPreview } from "@/lib/portal-mobile-preview";
import { cn } from "@/lib/utils";

/** Outer frame for tabbed portal tables — flat on the page canvas by default. */
export const PORTAL_DATA_TABLE_WRAP = "relative z-0 max-w-full overflow-hidden";

/** Optional card frame when a table needs explicit elevation. */
export const PORTAL_DATA_TABLE_WRAP_CARD =
  "relative z-0 max-w-full overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]";

export const PORTAL_DATA_TABLE_SCROLL = "relative z-0 min-w-0 max-w-full overflow-hidden";

/** Fluid portal table — fits the card width without horizontal scrolling.
 *  Pair {@link MANAGER_TABLE_TH} (`w-0`) with {@link PORTAL_TABLE_TD} (`max-w-0`) so columns fill the width.
 *  Expand chevrons sit inline after the primary label ({@link PortalTableInlineExpand}). */
export const PORTAL_DATA_TABLE =
  "portal-data-table w-full table-fixed border-collapse text-left text-sm";

/** Table header row (use under `<thead>`). */
export const PORTAL_TABLE_HEAD_ROW = "border-b border-border bg-accent/30";

/** Primary data row. */
export const PORTAL_TABLE_TR =
  "border-b border-border/80 transition-colors last:border-0 hover:bg-accent/40";

/** Summary row that expands on click (entire row toggles detail). */
export const PORTAL_TABLE_TR_EXPANDABLE = `${PORTAL_TABLE_TR} cursor-pointer`;

/** @deprecated Trailing expand column — use {@link PortalTableInlineExpand} in the primary column instead. */
export const PORTAL_TABLE_EXPAND_TH =
  "portal-table-expand-th portal-table-th w-0 border-0 p-0";

export function PortalTableExpandChevron({ expanded = false }: { expanded?: boolean }) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return <Icon className="block h-4 w-4 shrink-0 text-muted" aria-hidden />;
}

/** Inline label + expand chevron — chevron sits immediately after primary text (resident dashboard pattern). */
export function PortalTableInlineExpand({
  expanded = false,
  children,
  className = "",
}: {
  expanded?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`}>
      <span className="min-w-0">{children}</span>
      <PortalTableExpandChevron expanded={expanded} />
    </span>
  );
}

/** @deprecated Use {@link PortalTableInlineExpand} in the primary column instead of a trailing expand column. */
export function PortalTableExpandCell({ expanded = false }: { expanded?: boolean }) {
  return (
    <td className="portal-table-expand-td w-0 border-0 p-0 align-middle">
      <PortalTableExpandChevron expanded={expanded} />
    </td>
  );
}

/** Weighted column widths (percent strings) for {@link PortalDataTableColGroup}. */
const PORTAL_TABLE_COLUMN_WEIGHT_PRESETS: Record<number, readonly number[]> = {
  2: [54, 46],
  3: [36, 32, 32],
  4: [26, 22, 28, 24],
  5: [22, 18, 22, 20, 18],
  6: [18, 16, 18, 16, 16, 16],
  7: [16, 14, 16, 14, 14, 13, 13],
  8: [14, 12, 14, 12, 12, 12, 12, 12],
  9: [13, 11, 13, 11, 11, 11, 11, 10, 9],
};

/** Inbox-style tables: party, subject, when. */
export const PORTAL_TABLE_INBOX_COLUMN_WEIGHTS = [28, 40, 32] as const;

/** Inbox Schedule tab: checkbox, recipient, send date & time, subject. */
export const INBOX_SCHEDULE_TABLE_COLUMN_WEIGHTS = [4, 26, 28, 42] as const;

export function portalTableColumnPercents(
  dataColumnCount: number,
  weights?: readonly number[],
): string[] {
  const preset = weights ?? PORTAL_TABLE_COLUMN_WEIGHT_PRESETS[dataColumnCount];
  const w =
    preset ??
    Array.from({ length: dataColumnCount }, () => 100 / Math.max(dataColumnCount, 1));
  const sum = w.reduce((acc, n) => acc + n, 0);
  return w.map((n) => `${((n / sum) * 100).toFixed(4)}%`);
}

/** Optional `<colgroup>` so `table-fixed` columns use the full card width. */
export function PortalDataTableColGroup({ percents }: { percents: readonly string[] }) {
  return (
    <colgroup>
      {percents.map((width, index) => (
        <col key={index} className="min-w-0" style={{ width }} />
      ))}
    </colgroup>
  );
}

/** Last data column when the expand chevron should sit inline (no separate expand column). */
export function PortalTableLastDataCell({
  expanded = false,
  children,
  className = "",
}: {
  expanded?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <td className={`${PORTAL_TABLE_TD} align-middle ${className}`}>
      <PortalTableInlineExpand expanded={expanded}>{children}</PortalTableInlineExpand>
    </td>
  );
}

const PORTAL_ROW_CLICK_IGNORE_SELECTOR =
  "button, a, input, select, textarea, label, [data-portal-row-ignore]";

export function isPortalRowClickIgnored(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(PORTAL_ROW_CLICK_IGNORE_SELECTOR));
}

export function createPortalRowExpandClick(
  onToggle: () => void,
): (event: MouseEvent<HTMLTableRowElement>) => void {
  return (event) => {
    if (isPortalRowClickIgnored(event.target)) return;
    onToggle();
  };
}

/** Expanded detail row (full-width cell below the summary row). */
export const PORTAL_TABLE_DETAIL_ROW = "border-b border-border/80 bg-accent/25 last:border-0";

/** Data cell padding — wraps long values inside {@link PORTAL_DATA_TABLE} instead of scrolling. */
export const PORTAL_TABLE_TD = "max-w-0 break-words px-4 py-4 align-middle text-sm text-foreground/80 sm:px-5 sm:py-[1.125rem]";

/** Compact card shell for mobile portal lists (pair with {@link PortalResponsiveDataView}). */
export const PORTAL_MOBILE_CARD_CLASS =
  "rounded-2xl border border-border bg-card p-3.5 max-lg:rounded-xl max-lg:p-3 [html[data-native]_&]:rounded-xl [html[data-native]_&]:p-2.5";

/** Expanded detail block below a mobile summary card row. */
export const PORTAL_MOBILE_DETAIL_EXPAND =
  "mt-3 border-t border-border pt-4 [html[data-native]_&]:mt-2.5 [html[data-native]_&]:pt-3.5 [&_[data-portal-detail-actions]:last-child]:mb-0";

/** Tighter data cells on native — keeps tabbed lists on one screen longer. */
export const PORTAL_TABLE_TD_COMPACT =
  "px-3 py-3 align-middle text-sm text-foreground/80 sm:px-4 sm:py-3.5 [html[data-native]_&]:px-3 [html[data-native]_&]:py-2.5";

/** List preview limit for dashboard / summary sections (native vs mobile web). */
export function usePortalListPreviewLimit(): number {
  const { isNative } = useIsNativeApp();
  return portalListPreviewLimit(isNative);
}

/** Slice a list for dashboard previews; exposes overflow count for “View all”. */
export function usePortalPreviewSlice<T>(items: T[]): { visible: T[]; overflow: number; limit: number } {
  const { isNative } = useIsNativeApp();
  const limit = portalListPreviewLimit(isNative);
  const { visible, overflow } = sliceForPortalPreview(items, isNative);
  return { visible, overflow, limit };
}

/** Compact summary card for mobile portal tables (residents, applications, payments, …). */
export function PortalMobileSummaryCard({
  title,
  subtitle,
  meta,
  badge,
  trailing,
  onClick,
  expanded,
  children,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  badge?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  expanded?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <div className="flex items-start justify-between gap-2.5">
      <div className="min-w-0 flex-1">
        {onClick ? (
          <PortalTableInlineExpand expanded={expanded} className="text-sm font-semibold text-foreground">
            <span className="truncate">{title}</span>
          </PortalTableInlineExpand>
        ) : (
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
        )}
        {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
        {meta ? <p className="mt-0.5 truncate text-[11px] text-muted/90">{meta}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {trailing}
        {badge}
      </div>
    </div>
  );

  return (
    <div className={PORTAL_MOBILE_CARD_CLASS}>
      {onClick ? (
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className="w-full cursor-pointer text-left"
          onClick={(e: MouseEvent<HTMLDivElement>) => {
            if (isPortalRowClickIgnored(e.target)) return;
            onClick();
          }}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (isPortalRowClickIgnored(e.target)) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onClick();
            }
          }}
        >
          {body}
        </div>
      ) : (
        body
      )}
      {children ? <div className={onClick ? PORTAL_MOBILE_DETAIL_EXPAND : "border-t border-border pt-4"}>{children}</div> : null}
    </div>
  );
}

/** Footer link when a preview list is truncated. */
export function PortalPreviewOverflowLink({
  overflow,
  href,
  label,
}: {
  overflow: number;
  href: string;
  label?: string;
}) {
  if (overflow <= 0) return null;
  return (
    <Link href={href} className="mt-2 inline-block text-xs font-semibold text-primary hover:underline underline-offset-2">
      {label ?? `+${overflow} more →`}
    </Link>
  );
}

/** Desktop table + mobile card stack — use one layout per breakpoint. */
export function PortalResponsiveDataView({
  mobile,
  desktop,
}: {
  mobile: ReactNode;
  desktop: ReactNode;
}) {
  return (
    <>
      <div className="space-y-2 lg:hidden">{mobile}</div>
      <div className="hidden lg:block">{desktop}</div>
    </>
  );
}

/** Detail row cell padding for expanded table sections. */
export const PORTAL_TABLE_DETAIL_CELL = "px-4 py-4 align-top sm:px-6 sm:py-5";

/**
 * Action strip in an expanded detail row — subtle divider + compact buttons.
 * Default `bottom`: border above the strip (content above, actions below).
 * `top`: border below the strip (toolbar first, lease preview / thread below).
 */
export function PortalTableDetailActions({
  children,
  placement = "bottom",
}: {
  children: ReactNode;
  placement?: "top" | "bottom";
}) {
  if (children == null) return null;
  const edge =
    placement === "top"
      ? "border-b border-border pb-4 mb-4 last:mb-0 last:border-b-0 last:pb-0"
      : "border-t border-border pt-4 mt-4 first:mt-0 first:border-t-0 first:pt-0 last:mb-0";
  return (
    <div
      data-portal-detail-actions=""
      data-portal-detail-actions-placement={placement}
      className={`flex flex-wrap items-center gap-2 sm:gap-3 ${edge}`}
    >
      {children}
    </div>
  );
}

/** Compact action button on a summary row (Schedule, Mark paid, etc.). */
export const PORTAL_TABLE_ROW_TOGGLE_CLASS =
  "h-8 min-h-0 !rounded-lg border-border px-3 py-0 text-xs font-medium text-foreground/80 !shadow-none hover:!translate-y-0 [html[data-theme=dark]_&]:portal-outline-control";

/** Secondary actions in {@link PortalTableDetailActions} (use with `Button variant="outline"`). */
export const PORTAL_DETAIL_BTN =
  "h-11 min-h-[44px] !rounded-lg border-border px-3 py-0 text-xs font-medium text-foreground/80 !shadow-none hover:!translate-y-0 [html[data-theme=dark]_&]:portal-outline-control";

/** Pinned footer on resident Documents detail pages — left-aligned, compact (not full-width). */
export const RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN = cn(
  PORTAL_DETAIL_BTN,
  "h-9 min-h-0 w-auto max-w-none flex-none shrink-0 px-4",
);

/**
 * Wrap pinned footer actions on resident profile detail tabs (lease, application, payments, …).
 *
 * `w-full flex-1 basis-0` is load-bearing, not cosmetic. Without it this is a flex item with
 * `flex-basis: auto`, so it shrinks to fit its own content — and the adaptive action rows inside
 * measure `container.clientWidth` to decide how many buttons fit. That made the measurement
 * circular: the row asked "how much room do I have?" and was told "exactly as much as you are
 * already using", so buttons collapsed into the "…" overflow menu on a wide desktop with obvious
 * empty space beside them, and could never expand back out.
 *
 * Spanning the footer means `clientWidth` is the space actually AVAILABLE, so the overflow menu
 * appears only when the buttons genuinely do not fit.
 */
export function ResidentDocumentsDetailFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-1 basis-0 flex-nowrap items-center justify-start gap-2 [&_button]:w-auto [&_button]:shrink-0">
      {children}
    </div>
  );
}

/**
 * @deprecated Use `Button variant="primary"` with {@link PORTAL_DETAIL_BTN} instead.
 * Emerald styling is reserved for status badges, not action buttons.
 */
export const PORTAL_DETAIL_BTN_PRIMARY =
  "h-11 min-h-[44px] !rounded-lg !border-emerald-600 !bg-emerald-600 px-3 py-0 text-xs font-medium !text-white hover:!border-emerald-700 hover:!bg-emerald-700 !shadow-none hover:!translate-y-0";

import type { PortalEmptyIconKind } from "@/components/portal/portal-empty-state";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";

export function PortalDataTableEmpty({
  message,
  icon = "default",
  variant = "card",
}: {
  message: string;
  icon?: PortalEmptyIconKind;
  /** @deprecated Empty states use a single title line. */
  detail?: string;
  variant?: "card" | "plain" | "stacked";
}) {
  return <PortalEmptyState title={message} icon={icon} variant={variant} />;
}
