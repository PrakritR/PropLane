"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { PortalRecordRail } from "@/components/portal/portal-property-rail";
import {
  PortalRecordSectionsDisclosure,
  type PortalPropertySectionItem,
} from "@/components/portal/portal-property-section-list";
import { PortalRecordSectionPicker } from "@/components/portal/portal-record-section-picker";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { RecordSections } from "@/lib/portals/record-sections";

/**
 * A record's own header icons (Record payment · Send reminder · Edit ·
 * Delete, …) — published into the title row's icon slot
 * (`PortalRecordDetailPage iconTitleActions` + `PortalRecordActions`).
 * The same measured row stays in the title on phones; secondary actions fold
 * into the anchored menu while the primary stays at the right edge.
 */
export function PortalRecordHeaderIconActions({
  actions,
  onAction,
  primaryId,
}: {
  actions: RecordSections["headerActions"];
  onAction?: (actionId: string) => void;
  /** The one filled action, when it is not the first icon (a vendor leads with Edit but fills Message). */
  primaryId?: string;
}) {
  if (actions.length === 0) return null;
  const filledIndex = primaryId ? actions.findIndex((action) => action.id === primaryId) : 0;
  return (
    <PortalAdaptiveActionRow
      align="end"
      gapPx={6}
      actions={actions.map((action, index) => ({
        id: action.id,
        tone: index === filledIndex && action.tone !== "danger" ? "primary" : action.tone,
        node: <PortalIconAction
          ring
          ringPrimary={index === filledIndex && action.tone !== "danger"}
          tone={action.tone}
          icon={action.icon}
          label={action.label}
          data-attr={`record-header-action-${action.id}`}
          onClick={() => onAction?.(action.id)}
        />,
        menuItem: <DropdownMenuItem
          className={action.tone === "danger" ? "text-red-600" : undefined}
          data-attr={`record-header-action-${action.id}`}
          onSelect={() => onAction?.(action.id)}
        >{action.label}</DropdownMenuItem>,
      }))}
    />
  );
}

/**
 * Desktop rail + phone section picker — the same chrome for any manager,
 * resident or vendor record. Reads a `RecordSections` value straight from
 * `src/lib/portals/record-sections.ts` instead of a caller-built
 * `items`/`groups` pair, so the rail and the phone picker
 * (`PortalRecordSectionPicker`) both come from the one registry entry.
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
  /** @deprecated No longer consumed here — the sticky action bar this drove is gone. Kept so call sites need not change yet. */
  onHeaderAction?: (actionId: string) => void;
  children: ReactNode;
}) {
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
          <PortalRecordSectionPicker groups={sections.groups} recordId={recordId} activeId={activeId} ariaLabel={ariaLabel} />
        </div>
        <div className="portal-record-content flex min-h-0 flex-1 flex-col">{children}</div>
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
