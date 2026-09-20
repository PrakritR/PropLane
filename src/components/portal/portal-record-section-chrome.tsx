"use client";

import type { ReactNode } from "react";
import { PortalPropertyRail } from "@/components/portal/portal-property-rail";
import {
  PortalRecordSectionsDisclosure,
  type PortalPropertySectionItem,
} from "@/components/portal/portal-property-section-list";

/**
 * Desktop rail + phone All sections — the same chrome a property uses, for
 * any manager record (resident, vendor, service, task, payment, inspection).
 */
export function PortalRecordSectionChrome({
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
      <PortalPropertyRail
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
