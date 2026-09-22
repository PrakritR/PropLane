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
  tone?: "danger" | "default";
  dataAttr: string;
}) {
  const body = (
    <>
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <span
        className={cn(
          "block truncate text-[1.3rem] font-semibold leading-none tracking-[-0.02em] sm:text-[1.45rem]",
          tone === "danger" ? "text-[var(--status-overdue-fg)]" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="truncate text-[12px] font-medium text-muted">{detail ?? ""}</span>
    </>
  );
  const className =
    "flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  if (href) {
    return (
      <Link href={href} className={cn(className, "hover:border-primary/35")} data-attr={dataAttr}>
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
  action,
  children,
  dataAttr,
}: {
  title: string;
  action?: { label: string; href: string };
  children: ReactNode;
  dataAttr?: string;
}) {
  return (
    <section className="flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm" data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {action ? (
          <Link
            href={action.href}
            className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline"
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
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <span className="w-28 shrink-0 text-[13px] text-muted">{label}</span>
      <span
        className={cn(
          "min-w-0 flex-1 text-right text-[13.5px] font-medium sm:text-left",
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
  detail: string;
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
      <ul className="divide-y divide-border/70">
        {items.map((row) => {
          const inner = (
            <>
              <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-foreground">{row.title}</span>
                <span className="block truncate text-[12px] text-muted">{row.detail}</span>
              </span>
              {row.href || row.onClick ? <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden /> : null}
            </>
          );
          const className = "flex items-center gap-3 px-4 py-2.5";
          return (
            <li key={row.id} data-attr={`${itemDataAttrPrefix}-${row.id}`}>
              {row.href ? (
                <Link href={row.href} className={cn(className, "transition hover:bg-accent/40")}>
                  {inner}
                </Link>
              ) : row.onClick ? (
                <button
                  type="button"
                  className={cn(className, "w-full text-left transition hover:bg-accent/40")}
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
}: {
  title: string;
  action?: { label: string; href: string };
  rows: RecordRowItem[];
  emptyLabel?: string;
  footer?: { label: string; href?: string; onClick?: () => void };
  dataAttr?: string;
}) {
  return (
    <RecordFactCard title={title} action={action} dataAttr={dataAttr}>
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-center text-[13px] text-muted">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => {
            const inner = (
              <>
                {row.glyph ? <span className="shrink-0">{row.glyph}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-foreground">{row.title}</span>
                  {row.sub ? <span className="block truncate text-[12px] text-muted">{row.sub}</span> : null}
                </span>
                {row.figure ? <span className="shrink-0">{row.figure}</span> : null}
              </>
            );
            const className = "flex items-center gap-3 px-4 py-2.5";
            return (
              <li key={row.id}>
                {row.href ? (
                  <Link href={row.href} className={cn(className, "transition hover:bg-accent/40")}>
                    {inner}
                  </Link>
                ) : row.onClick ? (
                  <button type="button" className={cn(className, "w-full text-left transition hover:bg-accent/40")} onClick={row.onClick}>
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
            className="block border-t border-dashed border-border/70 px-4 py-2.5 text-center text-[13px] font-semibold text-primary transition hover:bg-accent/40"
          >
            + {footer.label}
          </Link>
        ) : (
          <button
            type="button"
            className="block w-full border-t border-dashed border-border/70 px-4 py-2.5 text-center text-[13px] font-semibold text-primary transition hover:bg-accent/40"
            onClick={footer.onClick}
          >
            + {footer.label}
          </button>
        )
      ) : null}
    </RecordFactCard>
  );
}
