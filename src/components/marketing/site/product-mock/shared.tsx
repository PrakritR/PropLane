"use client";

/**
 * Shared chrome for the home page's static product panels (captain
 * 2026-09-26 redesign — see `docs/agents/marketing-mocks.md`).
 *
 * `ProductPanelBackdrop` is the soft blue/violet gradient panel from the
 * Codex reference layout; `ProductWindow` is the floating app window inside
 * it. Integrator review (2026-09-26) found the first pass cropped the
 * window's own RIGHT edge mid-word at a fixed pixel width — `ProductWindow`
 * now renders its content at a real desktop width (1280px by default) and
 * scales the whole window down with `transform: scale()` to fit the panel's
 * actual width, so nothing is ever cropped sideways; only the panel's own
 * `overflow: hidden` bottom edge crops a taller window, exactly like a real
 * browser window showing the top of a longer page.
 *
 * `PortalSidebarFixture` renders the REAL portal nav structure — `proPortal`'s
 * own sections, grouped by the REAL `groupNavItems`/`PORTAL_NAV_GROUPS`, each
 * with its REAL icon (`PortalNavIcon`, `admin-portal-nav-icons.tsx`) — as
 * static, non-fetching chrome. The real `PortalSidebar` component cannot be
 * dropped in as-is: it hard-depends on `usePortalSession()`
 * (Supabase `auth.getSession()`) and `usePortalNavCounts()` (a live fetch +
 * 60s poll), so this is a thin, real-data wrapper around it rather than the
 * component itself — see the investigation this pass ran before writing it.
 *
 * Tab switching inside a panel uses the REAL `LocalDestinationNav`
 * (`@/components/ui/destination-nav`, `appearance="command"`) — the exact
 * underlined-text-tab-with-count-chip look the real Tours/Applications/
 * Leases/Payments/Services pages render, never a hand-drawn filled pill.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { PortalNavIcon } from "@/components/portal/admin-portal-nav-icons";
import { groupNavItems } from "@/lib/portals/nav-groups";
import { proPortal } from "@/lib/portals/pro";
import { cn } from "@/lib/utils";

export function ProductPanelBackdrop({
  children,
  className,
  mirror = false,
}: {
  children: ReactNode;
  className?: string;
  /** A left-side panel (a flipped row) mirrors the gradient's highlight so it
   * still reads as "coming from the panel", not a fixed light source that
   * disagrees with which side the window is on. */
  mirror?: boolean;
}) {
  return (
    <div className={cn("pm-backdrop relative overflow-hidden rounded-[28px]", className)}>
      <div aria-hidden className={cn("pm-backdrop-wash", mirror && "pm-backdrop-wash--mirror")} />
      {children}
    </div>
  );
}

function useContainerScale(nativeWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const w = el.clientWidth;
      if (w > 0) setScale(w / nativeWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nativeWidth]);
  return { ref, scale };
}

/**
 * The floating app window — desktop chrome bar + content, rendered at a
 * real desktop width (`nativeWidth`) and scaled with CSS `transform` to fit
 * whatever width the panel actually has, so the whole page width is always
 * visible — only the bottom can crop (via the panel's own overflow).
 */
export function ProductWindow({
  path,
  children,
  nativeWidth = 1280,
  nativeHeight = 820,
}: {
  path: string;
  children: ReactNode;
  /** The real desktop viewport width this window renders at before scaling down. */
  nativeWidth?: number;
  /** The real page height before scaling — taller than the visible panel on purpose; the extra crops at the bottom. */
  nativeHeight?: number;
}) {
  const { ref, scale } = useContainerScale(nativeWidth);
  return (
    <div ref={ref} className="pm-window absolute inset-x-6 top-6 sm:inset-x-10 sm:top-10" style={{ height: nativeHeight * scale }}>
      <div
        className="flex origin-top-left flex-col overflow-hidden rounded-t-2xl border border-black/[0.06] bg-card shadow-[0_50px_100px_-40px_rgba(15,23,42,0.45)]"
        style={{ width: nativeWidth, height: nativeHeight, transform: `scale(${scale})` }}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-[var(--pl-surface-muted)] px-3.5 py-2.5">
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <i className="h-2.5 w-2.5 rounded-full bg-border" aria-hidden />
          <span className="ml-2 truncate rounded-md bg-card px-2.5 py-1 text-[12px] text-muted">proplane.ai{path}</span>
        </div>
        <div className="flex min-h-0 w-full flex-1">{children}</div>
      </div>
    </div>
  );
}

