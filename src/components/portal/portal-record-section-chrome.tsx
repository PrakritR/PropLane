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
import type { RecordSections } from "@/lib/portals/record-sections";

/**
 * A record's own header icons (Record payment · Send reminder · Edit ·
 * Delete, …) — published into the title row's icon slot
 * (`PortalRecordDetailPage iconTitleActions` + `PortalRecordActions`).
 * Hidden below `lg`, same as before (PLAN-0920-1058); PLAN-0921-1029 removes
 * the phone's sticky action bar that used to stand in for them below `lg`
 * without replacing it — a record page has no phone toolbar or footer at all.
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
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
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
