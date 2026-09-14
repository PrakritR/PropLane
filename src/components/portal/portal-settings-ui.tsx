"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight, Lock } from "lucide-react";
import Link from "next/link";

import { PortalTitleActionsHost, PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";
import { cn } from "@/lib/utils";

export function PortalSettingsSections({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-8 [html[data-native]_&]:space-y-6", className)}>{children}</div>;
}

export function PortalSettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PortalTitleActionsProvider>
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold tracking-[-0.01em] text-foreground">{title}</h2>
            {description ? <p className="mt-0.5 text-[13.5px] leading-relaxed text-muted">{description}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <PortalTitleActionsHost className="flex items-center gap-1 sm:gap-1.5" />
            {action}
          </div>
        </div>
        {children}
      </section>
    </PortalTitleActionsProvider>
  );
}

export function PortalSettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-card", className)}>{children}</div>
  );
}

export function PortalSettingsRow({
  label,
  description,
  meta,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** Optional third line under `description` — smaller and quieter still (e.g. "Last changed 3 days ago"). */
  meta?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border px-4 py-3.5 last:border-0",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p> : null}
        {meta ? <p className="mt-0.5 text-[11px] leading-relaxed text-muted/70">{meta}</p> : null}
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </div>
  );
}

/**
 * Sliding on/off switch for a settings row. Promoted from the module-private
 * `Toggle` in `pro-portal-automation-settings-panel.tsx` — keep `role="switch"`
 * and `aria-checked`, that accessibility contract is the reason this is the
 * right control for a boolean preference (never use it for list/multi-select;
 * see `RowSelectCheckbox` / `CheckboxMultiSelect` for that).
 */
export function PortalSettingsToggle({
  checked,
  onChange,
  label,
  disabled,
  id,
  dataAttr,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
  dataAttr?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-attr={dataAttr}
      onClick={() => onChange(!checked)}
      /* The button is the 44px touch target the portal HIG layer requires
         (`.portal-shell :where(button, …) { min-height: 2.75rem }` in globals.css,
         which applies at every width). The pill is a child, so that min-height
         stretches transparent padding instead of the switch itself — setting a
         21px height on the button loses to the shell rule and renders a blob. */
      className={cn(
        "inline-flex w-11 shrink-0 items-center justify-center bg-transparent",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative block h-[21px] w-[36px] rounded-full transition-colors",
          checked ? "bg-primary" : "bg-border",
        )}
      >
        <span
          className={cn(
            "absolute top-[2.5px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(8,9,11,0.3)] transition-all",
            checked ? "left-[17.5px]" : "left-[2.5px]",
          )}
        />
      </span>
    </button>
  );
}

/**
 * A row that expands in place to reveal detail. Collapsed by default,
 * keyboard operable (a real `<button>` trigger), and the content is genuinely
 * removed from the accessibility tree when collapsed (the `hidden` attribute,
 * never opacity/visibility) so a screen reader never announces hidden detail.
 */
export function PortalSettingsDisclosureRow({
  label,
  description,
  children,
  defaultOpen = false,
  dataAttr,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  dataAttr?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <div className={cn("border-b border-border last:border-0", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        data-attr={dataAttr}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p> : null}
        </div>
        <ChevronRight
          className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open ? "rotate-90" : undefined)}
          aria-hidden
        />
      </button>
      <div id={contentId} hidden={!open} className="space-y-3 px-4 pb-4">
        {children}
      </div>
    </div>
  );
}

const SCOPE_TAG_VARIANT_CLASS: Record<"default" | "muted", string> = {
  default: "bg-primary/10 text-primary",
  muted: "bg-accent/60 text-muted",
};

/**
 * Small inline tag stating what a setting applies to, e.g. "All properties"
 * vs "This property". Purely presentational.
 */
export function PortalSettingsScopeTag({
  children,
  label,
  variant = "default",
  className,
}: {
  children?: ReactNode;
  label?: string;
  variant?: "default" | "muted";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-[-0.01em]",
        SCOPE_TAG_VARIANT_CLASS[variant],
        className,
      )}
    >
      {children ?? label}
    </span>
  );
}

/**
 * A row whose control is unavailable, with the reason always shown. A locked
 * row with no visible reason is the bug this exists to prevent — never render
 * one without `reason`.
 *
 * Critical: an UNKNOWN plan must never drive this component. Plan quotas are
 * read only through `resolveEffectiveManagerSkuTier`, and when it cannot
 * determine the plan, callers must treat the limit as unknown and show no
 * limit (defer to the server), never lock the control. Do not wire a
 * `planUnknown`/`tierUnknown` condition into `PortalSettingsLockedRow`.
 */
