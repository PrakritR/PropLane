"use client";

import { ChevronDown } from "lucide-react";

import type { RecordSectionGroup } from "@/lib/portals/record-sections";
import { PhoneSectionPicker, PhoneSheetGlyph } from "@/components/ui/phone-bottom-sheet";
import { PortalPropertySectionInfo } from "@/components/portal/portal-property-section-info";
import { PROPERTY_RECORD_SECTION_INFO } from "@/lib/property-record-section-info";

/**
 * Phone section menu. Closed: the current section and a chevron. Open: the shared phone
 * bottom sheet (`ui/phone-bottom-sheet.tsx`) — every group label, then its sections, with
 * the current one marked by the blue bar. Tapping a section navigates and closes; the ✕,
 * the backdrop, a swipe down and Escape dismiss it.
 */
export function PortalRecordSectionPicker({
  groups,
  recordId,
  activeId,
  ariaLabel,
}: {
  groups: RecordSectionGroup[];
  recordId: string;
  activeId?: string;
  ariaLabel: string;
}) {
  const flatGroups = groups.filter((group) => group.items.length > 0);
  const active = flatGroups.flatMap((group) => group.items).find((item) => item.id === activeId);

  if (flatGroups.length === 0) return null;

  return (
    <div className="lg:hidden" data-attr="record-section-picker">
      <PhoneSectionPicker
        title="Sections"
        controlsLabel={ariaLabel}
        ariaCurrent="page"
        triggerDataAttr="record-section-picker-toggle"
        closeDataAttr="record-section-picker-close"
        groupDataAttr="record-section-picker-group"
        className="justify-between px-4 text-[14.5px] font-semibold text-foreground"
        trigger={
          <>
            <span className="min-w-0 flex-1 truncate">{active?.label ?? "Sections"}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </>
        }
        groups={flatGroups.map((group) => ({
          label: group.label,
          items: group.items.map((item) => ({
            id: item.id,
            current: item.id === activeId,
            href: item.href(recordId),
            dataAttr: `record-section-picker-item-${item.id}`,
            glyph: item.id === activeId ? <PhoneSheetGlyph kind="current" /> : <PhoneSheetGlyph kind="todo" />,
            label: (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                {item.label}
                {PROPERTY_RECORD_SECTION_INFO[item.id] ? (
                  <PortalPropertySectionInfo
                    title={PROPERTY_RECORD_SECTION_INFO[item.id]!.title}
                    body={PROPERTY_RECORD_SECTION_INFO[item.id]!.body}
                    dataAttr={`property-section-picker-info-${item.id}`}
                  />
                ) : null}
              </span>
            ),
          })),
        }))}
      />
    </div>
  );
}
