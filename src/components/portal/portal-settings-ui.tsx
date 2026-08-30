"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";

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
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-sm leading-relaxed text-muted">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PortalSettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card shadow-sm", className)}>{children}</div>
  );
}

export function PortalSettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
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
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
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
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3.5 last:border-0">
      <span className="w-[7.5rem] shrink-0 pt-0.5 text-sm text-muted sm:w-32">{label}</span>
      <div className="flex min-w-0 flex-1 items-start justify-end gap-3 sm:justify-between">
        <span
          className={cn(
            "min-w-0 text-sm font-medium text-foreground sm:text-left",
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
