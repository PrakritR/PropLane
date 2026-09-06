"use client";

import Link from "next/link";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { cn } from "@/lib/utils";

export type DestinationNavItem = {
  id: string;
  label: string;
  /** Narrow-viewport label when the full label would clip in equal-width tabs. */
  shortLabel?: string;
  href: string;
  count?: number;
  /** Highlight when this destination has urgent work (overdue, etc.). */
  alert?: boolean;
  dataAttr?: string;
};

/**
 * Routed view switcher — every item is a real URL with a visible label.
 * Mobile: horizontal scroll-snap row; desktop: segmented row.
 */
export function DestinationNav({
  items,
  activeHref,
  activeId,
  ariaLabel = "Section views",
  className,
  size = "default",
  /** `equal` stretches every tab across the full bar (record-detail rows). */
  itemLayout = "auto",
  /** With `equal`, fit every tab on one row via smaller labels (property detail). */
  denseEqualRow = false,
  /** With `equal`, center the tab row (property detail sub-nav). */
  centerEqualRow = false,
  /** `command` is the low-chrome list-page treatment: text tabs with an active underline. */
  appearance = "segmented",
}: {
  items: DestinationNavItem[];
  /** Match the active item by normalized href. */
  activeHref?: string;
  /** Match the active item by id (for grouped routes under one parent). */
  activeId?: string;
  ariaLabel?: string;
  className?: string;
  /** `toolbar` matches {@link PORTAL_HEADER_ACTION_BTN} in page header rows. */
  size?: "default" | "toolbar";
  itemLayout?: "auto" | "equal";
  denseEqualRow?: boolean;
  centerEqualRow?: boolean;
  appearance?: "segmented" | "command";
}) {
  const normalize = (href: string) => href.replace(/\/$/, "");
  const compactItems = itemLayout === "equal" ? false : items.length > 4;

  return (
    <nav
      className={destinationNavShellClassName(
        className,
        itemLayout,
        denseEqualRow,
        centerEqualRow,
        appearance,
      )}
      aria-label={ariaLabel}
      data-slot="destination-nav"
      {...(itemLayout === "equal" ? {} : { [HORIZONTAL_SCROLL_ATTR]: "" })}
    >
      {items.map((item) => {
        const active =
          (activeId != null && item.id === activeId) ||
          (activeHref != null && normalize(activeHref) === normalize(item.href));
        return (
          <Link
            key={item.id}
            href={item.href}
            data-attr={item.dataAttr}
            className={cn(
              itemLayout === "equal"
                ? "min-w-0"
                : destinationNavItemWidthClass(compactItems, appearance),
              "portal-pressable inline-flex items-center justify-center gap-1.5 font-semibold transition-[color,border-color,background-color] duration-100",
              appearance === "command"
                ? itemLayout === "equal" && denseEqualRow
                  ? "min-h-11 rounded-none border-b-2 px-0 py-2 text-center leading-none lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : "min-h-11 rounded-none border-b-2 px-2.5 py-2 text-sm sm:px-3"
                : itemLayout === "equal"
                ? denseEqualRow
                  ? "min-h-9 min-w-0 px-0 py-1 text-center leading-none lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : "min-h-10 min-w-0 px-0.5 py-1.5 text-center leading-tight lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                : size === "toolbar"
                  ? "h-9 px-2 text-xs sm:px-3 md:h-10 md:text-sm"
                  : "min-h-11 rounded-xl px-2 py-2 text-sm sm:px-3.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              appearance === "command"
                ? active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:border-border hover:text-foreground"
                : active
                  ? "bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-primary/25"
                  : "text-muted hover:bg-card/60 hover:text-foreground",
              item.alert && !active && "text-[var(--status-overdue-fg)]",
            )}
            aria-current={active ? "page" : undefined}
          >
            <span
              className={
                itemLayout === "equal"
                  ? denseEqualRow
                    ? "block w-full min-w-0 max-w-full whitespace-nowrap text-[length:clamp(8px,2.1vw,0.875rem)] leading-none lg:text-sm lg:leading-tight lg:truncate"
                    : "block w-full min-w-0 max-w-full whitespace-nowrap text-xs leading-tight lg:truncate"
                  : undefined
              }
            >
              {item.shortLabel ? (
                <>
                  <span className={itemLayout === "equal" ? "lg:hidden" : "lg:hidden"}>{item.shortLabel}</span>
                  <span className={itemLayout === "equal" ? "hidden lg:inline" : "hidden lg:inline"}>{item.label}</span>
                </>
              ) : (
                item.label
              )}
            </span>
            {appearance === "command" && item.count != null ? (
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                  active ? "bg-primary/10 text-primary" : "bg-accent text-muted",
                )}
                aria-label={`${item.count} ${item.count === 1 ? "item" : "items"}`}
              >
                {item.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

export type LocalDestinationNavItem = {
  id: string;
  label: string;
  shortLabel?: string;
  count?: number;
  alert?: boolean;
  dataAttr?: string;
};

function destinationNavShellClassName(
  className?: string,
  itemLayout: "auto" | "equal" = "auto",
  denseEqualRow = false,
  centerEqualRow = false,
  appearance: "segmented" | "command" = "segmented",
) {
  return cn(
    appearance === "command"
      ? itemLayout === "equal"
        ? denseEqualRow
          ? "grid w-full min-w-0 auto-cols-fr grid-flow-col gap-0 border-0 bg-transparent p-0"
          : centerEqualRow
            ? "mx-auto grid w-full min-w-0 max-w-2xl auto-cols-fr grid-flow-col gap-0 border-0 bg-transparent p-0 max-lg:max-w-none"
            : "grid w-full min-w-0 auto-cols-fr grid-flow-col gap-0 border-0 bg-transparent p-0"
        : cn(
            "flex w-full gap-1 border-0 bg-transparent p-0",
            PORTAL_HORIZONTAL_SCROLL_ROW_CLASS,
            "snap-x snap-mandatory scroll-px-2",
          )
      : itemLayout === "equal"
      ? denseEqualRow
        ? "grid w-full min-w-0 auto-cols-fr grid-flow-col gap-0.5 rounded-2xl border border-border bg-accent/30 p-1 max-lg:gap-0.5 max-lg:p-0 max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent"
        : centerEqualRow
          ? "mx-auto grid w-full min-w-0 max-w-2xl auto-cols-fr grid-flow-col gap-0.5 rounded-2xl border border-border bg-accent/30 p-1 max-lg:max-w-none max-lg:gap-0.5 max-lg:p-0 max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent"
          : "grid w-full min-w-0 gap-0.5 rounded-2xl border border-border bg-accent/30 p-1 max-lg:grid-cols-3 max-lg:grid-flow-row max-lg:gap-1.5 max-lg:p-0 max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent lg:[grid-template-columns:none] lg:auto-cols-fr lg:grid-flow-col"
      : cn(
          "flex w-full gap-1 rounded-2xl border border-border bg-accent/30 p-1",
          PORTAL_HORIZONTAL_SCROLL_ROW_CLASS,
          "max-lg:snap-x max-lg:snap-mandatory max-lg:scroll-px-2.5 sm:max-lg:scroll-px-4 md:snap-none md:scroll-px-1",
        ),
    className,
  );
}

/** Few tabs share width on desktop; on phones always scroll so long labels never clip. */
function destinationNavItemWidthClass(
  compactItems: boolean,
  appearance: "segmented" | "command" = "segmented",
) {
  if (appearance === "command") return "shrink-0 snap-start whitespace-nowrap";
  if (compactItems) return "shrink-0 whitespace-nowrap";
  return "min-w-0 flex-1 basis-0 max-lg:shrink-0 max-lg:flex-none max-lg:basis-auto max-lg:whitespace-nowrap";
}

function destinationNavItemClassName({
  active,
  alert,
  size = "default",
  tone = "default",
}: {
  active: boolean;
  alert?: boolean;
  size?: "default" | "toolbar";
  tone?: "default" | "monochrome";
}) {
  return cn(
    "portal-pressable inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors",
    size === "toolbar" ? "h-9 px-2 text-xs sm:px-3 md:h-10 md:text-sm" : "min-h-11 px-2 py-2 text-sm sm:px-3.5",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    tone === "monochrome"
      ? active
        ? "text-foreground underline decoration-border underline-offset-4"
        : "text-muted hover:text-foreground"
      : active
        ? "bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-primary/25"
        : "text-muted hover:bg-card/60 hover:text-foreground",
    tone === "default" && alert && !active && "text-[var(--status-overdue-fg)]",
  );
}

/** Local-state destination tabs — same chrome as {@link DestinationNav} without routed hrefs. */
export function LocalDestinationNav({
  items,
  activeId,
  onChange,
  ariaLabel = "Section views",
  className,
  size = "default",
  tone = "default",
  /** `equal` stretches every tab across the full bar (record-detail rows). */
  itemLayout = "auto",
  denseEqualRow = false,
  centerEqualRow = false,
  /** `command` is the low-chrome list-page treatment: text tabs with an active underline. */
  appearance = "segmented",
}: {
  items: LocalDestinationNavItem[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  size?: "default" | "toolbar";
  tone?: "default" | "monochrome";
  itemLayout?: "auto" | "equal";
  denseEqualRow?: boolean;
  centerEqualRow?: boolean;
  appearance?: "segmented" | "command";
}) {
  const compactItems = itemLayout === "equal" ? false : items.length > 4;

  return (
    <nav
      className={destinationNavShellClassName(
        className,
        itemLayout,
        denseEqualRow,
        centerEqualRow,
        appearance,
      )}
      aria-label={ariaLabel}
      data-slot="local-destination-nav"
      {...(itemLayout === "equal" ? {} : { [HORIZONTAL_SCROLL_ATTR]: "" })}
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            data-attr={item.dataAttr}
            className={cn(
              itemLayout === "equal"
                ? "min-w-0"
                : destinationNavItemWidthClass(compactItems, appearance),
              appearance === "command"
                ? itemLayout === "equal" && denseEqualRow
                  ? "portal-pressable inline-flex min-h-11 items-center justify-center gap-1.5 rounded-none border-b-2 px-0 py-2 text-center leading-none font-semibold transition-[color,border-color,background-color] duration-100 lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : cn(
                      "portal-pressable inline-flex min-h-11 items-center justify-center gap-1.5 rounded-none border-b-2 px-2.5 py-2 text-sm font-semibold transition-[color,border-color,background-color] duration-100 sm:px-3",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary text-primary"
                        : "border-transparent text-muted hover:border-border hover:text-foreground",
                      item.alert && !active && "text-[var(--status-overdue-fg)]",
                    )
                : itemLayout === "equal"
                  ? denseEqualRow
                    ? "portal-pressable inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 px-0 py-1 text-center leading-none font-semibold transition-colors lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                    : "portal-pressable inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 px-0.5 py-1.5 text-center leading-tight font-semibold transition-colors lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : destinationNavItemClassName({ active, alert: item.alert, size, tone }),
              appearance !== "command" &&
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              appearance === "command" && itemLayout === "equal"
                ? active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:border-border hover:text-foreground"
                : null,
              appearance !== "command" && itemLayout === "equal"
                ? active
                  ? "bg-card text-foreground shadow-[var(--shadow-sm)] ring-1 ring-primary/25"
                  : "text-muted hover:bg-card/60 hover:text-foreground"
                : null,
              item.alert && !active && appearance !== "command" && "text-[var(--status-overdue-fg)]",
            )}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item.id)}
          >
            <span
              className={
                itemLayout === "equal"
                  ? denseEqualRow
                    ? "block w-full min-w-0 max-w-full whitespace-nowrap text-[length:clamp(8px,2.1vw,0.875rem)] leading-none lg:text-sm lg:leading-tight lg:truncate"
                    : "block w-full min-w-0 max-w-full whitespace-nowrap text-xs leading-tight lg:truncate"
                  : undefined
              }
            >
              {item.shortLabel ? (
                <>
                  <span className={itemLayout === "equal" ? "lg:hidden" : "lg:hidden"}>{item.shortLabel}</span>
                  <span className={itemLayout === "equal" ? "hidden lg:inline" : "hidden lg:inline"}>{item.label}</span>
                </>
              ) : (
                item.label
              )}
            </span>
            {appearance === "command" && item.count != null ? (
              <span
                className={cn(
                  "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                  active ? "bg-primary/10 text-primary" : "bg-accent text-muted",
                )}
                aria-label={`${item.count} ${item.count === 1 ? "item" : "items"}`}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
