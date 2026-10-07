"use client";

import { Building2, FileText, FolderOpen, LayoutDashboard, MessageSquare, MoreHorizontal, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { PORTAL_MAIN_CONTENT_CLASS, PORTAL_MAIN_CONTENT_ID, PORTAL_MAIN_CONTENT_INNER_CLASS, PORTAL_SHELL_ROOT_CLASS } from "@/lib/portal-layout-classes";
import { ownerNavItems, ownerPrimaryNavItems, type OwnerSectionId } from "@/lib/property-owner/sections";
import { cn } from "@/lib/utils";

const ICONS: Record<OwnerSectionId, typeof Building2> = {
  overview: LayoutDashboard,
  properties: Building2,
  statements: FileText,
  documents: FolderOpen,
  messages: MessageSquare,
  profile: User,
};

function isActive(pathname: string, href: string, id: OwnerSectionId): boolean {
  if (id === "overview") return pathname === href || pathname === `${href}/`;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The whole shell for an owner-only account. It is not the manager shell with
 * items hidden: it is a separate, small one that has no workspace switcher, no
 * plan banner, no assistant and no manager nav to leak. Desktop gets a rail,
 * a phone gets a top bar, a bottom bar (Overview, Properties, Statements,
 * Documents, and Messages while it is on) and a More sheet holding Profile and
 * Sign out.
 */
export function OwnerPortalShell({ messagesOn, children }: { messagesOn: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const items = ownerNavItems(messagesOn);
  const primary = ownerPrimaryNavItems(messagesOn);

  return (
    <div className={PORTAL_SHELL_ROOT_CLASS} data-attr="owner-shell">
      <div className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:flex-row">
        <nav aria-label="Owner" className="hidden w-60 shrink-0 flex-col gap-1 border-r border-border bg-card px-3 py-4 lg:flex" data-attr="owner-sidebar">
          <div className="mb-4 flex items-center gap-2 px-2">
            <AxisLogoMark size="compact" />
            <span className="text-sm font-semibold text-foreground">Owner</span>
          </div>
          {items.map((item) => {
            const Icon = ICONS[item.id];
            const active = isActive(pathname, item.href, item.id);
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                data-attr={`owner-nav-${item.id}`}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-accent text-foreground" : "text-muted hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <main id={PORTAL_MAIN_CONTENT_ID} tabIndex={-1} className={cn(PORTAL_MAIN_CONTENT_CLASS, "pb-20 lg:pb-0")}>
            <div className={PORTAL_MAIN_CONTENT_INNER_CLASS}>{children}</div>
          </main>
          <nav
            aria-label="Owner"
            className="fixed inset-x-0 bottom-0 z-50 flex border-t border-border bg-background/95 pb-[max(0.375rem,env(safe-area-inset-bottom,0px))] backdrop-blur lg:hidden"
            data-attr="owner-bottom-nav"
          >
            {primary.map((item) => {
              const Icon = ICONS[item.id];
              const active = isActive(pathname, item.href, item.id);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  data-attr={`owner-bottom-${item.id}`}
                  className={cn("flex min-h-[3.5rem] min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[10px] font-medium", active ? "text-primary" : "text-muted")}
                >
                  <Icon className="size-[1.375rem]" aria-hidden />
                  <span className="max-w-full truncate">{item.label}</span>
                </Link>
              );
            })}
            <button
              type="button"
              aria-expanded={moreOpen}
              data-attr="owner-bottom-more"
              onClick={() => setMoreOpen((open) => !open)}
              className="flex min-h-[3.5rem] min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 text-[10px] font-medium text-muted"
            >
              <MoreHorizontal className="size-[1.375rem]" aria-hidden />
              <span>More</span>
            </button>
          </nav>
          {moreOpen ? (
            <div className="fixed inset-x-0 bottom-16 z-[60] mx-3 rounded-2xl border border-border bg-card p-2 shadow-lg lg:hidden" role="menu" data-attr="owner-more-sheet">
              {items
                .filter((item) => !primary.some((p) => p.id === item.id))
                .map((item) => {
                  const Icon = ICONS[item.id];
                  return (
                    <Link
                      key={item.id}
                      href={item.href}
                      role="menuitem"
                      onClick={() => setMoreOpen(false)}
                      data-attr={`owner-more-${item.id}`}
                      className="flex items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium text-foreground"
                    >
                      <Icon className="size-4" aria-hidden />
                      {item.label}
                    </Link>
                  );
                })}
              <div className="px-3 py-3">
                <PortalSignOutButton className="text-sm font-semibold text-red-600" onRequestConfirm={() => setMoreOpen(false)} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
