"use client";

/**
 * The manager's Promotions list: one white card per promotion, the shape
 * every other portal list has (AGENTS.md → Portal UI system: "Every list tab
 * copies Properties"). A tile (the promotion's own image thumbnail when it
 * has one, a kind glyph otherwise), the promotion's own title, the property
 * as the place line, glyph facts — kind, last updated — and the ⋯ the list
 * surface draws on a selectable row, carrying Edit / Delete.
 *
 * No checkboxes on the row itself and no pill: the tab (All / Text / Image)
 * already says the bucket (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */

import { Clock, FileText, Image as ImageIcon, Megaphone } from "lucide-react";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PROMOTION_TEXT_FORMAT_OPTIONS } from "@/lib/promotion-text";
import { cn } from "@/lib/utils";
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

function rowTitle(asset: PromotionAsset, indexWithinKind: number, propertyLabel: string): string {
  const stored =
    asset.kind === "flyer"
      ? (asset.flyerEntry?.title ?? "")
      : asset.kind === "upload"
        ? (asset.uploadEntry?.title ?? "")
        : (asset.textEntry?.title ?? "");
  const trimmed = stored.trim();
  if (trimmed) return trimmed;
  const fallback = promotionAssetListTitle(asset, indexWithinKind);
  // A genuinely untitled row reads "<Kind> · <house>" rather than a bare
  // sequence number — the house is what tells two untitled promotions apart.
  return propertyLabel ? `${fallback} · ${propertyLabel}` : fallback;
}

/** The specific text format ("Listing blurb", "Instagram caption", …) reads better than the generic "Text". */
function promotionRowKindFact(asset: PromotionAsset): string {
  if (asset.kind === "text" && asset.textEntry) {
    return (
      PROMOTION_TEXT_FORMAT_OPTIONS.find((option) => option.id === asset.textEntry!.copy.format)?.label ??
      "Text"
    );
  }
  return promotionKindLabel(asset.kind);
}

function promotionRowUpdatedAt(asset: PromotionAsset): string {
  const iso =
    asset.flyerEntry?.updatedAt ?? asset.textEntry?.updatedAt ?? asset.uploadEntry?.updatedAt ?? asset.row.updatedAt;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A real photo only — never a fabricated stand-in. */
function promotionRowThumbnail(asset: PromotionAsset): string | null {
  if (asset.kind === "upload" && asset.uploadEntry && asset.uploadEntry.kind !== "pdf") {
    return asset.uploadEntry.fileUrl;
  }
  if (asset.kind === "flyer" && asset.flyerEntry?.inputs.images?.[0]) {
    return asset.flyerEntry.inputs.images[0]!;
  }
  return null;
}

function PromotionRowTile({ asset }: { asset: PromotionAsset }) {
  const tileClass = "h-[4.125rem] w-[5.5rem] rounded-[10px] max-md:h-[3.125rem] max-md:w-16";
  const thumbnail = promotionRowThumbnail(asset);
  if (thumbnail) {
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL thumbnail; next/image cannot optimize it.
    return <img src={thumbnail} alt="" aria-hidden className={cn(tileClass, "object-cover")} />;
  }
  const Icon = asset.kind === "text" ? FileText : asset.kind === "upload" ? ImageIcon : Megaphone;
  return (
    <div aria-hidden className={cn(tileClass, "grid place-items-center bg-accent/60 text-muted/80")}>
      <Icon className="size-[22px]" strokeWidth={1.5} />
    </div>
  );
}

function promotionAssetCanEdit(asset: PromotionAsset, onEdit?: (asset: PromotionAsset) => void): boolean {
  return Boolean(onEdit) && (asset.kind === "flyer" || asset.kind === "text");
}

/**
 * C241: a first-time manager staring at "No promotions yet" has no way to
 * tell what pressing "+" actually generates. This is a static, muted,
 * non-interactive sample row — same tile/title/facts shape a real asset
 * row draws, an obviously placeholder address, no photo (never a fabricated
 * listing image) — so the empty state itself shows the shape of the thing
 * it makes.
 */
function PromotionEmptyExample() {
  return (
    <div className="mb-3" aria-hidden data-attr="promotion-empty-example">
      <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted/60">Example</p>
      <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border/70 bg-accent/20 p-3 opacity-80">
        <div className="grid h-[4.125rem] w-[5.5rem] shrink-0 place-items-center rounded-[10px] bg-primary/10 text-primary/70 max-md:h-[3.125rem] max-md:w-16">
          <Megaphone className="size-[22px]" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-foreground/80">Sample flyer — 123 Example St</p>
          <p className="truncate text-[12px] text-muted">Flyer · Updated just now</p>
        </div>
      </div>
    </div>
  );
}

export function PromotionAssetStack({
  assets,
  onView,
  emptyMessage = "No promotions yet.",
  showPropertyLabel = true,
  selectedIds,
  onToggleSelected,
}: {
  assets: PromotionAsset[];
  onView?: (asset: PromotionAsset) => void;
  /**
   * @deprecated Edit now reaches a row only through the shared ⋯ (the list's
   * own selection context), never a button this component draws itself.
   * Kept so existing callers still compile.
   */
  onEdit?: (asset: PromotionAsset) => void;
  emptyMessage?: string;
  /** When false (property Promotion tab), the property name is omitted from the place line. */
  showPropertyLabel?: boolean;
  /** @deprecated Every list is a card list now; kept so existing callers still compile. */
  variant?: "card" | "plain";
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
}) {
  if (assets.length === 0) {
    if (!emptyMessage?.trim()) return null;
    return (
      <div>
        <PromotionEmptyExample />
        <PortalDataTableEmpty message={emptyMessage} icon="data" />
      </div>
    );
  }

  const kindIndices = promotionAssetKindIndices(assets);
  const selectable = Boolean(onToggleSelected);

  return (
    <div data-attr="promotion-list-rows">
      {assets.map((asset) => {
        const indexWithinKind = kindIndices.get(asset.id) ?? 0;
        const propertyLabel = showPropertyLabel ? asset.propertyLabel : "";
        const title = rowTitle(asset, indexWithinKind, propertyLabel);
        const updated = promotionRowUpdatedAt(asset);
        return (
          <PortalPropertyRecordRow
            key={asset.id}
            title={title}
            address={propertyLabel || promotionRowKindFact(asset)}
            leading={<PromotionRowTile asset={asset} />}
            leadingShape="square"
            facts={
              <>
                <PortalRowFact icon={Megaphone} srLabel="Kind">
                  {promotionRowKindFact(asset)}
                </PortalRowFact>
                {updated ? (
                  <PortalRowFact icon={Clock} srLabel="Updated">
                    Updated {updated}
                  </PortalRowFact>
                ) : null}
              </>
            }
            checked={selectable ? selectedIds?.has(asset.id) : undefined}
            onSelectedChange={selectable ? () => onToggleSelected!(asset.id) : undefined}
            onOpen={onView ? () => onView(asset) : undefined}
            omitActionView
            dataAttr={`promotion-row-${asset.id}`}
          />
        );
      })}
    </div>
  );
}

export { promotionAssetCanEdit };
