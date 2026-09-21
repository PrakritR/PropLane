"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { PortalRecordRail } from "@/components/portal/portal-property-rail";
import {
  PortalRecordSectionsDisclosure,
  type PortalPropertySectionItem,
} from "@/components/portal/portal-property-section-list";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useHideBottomNavWhileMounted } from "@/lib/portal-record-page-chrome";
import type { RecordSections } from "@/lib/portals/record-sections";
import { cn } from "@/lib/utils";

/**
 * A record's own header icons (Record payment · Send reminder · Edit ·
 * Delete, …) — published into the title row's icon slot
 * (`PortalRecordDetailPage iconTitleActions` + `PortalRecordActions`).
 * Hidden below `lg`: a phone gets the same actions from
 * {@link PortalRecordSectionChrome}'s sticky bar instead, never both at once.
 */
export function PortalRecordHeaderIconActions({
  actions,
  onAction,
}: {
  actions: RecordSections["headerActions"];
  onAction?: (actionId: string) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <span className="hidden items-center gap-1.5 lg:flex">
      {actions.map((action, index) => (
        <PortalIconAction
          key={action.id}
          ring
          ringPrimary={index === 0}
          tone={action.tone}
          icon={action.icon}
          label={action.label}
          data-attr={`record-header-action-${action.id}`}
          onClick={() => onAction?.(action.id)}
        />
      ))}
    </span>
  );
}

/**
 * Desktop rail + phone chip strip — the same chrome for any manager, resident
 * or vendor record. As of PLAN-0920-1058 (area 1a) this reads a
 * `RecordSections` value straight from `src/lib/portals/record-sections.ts`
 * instead of a caller-built `items`/`groups` pair, so the rail, the phone
 * chips, and the phone sticky action all come from the one registry entry.
 * The legacy `items`/`groups` shape is still accepted (`legacy`) for a call
 * site not yet moved onto the registry.
 */
export function PortalRecordSectionChrome(
  props:
    | {
        sections: RecordSections;
        recordId: string;
        activeId: string;
        title: string;
        subtitle?: string;
        backHref: string;
        backLabel: string;
        ariaLabel: string;
        /** Fires for the phone sticky primary button and the ⋯ overflow items. */
        onHeaderAction?: (actionId: string) => void;
        children: ReactNode;
      }
    | {
        /** @deprecated Pass `sections` + `recordId` from the registry instead. */
        items: PortalPropertySectionItem[];
        activeId: string;
        groups: Array<{ label: string; ids: string[] }>;
        title: string;
        subtitle?: string;
        backHref: string;
        backLabel: string;
        ariaLabel: string;
        currentLabel: string;
        defaultDisclosureOpen?: boolean;
        children: ReactNode;
      },
) {
  if ("sections" in props) return <PortalRecordSectionChromeFromRegistry {...props} />;
  return <PortalRecordSectionChromeLegacy {...props} />;
}

function PortalRecordSectionChromeFromRegistry({
  sections,
  recordId,
  activeId,
  title,
  subtitle,
  backHref,
  backLabel,
  ariaLabel,
  onHeaderAction,
  children,
}: {
  sections: RecordSections;
  recordId: string;
  activeId: string;
  title: string;
  subtitle?: string;
  backHref: string;
  backLabel: string;
  ariaLabel: string;
  onHeaderAction?: (actionId: string) => void;
  children: ReactNode;
}) {
  // A record page's phone sticky action replaces the bottom nav bar while it
  // is mounted (no-bottom-bar) — see src/lib/portal-record-page-chrome.ts.
  useHideBottomNavWhileMounted(true);

  const items = useMemo(
    () =>
      sections.groups.flatMap((group) =>
        group.items.map((item) => ({ id: item.id, label: item.label, href: item.href(recordId) })),
      ),
    [sections, recordId],
  );
  const railGroups = useMemo(
    () => sections.groups.map((group) => ({ label: group.label, ids: group.items.map((item) => item.id) })),
    [sections],
  );
  const primaryAction = sections.phonePrimary
    ? sections.headerActions.find((action) => action.id === sections.phonePrimary)
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <PortalRecordRail
        items={items}
        activeId={activeId}
        backHref={backHref}
        backLabel={backLabel}
        showBackLink={false}
        showTitleBlock={false}
        title={title}
        subtitle={subtitle}
        groups={railGroups}
        ariaLabel={ariaLabel}
        className="lg:mr-5 lg:rounded-xl lg:border lg:bg-card"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0">
        <div className="px-0 pt-3 lg:hidden">
          <PortalRecordSectionChips items={items} activeId={activeId} ariaLabel={ariaLabel} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {primaryAction ? (
          <PortalRecordStickyAction
            primaryId={primaryAction.id}
            primaryLabel={sections.phonePrimaryLabel ?? primaryAction.label}
            primaryIcon={primaryAction.icon}
            overflow={sections.headerActions.filter((action) => action.id !== primaryAction.id)}
            onAction={onHeaderAction}
          />
        ) : null}
      </div>
    </div>
  );
}

