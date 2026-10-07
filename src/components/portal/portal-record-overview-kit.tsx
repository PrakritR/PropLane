"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The Residents record page is the standard (PLAN-0921-1029, area 1). Every
 * other record's Overview is built from these same pieces — `StatTile`
 * (lifted out of `pro-resident-overview-panel.tsx`, unchanged), plus
 * `RecordNeedsYou`, `RecordFactCard`, and `RecordRowsCard`, new but modelled
 * on what that panel already renders. No kind hand-rolls its own card shell.
 * See `docs/agents/record-page.md`.
 */

export function RecordStatTiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export type RecordStatTone = "danger" | "default" | "warning";

export function StatTile({
  label,
  value,
  detail,
  href,
  tone,
  dataAttr,
}: {
  label: string;
  value: string;
  detail?: string;
  href?: string;
  tone?: RecordStatTone;
  dataAttr: string;
}) {
  const body = (
    <>
      <span className="text-[13px] text-muted">{label}</span>
      <span
        className={cn(
          "block truncate text-xl font-[650] leading-none tracking-[-0.02em] tabular-nums",
          tone === "danger"
            ? "text-[var(--status-overdue-fg)]"
            : tone === "warning"
              ? "text-[var(--status-warning-fg)]"
              : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="truncate text-[12.5px] text-muted">{detail ?? ""}</span>
    </>
  );
  const className =
    "flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-border bg-card px-[var(--portal-card-padding,14px)] py-3.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  if (href) {
    return (
      <Link href={href} className={cn(className, "hover:border-[var(--input)]")} data-attr={dataAttr}>
        {body}
      </Link>
    );
  }
  return (
    <div className={className} data-attr={dataAttr}>
      {body}
    </div>
  );
}

/**
 * Card shell shared by every Overview card: title, an optional right-aligned
 * "<label> →" link into the full section, and arbitrary content underneath.
 * `RecordFactRow` is the usual content (label/value); a card that lists
 * records instead uses `RecordRowsCard`.
 */
export function RecordFactCard({
  title,
  count,
  action,
  headerActions,
  children,
  dataAttr,
}: {
  title: string;
  /** A count drawn after the title (Photos 3). */
  count?: number;
  action?: { label: string; href: string };
  /** Icon actions at the card header's right edge (`PortalIconAction`s), never labelled buttons. */
  headerActions?: ReactNode;
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border px-[var(--portal-card-padding,14px)] py-[11px]">
        <h2 className="text-[14px] font-[650] tracking-[-0.01em] text-foreground">
          {title}
          {count != null ? <span className="ml-1.5 text-[12.5px] font-medium text-muted/75">{count}</span> : null}
        </h2>
        {headerActions ? (
          <div className="ml-auto flex items-center gap-1.5" data-attr="record-card-header-actions">
            {headerActions}
          </div>
        ) : null}
        {action ? (
          <Link
            href={action.href}
            className="ml-auto inline-flex items-center gap-1 text-[13px] font-[550] text-primary hover:underline"
          >
            {action.label}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A label/value row inside a `RecordFactCard`. Status is a value, never a pill. */
export function RecordFactRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "ok" | "bad";
}) {
  return (
    <div className={cn("grid min-h-8 grid-cols-[104px_minmax(0,1fr)] items-start gap-2 px-[var(--portal-card-padding,14px)] py-[7px]", ((typeof value === "string" && value.length > 18) || label.length > 15) && "max-sm:grid-cols-1 max-sm:gap-0.5")}>
      <span className="text-[13.5px] text-muted">{label}</span>
      <span
        className={cn(
          "min-w-0 text-left text-[13.5px]",
          tone === "ok"
            ? "text-[var(--status-confirmed-fg)]"
            : tone === "bad"
              ? "text-[var(--status-overdue-fg)]"
              : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export type RecordNeedsYouItem = {
  id: string;
  title: string;
  /** A muted second line. Omit it: a row says what to do, not why (no-subtext rule). */
  detail?: string;
  href?: string;
  onClick?: () => void;
};

/**
 * The record's open items — a dot, a bold line, a sub-line, an arrow into the
 * thing to do. Renders nothing when there is nothing waiting (Decide 2):
 * unlike every other Overview card there is no empty-state message, because
 * an empty "Needs you" is not itself something to tell a manager about.
 */
export function RecordNeedsYou({
  items,
  dataAttr = "record-overview-needs-you",
  itemDataAttrPrefix = "record-overview-needs",
}: {
  items: RecordNeedsYouItem[];
  dataAttr?: string;
  /** Prefix for each row's `data-attr` (`<prefix>-<item.id>`). */
  itemDataAttrPrefix?: string;
}) {
  if (items.length === 0) return null;
  return (
    <RecordFactCard title="Needs you" dataAttr={dataAttr}>
      <ul className="divide-y divide-border">
        {items.map((row) => {
          const inner = (
            <>
              <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-foreground">{row.title}</span>
                {row.detail ? <span className="block truncate text-[12.5px] text-muted">{row.detail}</span> : null}
              </span>
              {row.href || row.onClick ? <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden /> : null}
            </>
          );
          const className = "flex items-center gap-2.5 px-[var(--portal-card-padding,14px)] py-[7px]";
          return (
            <li key={row.id} data-attr={`${itemDataAttrPrefix}-${row.id}`}>
              {row.href ? (
                <Link href={row.href} className={cn(className, "transition hover:bg-[rgba(17,24,39,0.035)]")}>
                  {inner}
                </Link>
              ) : row.onClick ? (
                <button
                  type="button"
                  className={cn(className, "w-full text-left transition hover:bg-[rgba(17,24,39,0.035)]")}
                  onClick={row.onClick}
                >
                  {inner}
                </button>
              ) : (
                <div className={className}>{inner}</div>
              )}
            </li>
          );
        })}
      </ul>
    </RecordFactCard>
  );
}

export type RecordRowItem = {
  id: string;
  /** A state glyph leading the row — a checkmark, an initial, a room number. Omit for a plain list. */
  glyph?: ReactNode;
  title: string;
  sub?: string;
  /** Right-hand figure — an amount, a pill, a count. Plain text or a styled node. */
  figure?: ReactNode;
  href?: string;
  onClick?: () => void;
};

/**
 * A card whose body is a list of records — title, sub-line, an optional
 * leading state glyph, an optional right-hand figure — with an optional
 * dashed "+ <label>" footer row (`footer`). Used for a record's Payments,
 * linked-record, and similar lists on Overview.
 */
export function RecordRowsCard({
  title,
  action,
  rows,
  emptyLabel = "Nothing here yet.",
  footer,
  dataAttr,
  timeline = false,
}: {
  title: string;
  action?: { label: string; href: string };
  rows: RecordRowItem[];
  emptyLabel?: string;
  footer?: { label: string; href?: string; onClick?: () => void };
  dataAttr?: string;
  /** Draw the rows as the dotted activity timeline (title, then the sub-line as a grey date). */
  timeline?: boolean;
}) {
  return (
    <RecordFactCard title={title} action={action} dataAttr={dataAttr}>
      {rows.length === 0 ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted">{emptyLabel}</p>
      ) : timeline ? (
        <RecordTimeline events={rows.map((row) => ({ id: row.id, label: row.title, timestamp: row.sub }))} dataAttr="record-timeline" />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const inner = (
              <>
                {row.glyph ? <span className="shrink-0">{row.glyph}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-foreground">{row.title}</span>
                  {row.sub ? <span className="block truncate text-[12.5px] text-muted">{row.sub}</span> : null}
                </span>
                {row.figure ? <span className="shrink-0">{row.figure}</span> : null}
              </>
            );
            const className = "flex items-center gap-2.5 px-[var(--portal-card-padding,14px)] py-[7px]";
            return (
              <li key={row.id}>
                {row.href ? (
                  <Link href={row.href} className={cn(className, "transition hover:bg-[rgba(17,24,39,0.035)]")}>
                    {inner}
                  </Link>
                ) : row.onClick ? (
                  <button type="button" className={cn(className, "w-full text-left transition hover:bg-[rgba(17,24,39,0.035)]")} onClick={row.onClick}>
                    {inner}
                  </button>
                ) : (
                  <div className={className}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {footer ? (
        footer.href ? (
          <Link
            href={footer.href}
            className="block border-t border-border px-[var(--portal-card-padding,14px)] py-2.5 text-center text-[13px] font-semibold text-primary transition hover:bg-[rgba(17,24,39,0.035)]"
          >
            + {footer.label}
          </Link>
        ) : (
          <button
            type="button"
            className="block w-full border-t border-border px-[var(--portal-card-padding,14px)] py-2.5 text-center text-[13px] font-semibold text-primary transition hover:bg-[rgba(17,24,39,0.035)]"
            onClick={footer.onClick}
          >
            + {footer.label}
          </button>
        )
      ) : null}
    </RecordFactCard>
  );
}

/**
 * Activity as the dotted timeline: a hairline rail, one hollow dot per event,
 * the event's words and its date as a small grey tail. Used wherever a record
 * lists what happened (Overview's Recent activity, the Activity section).
 */
export function RecordTimeline({
  events,
  dataAttr = "record-activity-list",
}: {
  events: Array<{ id: string; label: string; timestamp?: string }>;
  dataAttr?: string;
}) {
  return (
    <div className="px-[var(--portal-card-padding,14px)] py-2.5">
      <ol
        className="relative pl-[18px] before:absolute before:bottom-1.5 before:left-[5px] before:top-1.5 before:w-px before:bg-[var(--input)]"
        data-attr={dataAttr}
      >
        {events.map((event) => (
          <li
            key={event.id}
            className="relative py-1 text-[13px] text-foreground/85 before:absolute before:-left-[16px] before:top-[10px] before:size-[7px] before:rounded-full before:border-[1.5px] before:border-muted/60 before:bg-card"
          >
            {event.label}
            {event.timestamp ? <small className="ml-1.5 text-[12px] text-muted/75">{event.timestamp}</small> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
