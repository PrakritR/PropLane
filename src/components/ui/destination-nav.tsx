"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { PhoneSheetGlyph } from "@/components/ui/phone-bottom-sheet";
import { PhoneStripOrPicker, PhoneStripPicker, usePhoneStripAsPicker } from "@/components/ui/phone-strip-picker";
import { HORIZONTAL_SCROLL_ATTR, PORTAL_HORIZONTAL_SCROLL_ROW_CLASS } from "@/lib/horizontal-scroll";
import { cn } from "@/lib/utils";

/**
 * M005 — the "command" appearance's tab row already draws a static
 * `border-b-2` underline per item (colored on whichever is active); this adds
 * ONE indicator element that FLIPs between the previously and newly active
 * item's measured rect (the same ref/`useLayoutEffect`/`ResizeObserver`
 * technique `TabNav` in `tabs.tsx` already uses for its sliding pill), so the
 * underline travels instead of jumping. Scoped to `appearance === "command"`
 * only — the "segmented" pill appearance has its own, unrelated highlight.
 */
function useCommandTabIndicator(activeKey: string, itemCount: number, enabled: boolean) {
  const wrapRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [rect, setRect] = useState<{ left: number; width: number } | null>(null);

  const sync = useCallback(() => {
    if (!enabled) return;
    const wrap = wrapRef.current;
    const el = itemRefs.current.get(activeKey);
    if (!wrap || !el) {
      setRect(null);
      return;
    }
    setRect({ left: el.offsetLeft, width: el.offsetWidth });
  }, [activeKey, enabled]);

  useLayoutEffect(() => {
    sync();
  }, [sync, itemCount]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => sync());
    ro.observe(wrap);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [sync, enabled]);

  const registerItem = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) itemRefs.current.set(id, el);
      else itemRefs.current.delete(id);
    },
    [],
  );

  return { wrapRef, registerItem, rect };
}

/** Keep overflow visible without fading the final tab after the user reaches it. */
export function useTabOverflowFade(ref: { current: HTMLElement | null }, itemCount: number) {
  const [mask, setMask] = useState<string>();
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    const sync = () => {
      const left = row.scrollLeft > 2;
      const right = row.scrollWidth - row.clientWidth - row.scrollLeft > 2;
      setMask(left && right
        ? "linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)"
        : right ? "linear-gradient(to right, black calc(100% - 28px), transparent)"
        : left ? "linear-gradient(to left, black calc(100% - 28px), transparent)" : undefined);
    };
    sync();
    row.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(row);
    for (const child of row.children) observer?.observe(child);
    return () => { row.removeEventListener("scroll", sync); observer?.disconnect(); };
  }, [ref, itemCount]);
  return { maskImage: mask, WebkitMaskImage: mask };
}

/**
 * M014 — value flash on the count pill: marks the pill for one animation
 * cycle the instant its number changes between renders (the same "marks what
 * just changed" cue a live KPI wants), never on first mount.
 */
