"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export type PropertyRailItem = {
  id: string;
  label: string;
  href: string;
  dataAttr?: string;
};

/**
 * Desktop section rail for one property. Entering a property is an explicit
 * step (the list row), and leaving it is the one link at the top of this
 * rail; the rail itself scrolls independently of the main column so a long
 * section list never pushes the content down.
 */
const RAIL_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: "Property", ids: ["preview", "house-details", "move-in"] },
  { label: "Leasing", ids: ["tours", "bookings", "application", "lease"] },
  { label: "Operations", ids: ["requests", "promotion"] },
];

export function PortalPropertyRail({
  items,
  activeId,
  backHref,
  title,
  subtitle,
  className,
}: {
  items: PropertyRailItem[];
  activeId?: string;
  backHref: string;
  title: string;
  subtitle?: string;
  className?: string;
}) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const grouped = RAIL_GROUPS.map((group) => ({
    label: group.label,
    items: group.ids.map((id) => byId.get(id)).filter((item): item is PropertyRailItem => Boolean(item)),
  })).filter((group) => group.items.length > 0);
  const known = new Set(RAIL_GROUPS.flatMap((group) => group.ids));
  const leftovers = items.filter((item) => !known.has(item.id));
  if (leftovers.length) grouped.push({ label: "More", items: leftovers });

  return (
    <aside
      className={cn(
        "hidden w-52 shrink-0 flex-col self-start overflow-y-auto overscroll-contain border-border bg-background pb-3 lg:flex lg:max-h-full",
        className,
      )}
      data-slot="portal-property-rail"
      aria-label="Property sections"
    >
      <Link
        href={backHref}
        className="inline-flex min-h-11 items-center gap-1.5 px-3 text-sm font-semibold text-primary transition hover:underline"
        data-attr="property-rail-back"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All properties
      </Link>
      <div className="border-t border-border px-3 py-3">
        <p className="truncate text-[13px] font-semibold text-foreground">{title}</p>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
      <nav className="flex flex-col gap-px px-2">
        {grouped.map((group) => (
          <div key={group.label} className="flex flex-col gap-px">
            <p className="px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/60">{group.label}</p>
            {group.items.map((item) => {
              const active = item.id === activeId;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  data-attr={item.dataAttr}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-10 items-center rounded-lg px-2.5 text-[13.5px] font-medium transition",
                    active ? "bg-accent text-primary" : "text-foreground/85 hover:bg-[var(--secondary)]/70 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
