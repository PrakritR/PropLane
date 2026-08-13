"use client";

import { Plus } from "lucide-react";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS } from "@/components/portal/portal-collapsible-edit-row";

/** Dashed preset row — matches request-type and application-question suggestions. */
export const PROPERTY_TEMPLATE_PRESET_ROW_CLASS =
  "flex items-center justify-between gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5";

export type PropertyTemplatePreset = {
  /** Stable key handed back to `onAdd` — a listing seed key in both callers. */
  key: string;
  label: string;
  subtitle: string;
};

/**
 * "Add a lease" / "Add an application" — the PropLane defaults a property does
 * not carry yet, each with a `+` to adopt it.
 *
 * Both template tabs went opt-in so that Delete sticks, which makes this the
 * ONLY route back to a default the manager removed. Lease and application had
 * grown separate copies of this markup; keeping one component means the two
 * tabs cannot drift apart visually, which is the whole point of the request
 * that produced it.
 *
 * This is deliberately NOT the big dashed `PortalListAddRow`. That row is the
 * "add a new one from scratch" affordance and each tab still renders it below
 * this list — same shape as the Requests tab.
 */
export function PropertyTemplatePresetList({
  title,
  presets,
  onAdd,
  dataAttr,
  addDataAttrPrefix,
}: {
  title: string;
  presets: PropertyTemplatePreset[];
  onAdd: (key: string) => void;
  dataAttr: string;
  addDataAttrPrefix: string;
}) {
  if (presets.length === 0) return null;

  return (
    <div className="space-y-2" data-attr={dataAttr}>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">{title}</p>
      {presets.map((preset) => (
        <div key={preset.key} className={PROPERTY_TEMPLATE_PRESET_ROW_CLASS}>
          <div className="min-w-0 flex-1 text-left">
            <p className="text-sm font-medium text-foreground">{preset.label}</p>
            <p className="mt-0.5 text-xs text-muted">{preset.subtitle}</p>
          </div>
          <button
            type="button"
            className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
            title={`Add ${preset.label}`}
            aria-label={`Add ${preset.label}`}
            data-attr={`${addDataAttrPrefix}-${preset.key}`}
            onClick={() => onAdd(preset.key)}
          >
            <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
