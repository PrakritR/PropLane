"use client";

import { ChevronDown } from "lucide-react";

import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { PhoneSectionPicker, PhoneSheetGlyph, usePhoneSheetPresentation } from "@/components/ui/phone-bottom-sheet";

export type SettingsSectionPickerItem = { id: string; label: string };

/**
 * Which Settings section is open. A row of pills on a desktop; on a phone the same choice is
 * the shared bottom sheet (`ui/phone-bottom-sheet.tsx`) — the pills wrapped into a ragged
 * block there, and a dropdown of them would have been a third surface for "jump to section".
 */
export function SettingsSectionPicker({
  items,
  activeId,
  onSelect,
}: {
  items: readonly SettingsSectionPickerItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const phone = usePhoneSheetPresentation();
  if (phone) {
    const active = items.find((item) => item.id === activeId);
    return (
      <div className="mb-4" data-attr="manager-settings-section-picker">
        <PhoneSectionPicker
          title="Settings"
          controlsLabel="Settings section"
          triggerLabel="Settings section"
          triggerDataAttr="manager-settings-section-picker-toggle"
          trigger={
            <>
              <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-foreground">{active?.label ?? "Settings"}</span>
              <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
            </>
          }
          groups={[
            {
              items: items.map((item) => ({
                id: item.id,
                label: item.label,
                current: item.id === activeId,
                dataAttr: `manager-settings-tab-${item.id}`,
                glyph: <PhoneSheetGlyph kind={item.id === activeId ? "current" : "todo"} />,
                onSelect: () => onSelect(item.id),
              })),
            },
          ]}
        />
      </div>
    );
  }
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={activeId === item.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
          data-attr={`manager-settings-tab-${item.id}`}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