export function PortalSettingsLockedRow({
  label,
  reason,
  action,
  className,
}: {
  label: ReactNode;
  reason: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 border-b border-border px-4 py-3.5 last:border-0",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground/70">
          <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
          {label}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{reason}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PortalSettingsField({
  label,
  value,
  mono,
  action,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/70 px-4 py-3 last:border-0">
      <span className="w-[7.5rem] shrink-0 pt-0.5 text-[13px] text-muted sm:w-36">{label}</span>
      <div className="flex min-w-0 flex-1 items-start justify-end gap-3 sm:justify-between">
        <span
          className={cn(
            "min-w-0 text-[13.5px] font-semibold text-foreground sm:text-left",
            mono ? "break-all font-mono text-xs leading-relaxed" : "text-right sm:text-left",
          )}
        >
          {value}
        </span>
        {action}
      </div>
    </div>
  );
}

export function PortalSettingsLinkRow({
  label,
  description,
  value,
  icon,
  href,
  onClick,
  dataAttr,
}: {
  label: string;
  description?: string;
  value?: string;
  /** Leading icon rendered in a muted tile (settings category rows). */
  icon?: ReactNode;
  href?: string;
  onClick?: () => void;
  dataAttr?: string;
}) {
  const inner = (
    <>
      {icon ? (
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent/60 text-muted"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-sm text-muted">
        {value ? <span className="max-w-[10rem] truncate">{value}</span> : null}
        <ChevronRight className="h-4 w-4" aria-hidden />
      </div>
    </>
  );

  const className =
    "flex w-full items-center justify-between gap-4 border-b border-border px-4 py-3.5 text-left transition-colors last:border-0 hover:bg-accent/40";

  if (href) {
    return (
      <Link href={href} className={className} data-attr={dataAttr}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className} data-attr={dataAttr}>
      {inner}
    </button>
  );
}

function profileInitials(name: string, email: string): string {
  const src = name.trim() || email.trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

export function PortalSettingsProfileHeader({
  name,
  email,
  action,
}: {
  name: string;
  email: string;
  action?: ReactNode;
}) {
  const displayName = name.trim() || "Account";
  return (
    <PortalSettingsGroup>
      <div className="flex items-center gap-4 px-4 py-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary/10 text-base font-semibold text-primary">
          {profileInitials(name, email)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-foreground">{displayName}</p>
          {email ? <p className="truncate text-sm text-muted">{email}</p> : null}
        </div>
        {action}
      </div>
    </PortalSettingsGroup>
  );
}

export function PortalSettingsFormBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-4 px-4 py-4", className)}>{children}</div>;
}

export type PortalSettingsNavItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Optional visual grouping for long settings navigations. */
  group?: string;
};

/**
 * Desktop settings navigation — identity block + one item per settings
 * category, styled to match the portal sidebar (`navLinkClass` in
 * portal-sidebar.tsx) so Settings reads as part of the same product.
 */
export function PortalSettingsNav({
  name,
  email,
  items,
  activeId,
  onSelect,
  className,
}: {
  name: string;
  email: string;
  items: PortalSettingsNavItem[];
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const itemGroups = items.reduce<Array<{ label?: string; items: PortalSettingsNavItem[] }>>((groups, item) => {
    const existing = groups.find((group) => group.label === item.group);
    if (existing) {
      existing.items.push(item);
      return groups;
    }
    groups.push({ label: item.group, items: [item] });
    return groups;
  }, []);

  return (
    <aside className={cn("w-60 shrink-0 rounded-2xl border border-border bg-card/60 p-2.5", className)}>
      <div className="flex items-center gap-3 border-b border-border px-1 pb-3.5">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
          {profileInitials(name, email)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{name.trim() || "Account"}</p>
          {email ? <p className="truncate text-xs text-muted">{email}</p> : null}
        </div>
      </div>
      <nav aria-label="Settings sections" className="pt-2.5">
        {itemGroups.map((group, groupIndex) => (
          <div key={group.label ?? "settings"} className={groupIndex > 0 ? "mt-3 border-t border-border pt-3" : undefined}>
            {group.label ? (
              <p className="px-2.5 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-muted/75">{group.label}</p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? "page" : undefined}
                    data-attr={`settings-nav-${item.id}`}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium tracking-[-0.01em] transition-colors duration-150",
                      active
                        ? "bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_18%,transparent)]"
                        : "text-muted hover:bg-[var(--secondary)]/70 hover:text-foreground",
                    )}
                  >
                    {item.icon ? (
                      <span className={cn("shrink-0", active ? "text-primary" : "opacity-80")} aria-hidden>
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
