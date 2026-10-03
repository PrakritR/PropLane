import type { MockProperty } from "@/data/types";
import type {
  ManagerListingSubmissionV1,
  PropertyPromotionBuiltinKey,
  PropertyPromotionBuiltinsState,
} from "@/lib/manager-listing-submission";
import { buildPromotionDraftAutofill } from "@/lib/promotion-listing-context";
import {
  composeFallbackFlyerCopy,
  PROMOTION_TEMPLATE_DEFAULT,
  PROMOTION_TONE_OPTIONS,
  readFlyerEntries,
  type FlyerEntry,
  type ManagerPromotionRow,
  type PromotionInputs,
} from "@/lib/promotion-flyer";
import {
  composeFallbackPromotionText,
  readPromotionTextEntries,
  type PromotionTextFormat,
} from "@/lib/promotion-text";
import {
  defaultPromotionFlyerEntryId,
  defaultPromotionTextEntryId,
  isSystemOwnedPromotionEntryId,
} from "@/lib/promotion-default-sync";
import { PROMOTION_TEXT_FORMAT_DEFAULT } from "@/lib/promotion-text";
import type { PromotionAsset } from "@/lib/promotion-assets";

export type { PropertyPromotionBuiltinKey, PropertyPromotionBuiltinsState } from "@/lib/manager-listing-submission";

export type PropertyPromotionBuiltinDef = {
  key: PropertyPromotionBuiltinKey;
  name: string;
  tab: "flyers" | "social";
  kind: "flyer" | "text" | "print";
  textFormat?: PromotionTextFormat;
};

export const PROPERTY_PROMOTION_BUILTINS: PropertyPromotionBuiltinDef[] = [
  { key: "flyer", name: "Listing flyer", tab: "flyers", kind: "flyer" },
  { key: "door", name: "Door card", tab: "flyers", kind: "print" },
  { key: "social", name: "Social post", tab: "social", kind: "text", textFormat: "instagram_caption" },
  { key: "blurb", name: "Listing blurb", tab: "social", kind: "text", textFormat: PROMOTION_TEXT_FORMAT_DEFAULT },
];

export const BUILTIN_PROMOTION_DEFS = PROPERTY_PROMOTION_BUILTINS;

export function promotionBuiltinTabForKey(key: PropertyPromotionBuiltinKey): "flyers" | "social" {
  return PROPERTY_PROMOTION_BUILTINS.find((d) => d.key === key)?.tab ?? "flyers";
}

export function filterCustomPromotionAssets(assets: PromotionAsset[]): PromotionAsset[] {
  return customPromotionAssetsForTab(assets, "yours");
}

export type PropertyPromotionBuiltinOverrides = NonNullable<
  PropertyPromotionBuiltinsState[PropertyPromotionBuiltinKey]
>;

export function readPromotionBuiltins(sub: ManagerListingSubmissionV1 | null | undefined): PropertyPromotionBuiltinsState {
  return sub?.promotionBuiltins ?? {};
}

export function builtinEnabled(
  state: PropertyPromotionBuiltinsState,
  key: PropertyPromotionBuiltinKey,
): boolean {
  const entry = state[key];
  if (entry?.enabled === false) return false;
  return true;
}

function listingInputs(
  property: MockProperty,
  opts?: { managerContact?: string; appOrigin?: string },
): PromotionInputs {
  const autofill = buildPromotionDraftAutofill(property, opts);
  return {
    headline: autofill.headline,
    sellingPoints: autofill.sellingPoints,
    price: autofill.price,
    promo: autofill.promo,
    cta: autofill.cta,
    contact: autofill.contact,
    tone: PROMOTION_TONE_OPTIONS[0]!,
    address: autofill.address,
    customDetails: autofill.customDetails,
    schedulingUrl: autofill.schedulingUrl,
    includeSchedulingLink: autofill.includeSchedulingLink,
    images: autofill.images,
  };
}

