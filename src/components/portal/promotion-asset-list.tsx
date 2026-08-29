"use client";

import { Button } from "@/components/ui/button";
import {
  PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS,
  PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS,
} from "@/components/portal/portal-property-detail-section";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  promotionAssetKindIndices,
  promotionAssetListTitle,
  type PromotionAsset,
} from "@/lib/promotion-assets";

function promotionKindLabel(kind: PromotionAsset["kind"]): string {
  if (kind === "flyer") return "Flyer";
  if (kind === "text") return "Text";
  return "Upload";
}

function rowTitle(asset: PromotionAsset, indexWithinKind: number): string {
  const stored =
    asset.kind === "flyer"
      ? (asset.flyerEntry?.title ?? "")
      : asset.kind === "upload"
        ? (asset.uploadEntry?.title ?? "")
        : (asset.textEntry?.title ?? "");
  return stored.trim() || promotionAssetListTitle(asset, indexWithinKind);
}

function promotionAssetCanEdit(asset: PromotionAsset, onEdit?: (asset: PromotionAsset) => void): boolean {
  return Boolean(onEdit) && (asset.kind === "flyer" || asset.kind === "text");
}

export function PromotionAssetStack({
  assets,
  onView,
  onEdit,
  emptyMessage = "No promotions yet.",
  showPropertyLabel = true,
  variant = "plain",
  selectedIds,
  onToggleSelected,
}: {
  assets: PromotionAsset[];
  onView?: (asset: PromotionAsset) => void;
  onEdit?: (asset: PromotionAsset) => void;
  emptyMessage?: string;
  /** When false (property Promotion tab), the property name is omitted from the subtitle. */
  showPropertyLabel?: boolean;
  variant?: "card" | "plain";
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
}) {
  if (assets.length === 0) {
    if (!emptyMessage?.trim()) return null;
    return <PortalDataTableEmpty message={emptyMessage} icon="data" />;
  }

  const kindIndices = promotionAssetKindIndices(assets);
  const selectionMode = Boolean(selectedIds && onToggleSelected);

  const rows = assets.map((asset) => {
        const indexWithinKind = kindIndices.get(asset.id) ?? 0;
        const title = rowTitle(asset, indexWithinKind);
        const canEdit = promotionAssetCanEdit(asset, onEdit);
        const subtitleParts = [
          showPropertyLabel ? asset.propertyLabel : null,
          promotionKindLabel(asset.kind),
          asset.subtitle,
        ].filter(Boolean);

        if (selectionMode) {
          return (
            <div key={asset.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
              <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={selectedIds!.has(asset.id)}
                  data-attr={`promotion-select-${asset.id}`}
                  onChange={() => onToggleSelected!(asset.id)}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{title}</p>
                  <p className="mt-0.5 text-xs text-muted">{subtitleParts.join(" · ")}</p>
                </div>
              </label>
            </div>
          );
        }

        return (
          <div key={asset.id} className={PORTAL_PROPERTY_DETAIL_LIST_ROW_CLASS}>
            <div className="min-w-0 flex-1">
              {onView && asset.kind === "upload" ? (
                <button
                  type="button"
                  className="min-w-0 text-left text-sm font-semibold text-foreground hover:underline"
                  data-attr="promotion-row"
                  onClick={() => onView(asset)}
                >
                  {title}
                </button>
              ) : (
                <p className="text-sm font-semibold text-foreground">{title}</p>
              )}
              <p className="mt-0.5 text-xs text-muted">{subtitleParts.join(" · ")}</p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 flex-nowrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_PROPERTY_DETAIL_ACTION_BUTTON_CLASS}
                  data-attr={`promotion-row-edit-${asset.id}`}
                  onClick={() => onEdit?.(asset)}
                >
                  Edit
                </Button>
              </div>
            ) : null}
          </div>
        );
      });

  if (variant === "plain") {
    return <>{rows}</>;
  }

  return <div className="divide-y divide-border rounded-xl border border-border bg-card">{rows}</div>;
}

export { promotionAssetCanEdit };