/**
 * Real nav labels, grouping and icons (`proPortal.sections`, `groupNavItems`,
 * `PortalNavIcon`), a fixed static "Seattle Homes" workspace name, and one
 * active item — no session, no fetch, no counts beyond the static ones a
 * panel passes in.
 */
export function PortalSidebarFixture({
  active,
  counts = {},
}: {
  active: string;
  counts?: Record<string, number>;
}) {
  const groups = groupNavItems(
    "pro",
    proPortal.sections.filter((s) => s.section !== "app" && s.section !== "bugs-feedback"),
  );
  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-4 border-r border-border bg-[var(--pl-surface-muted)] px-3 py-4">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-2 text-left">
        <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-bold text-white">
          S
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-foreground">Seattle Homes</span>
        <span aria-hidden className="text-[10px] text-muted">
          ▾
        </span>
      </div>
      <nav className="flex flex-1 flex-col gap-3 overflow-hidden">
        {groups.map((group) => (
          <div key={group.id} className="flex flex-col gap-0.5">
            {group.label ? (
              <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-[0.06em] text-muted">{group.label}</p>
            ) : null}
            {group.items.map((item) => {
              const isActive = item.section === active;
              const count = counts[item.section];
              return (
                <span
                  key={item.section}
                  className={cn(
                    "flex min-h-8 items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-[13px] font-medium tracking-[-0.01em]",
                    isActive ? "bg-primary/[0.1] text-primary" : "text-foreground/80",
                  )}
                >
                  <PortalNavIcon section={item.section} active={isActive} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {count != null ? (
                    <span
                      className={cn(
                        "grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-1 text-[9.5px] font-bold",
                        isActive ? "bg-primary text-white" : "bg-border text-muted",
                      )}
                    >
                      {count}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/** A tiny, non-persisting confirmation toast — closes itself after a beat. */
export function useFixtureToast() {
  const [text, setText] = useState<string | null>(null);
  const show = (message: string) => {
    setText(message);
    window.setTimeout(() => setText(null), 2400);
  };
  const node = text ? (
    <div role="status" className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3">
      <div className="rounded-full bg-foreground px-4 py-2 text-[12px] font-semibold text-background shadow-[0_16px_34px_-10px_rgba(15,23,42,0.4)]">
        {text}
      </div>
    </div>
  ) : null;
  return { show, node };
}

/**
 * The one add/detail surface every panel reuses — opens with default values,
 * "Save"/"Send"/"Approve" only closes it and fires the toast (captain: "does
 * not need to save information").
 */
export function FixtureSheet({
  open,
  title,
  onClose,
  children,
  primaryLabel,
  onPrimary,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  primaryLabel?: string;
  onPrimary?: () => void;
}) {
  if (!open) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-foreground/20 p-4 pt-10" role="dialog" aria-label={title}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-4 shadow-[0_30px_70px_-30px_rgba(15,23,42,0.5)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-[14.5px] font-bold text-foreground">{title}</p>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[13px] font-semibold text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <div className="space-y-2.5 text-[13px] text-foreground/80">{children}</div>
        {primaryLabel ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onPrimary}
              className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-[12.5px] font-bold text-white"
            >
              {primaryLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A default-filled field row inside a `FixtureSheet` — never editable in a
 * way that persists, just a realistic filled form. */
export function FixtureField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.04em] text-muted">{label}</p>
      <div className="rounded-lg border border-border bg-[var(--pl-surface-muted)] px-2.5 py-2 text-[13px] text-foreground">{value}</div>
    </div>
  );
}