export function resolveBuiltinFlyerEntry(
  propertyId: string,
  property: MockProperty,
  promotionRow: ManagerPromotionRow | null,
  overrides: PropertyPromotionBuiltinOverrides | undefined,
  opts?: { managerContact?: string; appOrigin?: string },
): FlyerEntry | null {
  const seedId = defaultPromotionFlyerEntryId(propertyId);
  const stored = promotionRow ? readFlyerEntries(promotionRow).find((e) => e.id === seedId) : null;
  const baseInputs = stored?.inputs ?? listingInputs(property, opts);
  const mergedInputs: PromotionInputs = {
    ...baseInputs,
    headline: overrides?.flyer?.headline ?? baseInputs.headline,
    sellingPoints: overrides?.flyer?.sellingPoints ?? baseInputs.sellingPoints,
    price: overrides?.flyer?.price ?? baseInputs.price,
    promo: overrides?.flyer?.promo ?? baseInputs.promo,
    cta: overrides?.flyer?.cta ?? baseInputs.cta,
    contact: overrides?.flyer?.contact ?? baseInputs.contact,
  };
  const label = buildPromotionDraftAutofill(property, opts).propertyLabel;
  const copy = stored?.copy ?? composeFallbackFlyerCopy(mergedInputs, label);
  if (stored) {
    return { ...stored, inputs: mergedInputs, copy };
  }
  return {
    id: seedId,
    title: "Listing flyer",
    copy,
    inputs: mergedInputs,
    theme: "cobalt",
    flyerSize: "letter",
    template: PROMOTION_TEMPLATE_DEFAULT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function resolveBuiltinTextCopy(
  property: MockProperty,
  format: PromotionTextFormat,
  promotionRow: ManagerPromotionRow | null,
  overrides: PropertyPromotionBuiltinOverrides | undefined,
  opts?: { managerContact?: string; appOrigin?: string },
): { format: PromotionTextFormat; plain: string; tone: string } {
  const propertyId = property.id?.trim() ?? "";
  const seedId = defaultPromotionTextEntryId(propertyId);
  const stored = promotionRow ? readPromotionTextEntries(promotionRow).find((e) => e.id === seedId) : null;
  const label = buildPromotionDraftAutofill(property, opts).propertyLabel;
  const tone = overrides?.text?.tone ?? PROMOTION_TONE_OPTIONS[0]!;
  if (overrides?.text?.body?.trim()) {
    return { format, plain: overrides.text.body.trim(), tone };
  }
  if (stored && (format === PROMOTION_TEXT_FORMAT_DEFAULT || stored.copy.format === format)) {
    const hook = stored.copy.hook ?? "";
    const body = stored.copy.body ?? "";
    const tags = stored.copy.hashtags ?? "";
    return {
      format: stored.copy.format,
      plain: [hook, body, tags].filter(Boolean).join("\n\n"),
      tone: stored.copy.tone ?? tone,
    };
  }
  const fallback = composeFallbackPromotionText(listingInputs(property, opts), label, format);
  return { format, plain: [fallback.hook, fallback.body, fallback.hashtags].filter(Boolean).join("\n\n"), tone };
}

export function isCustomPromotionAsset(propertyId: string, entryId: string | null | undefined): boolean {
  if (!entryId) return true;
  if (isSystemOwnedPromotionEntryId(entryId)) return false;
  return true;
}

export function customPromotionAssetsForTab(
  assets: import("@/lib/promotion-assets").PromotionAsset[],
  _tab: "yours",
): import("@/lib/promotion-assets").PromotionAsset[] {
  return assets.filter((asset) => {
    const entryId =
      asset.kind === "flyer"
        ? asset.flyerEntry?.id
        : asset.kind === "text"
          ? asset.textEntry?.id
          : asset.uploadEntry?.id;
    if (asset.kind === "upload") return true;
    return isCustomPromotionAsset(asset.row.propertyId ?? "", entryId);
  });
}

export function resolveBuiltinFlyerPromotion(
  property: MockProperty,
  promotionRow: ManagerPromotionRow | null,
  builtins: PropertyPromotionBuiltinsState,
  opts?: { managerContact?: string; appOrigin?: string },
): ManagerPromotionRow {
  const overrides = builtins.flyer;
  const entry = resolveBuiltinFlyerEntry(property.id ?? "", property, promotionRow, overrides, opts)!;
  const now = new Date().toISOString();
  const label = buildPromotionDraftAutofill(property, opts).propertyLabel;
  return {
    id: promotionRow?.id ?? "builtin-flyer-preview",
    managerUserId: promotionRow?.managerUserId ?? null,
    propertyId: property.id ?? null,
    propertyLabel: label,
    title: "Listing flyer",
    theme: entry.theme,
    flyerSize: entry.flyerSize,
    template: entry.template,
    status: "generated",
    inputs: entry.inputs,
    copy: entry.copy,
    createdAt: promotionRow?.createdAt ?? now,
    updatedAt: now,
  };
}

export function resolveBuiltinTextPromotion(
  property: MockProperty,
  format: PromotionTextFormat,
  promotionRow: ManagerPromotionRow | null,
  builtins: PropertyPromotionBuiltinsState,
  key: "social" | "blurb",
  opts?: { managerContact?: string; appOrigin?: string },
): { plain: string; format: PromotionTextFormat } {
  const overrides = builtins[key];
  const resolved = resolveBuiltinTextCopy(property, format, promotionRow, overrides, opts);
  return { plain: resolved.plain, format: resolved.format };
}