function useCountFlash(items: { id: string; count?: number }[]) {
  const prevCounts = useRef<Map<string, number>>(new Map());
  const mountedOnce = useRef(false);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  // A stable string key, not `items` itself (most callers inline a fresh
  // array literal every render) — so the effect only fires on an actual
  // count change, never on every unrelated re-render.
  const countsKey = useMemo(
    () => items.map((item) => `${item.id}:${item.count ?? ""}`).join("|"),
    [items],
  );

  useEffect(() => {
    const next = new Set<string>();
    for (const item of items) {
      if (item.count == null) continue;
      const prev = prevCounts.current.get(item.id);
      if (mountedOnce.current && prev !== undefined && prev !== item.count) next.add(item.id);
      prevCounts.current.set(item.id, item.count);
    }
    mountedOnce.current = true;
    if (next.size === 0) return;
    setFlashing(next);
    const timer = setTimeout(() => setFlashing(new Set()), 900);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countsKey]);

  return flashing;
}

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
function DestinationNavStrip({
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
  const commandEnabled = appearance === "command";
  const activeItemId =
    items.find(
      (item) =>
        (activeId != null && item.id === activeId) ||
        (activeHref != null && normalize(activeHref) === normalize(item.href)),
    )?.id ?? "";
  const { wrapRef, registerItem, rect } = useCommandTabIndicator(activeItemId, items.length, commandEnabled);
  const flashing = useCountFlash(items);
  const overflowStyle = useTabOverflowFade(wrapRef, items.length);

  return (
    <nav
      ref={wrapRef as never}
      style={overflowStyle}
      className={cn(
        destinationNavShellClassName(className, itemLayout, denseEqualRow, centerEqualRow, appearance),
        commandEnabled && "relative",
      )}
      aria-label={ariaLabel}
      data-slot="destination-nav"
      {...(itemLayout === "equal" ? {} : { [HORIZONTAL_SCROLL_ATTR]: "" })}
    >
      {commandEnabled && rect ? (
        <span aria-hidden className="motion-tab-indicator" style={{ left: rect.left, width: rect.width }} />
      ) : null}
      {items.map((item) => {
        const active =
          (activeId != null && item.id === activeId) ||
          (activeHref != null && normalize(activeHref) === normalize(item.href));
        return (
          <Link
            key={item.id}
            href={item.href}
            data-attr={item.dataAttr}
            ref={commandEnabled ? (registerItem(item.id) as never) : undefined}
            className={cn(
              itemLayout === "equal"
                ? "min-w-0"
                : destinationNavItemWidthClass(compactItems, appearance),
              "portal-pressable inline-flex items-center justify-center gap-1.5 transition-[color,border-color,background-color] duration-100",
              appearance === "command" ? "font-medium" : "font-semibold",
              appearance === "command"
                ? itemLayout === "equal" && denseEqualRow
                  ? "min-h-11 rounded-none border-b-2 px-0 py-2 text-center leading-none lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : "min-h-11 rounded-none border-b-2 px-2.5 py-2 text-[15px] sm:px-3 lg:min-h-0 lg:px-0 lg:pb-[9px] lg:pt-[7px] lg:text-[14px] lg:font-[550]"
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
                  ? "border-primary text-foreground"
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
                    ? "block w-full min-w-0 max-w-full truncate whitespace-nowrap text-[length:clamp(11px,2.4vw,0.875rem)] leading-none lg:text-sm lg:leading-tight"
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
                  "inline-flex items-center justify-center rounded-md px-1 text-[11px] font-medium tabular-nums lg:px-0 lg:text-[12px]",
                  active ? "text-primary" : "text-muted/80",
                  // M014 — flashes once, right when the count you're already
                  // looking at changes underneath you.
                  flashing.has(item.id) && "motion-value-flash",
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
            "flex w-full min-w-0 max-w-full gap-1 border-0 bg-transparent p-0 lg:gap-[18px]",
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
function LocalDestinationNavStrip({
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
  tight = false,
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
  /**
   * `command` only: trims each tab's side padding and the gap between tabs so
   * six tabs (property House details) fit one row beside the search and the
   * round +. The active tab is also scrolled into view if the row still overflows.
   */
  tight?: boolean;
}) {
  const compactItems = itemLayout === "equal" ? false : items.length > 4;
  const commandEnabled = appearance === "command";
  const { wrapRef, registerItem, rect } = useCommandTabIndicator(activeId, items.length, commandEnabled);
  const flashing = useCountFlash(items);
  const overflowStyle = useTabOverflowFade(wrapRef, items.length);

  // A row that still overflows must never hide the active tab (House details has six).
  useLayoutEffect(() => {
    if (!commandEnabled) return;
    const row = wrapRef.current;
    if (!row || row.scrollWidth <= row.clientWidth + 2) return;
    const active = row.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left - 8);
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
  }, [activeId, commandEnabled, items.length, wrapRef]);

  return (
    <nav
      ref={wrapRef as never}
      style={overflowStyle}
      className={cn(
        destinationNavShellClassName(className, itemLayout, denseEqualRow, centerEqualRow, appearance),
        commandEnabled && "relative",
        commandEnabled && tight && "gap-0",
      )}
      aria-label={ariaLabel}
      data-slot="local-destination-nav"
      {...(itemLayout === "equal" ? {} : { [HORIZONTAL_SCROLL_ATTR]: "" })}
    >
      {commandEnabled && rect ? (
        <span aria-hidden className="motion-tab-indicator" style={{ left: rect.left, width: rect.width }} />
      ) : null}
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            data-attr={item.dataAttr}
            ref={commandEnabled ? (registerItem(item.id) as never) : undefined}
            className={cn(
              itemLayout === "equal"
                ? "min-w-0"
                : destinationNavItemWidthClass(compactItems, appearance),
              appearance === "command"
                ? itemLayout === "equal" && denseEqualRow
                  ? "portal-pressable inline-flex min-h-11 items-center justify-center gap-1.5 rounded-none border-b-2 px-0 py-2 text-center leading-none font-semibold transition-[color,border-color,background-color] duration-100 lg:min-h-11 lg:px-2 lg:py-2 lg:text-sm"
                  : cn(
                      "portal-pressable inline-flex min-h-11 items-center justify-center gap-1.5 rounded-none border-b-2 py-2 text-[15px] font-medium transition-[color,border-color,background-color] duration-100 lg:min-h-0 lg:px-0 lg:pb-[9px] lg:pt-[7px] lg:text-[14px] lg:font-[550]",
                      tight ? "px-1.5 sm:px-2" : "px-2.5 sm:px-3",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary text-foreground"
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
                  ? "border-primary text-foreground"
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
                    ? "block w-full min-w-0 max-w-full truncate whitespace-nowrap text-[length:clamp(11px,2.4vw,0.875rem)] leading-none lg:text-sm lg:leading-tight"
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
                  "inline-flex items-center justify-center rounded-md px-1 text-[11px] font-medium tabular-nums lg:px-0 lg:text-[12px]",
                  active ? "text-primary" : "text-muted/80",
                  flashing.has(item.id) && "motion-value-flash",
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

/**
 * The tab label as it reads on a phone (`shortLabel` is what a phone shows). The live count is
 * deliberately NOT part of it: these tabs are `countable`, so the pill's room is reserved whether
 * or not the count has loaded and the tabs-or-picker answer cannot change when it does.
 */
function phoneTab(item: { label: string; shortLabel?: string }) {
  return { label: item.shortLabel ?? item.label, countable: true };
}

function pickerLabel(item: { label: string; count?: number }) {
  return item.count != null ? (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="truncate">{item.label}</span>
      <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-muted">{item.count}</span>
    </span>
  ) : (
    item.label
  );
}

/**
 * Routed view switcher. Inside a record page or pop-up a command strip that cannot fit a phone
 * screen is the record's dropdown section picker there (`phone-strip-picker.tsx`).
 */
export function DestinationNav(props: ComponentProps<typeof DestinationNavStrip>) {
  const { items, activeId, activeHref, appearance = "segmented", itemLayout = "auto", ariaLabel = "Section views" } = props;
  const asPicker = usePhoneStripAsPicker(
    appearance === "command" && itemLayout === "auto",
    items.map((item) => phoneTab(item)),
  );
  const strip = <DestinationNavStrip {...props} />;
  if (!asPicker) return strip;
  const normalize = (href: string) => href.replace(/\/$/, "");
  const active =
    items.find(
      (item) =>
        (activeId != null && item.id === activeId) ||
        (activeHref != null && normalize(activeHref) === normalize(item.href)),
    ) ?? items[0];
  return (
    <PhoneStripOrPicker
      strip={strip}
      picker={
        <PhoneStripPicker
          title={ariaLabel}
          currentLabel={active ? pickerLabel(active) : ariaLabel}
          items={items.map((item) => ({
            id: item.id,
            current: item.id === active?.id,
            href: item.href,
            dataAttr: item.dataAttr ? `${item.dataAttr}-picker` : undefined,
            glyph: <PhoneSheetGlyph kind={item.id === active?.id ? "current" : "todo"} />,
            label: item.label,
            trailing: item.count != null ? <span className="text-xs font-semibold tabular-nums text-muted">{item.count}</span> : undefined,
          }))}
        />
      }
    />
  );
}

/** Local-state destination tabs: the same chrome and the same phone picker as {@link DestinationNav}. */
export function LocalDestinationNav(props: ComponentProps<typeof LocalDestinationNavStrip>) {
  const { items, activeId, onChange, appearance = "segmented", itemLayout = "auto", ariaLabel = "Section views" } = props;
  const asPicker = usePhoneStripAsPicker(
    appearance === "command" && itemLayout === "auto",
    items.map((item) => phoneTab(item)),
  );
  const strip = <LocalDestinationNavStrip {...props} />;
  if (!asPicker) return strip;
  const active = items.find((item) => item.id === activeId) ?? items[0];
  return (
    <PhoneStripOrPicker
      strip={strip}
      picker={
        <PhoneStripPicker
          variant="inline"
          title={ariaLabel}
          currentLabel={active ? pickerLabel(active) : ariaLabel}
          items={items.map((item) => ({
            id: item.id,
            current: item.id === active?.id,
            onSelect: () => onChange(item.id),
            dataAttr: item.dataAttr ? `${item.dataAttr}-picker` : undefined,
            glyph: <PhoneSheetGlyph kind={item.id === active?.id ? "current" : "todo"} />,
            label: item.label,
            trailing: item.count != null ? <span className="text-xs font-semibold tabular-nums text-muted">{item.count}</span> : undefined,
          }))}
        />
      }
    />
  );
}