/** @deprecated Kept for a call site not yet moved onto the registry (`sections`/`recordId`). */
function PortalRecordSectionChromeLegacy({
  items,
  activeId,
  groups,
  title,
  subtitle,
  backHref,
  backLabel,
  ariaLabel,
  currentLabel,
  defaultDisclosureOpen = false,
  children,
}: {
  items: PortalPropertySectionItem[];
  activeId: string;
  groups: Array<{ label: string; ids: string[] }>;
  title: string;
  subtitle?: string;
  backHref: string;
  backLabel: string;
  ariaLabel: string;
  currentLabel: string;
  defaultDisclosureOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 lg:flex-row">
      <PortalRecordRail
        items={items}
        activeId={activeId}
        backHref={backHref}
        backLabel={backLabel}
        showBackLink={false}
        showTitleBlock={false}
        title={title}
        subtitle={subtitle}
        groups={groups}
        ariaLabel={ariaLabel}
        className="lg:mr-5 lg:rounded-xl lg:border lg:bg-card"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0">
        <div className="px-0 pt-3 lg:hidden">
          <PortalRecordSectionsDisclosure
            currentLabel={currentLabel}
            items={items}
            activeId={activeId}
            ariaLabel={ariaLabel}
            defaultOpen={defaultDisclosureOpen}
          />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Phone destination strip for a record's sections — replaces the old "All
 * sections" disclosure. Chips scroll horizontally; the current one is filled.
 * No sub-line under a chip — a count badge is the only thing besides the label.
 */
export function PortalRecordSectionChips({
  items,
  activeId,
  ariaLabel,
}: {
  items: Array<{ id: string; label: string; href: string; count?: number }>;
  activeId?: string;
  ariaLabel: string;
}) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label={ariaLabel}
      data-attr="record-section-chips"
      className="mb-3 flex gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] lg:hidden [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={item.href}
            data-attr={`record-section-chip-${item.id}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition",
              active
                ? "border-primary bg-primary text-white"
                : "border-border bg-card text-foreground/85 hover:bg-accent/40",
            )}
          >
            {item.label}
            {!active && item.count ? (
              <span
                className="rounded-full bg-primary/10 px-1.5 text-[11px] font-bold tabular-nums text-primary"
                aria-label={`${item.count} waiting`}
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

/** Bottom-fixed phone bar for a record page — the primary action plus a ⋯ for the rest. */
function PortalRecordStickyAction({
  primaryId,
  primaryLabel,
  primaryIcon: PrimaryIcon,
  overflow,
  onAction,
}: {
  primaryId: string;
  primaryLabel: string;
  primaryIcon: RecordSections["headerActions"][number]["icon"];
  overflow: RecordSections["headerActions"];
  onAction?: (actionId: string) => void;
}) {
  return (
    <div
      className="sticky inset-x-0 bottom-0 z-10 flex shrink-0 items-center gap-2 border-t border-border bg-background/95 px-3 py-2.5 backdrop-blur-sm [padding-bottom:max(0.625rem,env(safe-area-inset-bottom,0px))] lg:hidden"
      data-attr="record-sticky-action"
    >
      <Button
        type="button"
        variant="primary"
        className="min-h-11 flex-1 gap-2 rounded-full text-[14px] font-semibold"
        onClick={() => onAction?.(primaryId)}
        data-attr={`record-sticky-primary-${primaryId}`}
      >
        <PrimaryIcon className="size-4" aria-hidden />
        {primaryLabel}
      </Button>
      {overflow.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-11 shrink-0 rounded-full p-0"
              aria-label="More actions"
              data-attr="record-sticky-more"
            >
              <MoreHorizontal className="size-5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-attr="record-sticky-more-menu">
            {overflow.map((action) => (
              <DropdownMenuItem
                key={action.id}
                onSelect={() => onAction?.(action.id)}
                className={action.tone === "danger" ? "text-red-600" : undefined}
              >
                <action.icon className="mr-2 size-4" aria-hidden />
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
