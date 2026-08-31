"use client";

import { Plus } from "lucide-react";
import { PORTAL_EDIT_ROW_ICON_BUTTON_CLASS } from "@/components/portal/portal-collapsible-edit-row";
import {
  PROMOTION_PRESET_DEFS,
  missingPromotionPresets,
  type PromotionPresetKind,
} from "@/lib/promotion-default-sync";
import type { ManagerPromotionRow } from "@/lib/promotion-flyer";

/** Dashed preset row — matches request-type suggestions on the Requests tab. */
export const PROMOTION_PRESET_ROW_CLASS =
  "flex items-center justify-between gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5";

/** Listing-derived defaults not yet on this property — tap + to add. */
export function PromotionDefaultSuggestions({
  propertyId,
  promotionRow,
  onAddPreset,
}: {
  propertyId: string;
  promotionRow: ManagerPromotionRow | null;
  onAddPreset: (preset: PromotionPresetKind) => void;
}) {
  const missing = missingPromotionPresets(propertyId, promotionRow);
  const presets = PROMOTION_PRESET_DEFS.filter((p) => missing.includes(p.kind));

  if (presets.length === 0) return null;

  return (
    <div className="space-y-2" data-attr="promotion-default-suggestions">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-muted">Suggested promotions</p>
      {presets.map((preset) => (
        <div key={preset.kind} className={PROMOTION_PRESET_ROW_CLASS}>
          <div className="min-w-0 flex-1 text-left">
            <p className="text-sm font-medium text-foreground">{preset.name}</p>
            <p className="mt-0.5 text-xs text-muted">{preset.description}</p>
          </div>
          <button
            type="button"
            className={PORTAL_EDIT_ROW_ICON_BUTTON_CLASS}
            title={`Add ${preset.name}`}
            aria-label={`Add ${preset.name}`}
            data-attr={`promotion-preset-add-${preset.kind}`}
            onClick={() => onAddPreset(preset.kind)}
          >
            <Plus className="h-4 w-4" strokeWidth={2.25} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
