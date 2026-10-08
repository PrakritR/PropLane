/**
 * Auto-seed helpers for listing-derived promotion defaults. Managers add these
 * from the property Promotion tab (like request-type presets) — nothing is
 * created on panel open.
 */

import type { MockProperty } from "@/data/types";
import {
  composeFallbackFlyerCopy,
  defaultFlyerEntryTitle,
  PROMOTION_TEMPLATE_DEFAULT,
  PROMOTION_TONE_OPTIONS,
  readFlyerEntries,
  type FlyerEntry,
  type ManagerPromotionRow,
  type PromotionInputs,
} from "@/lib/promotion-flyer";
import { buildPromotionDraftAutofill } from "@/lib/promotion-listing-context";
import {
  appendFlyerEntryToRow,
  appendTextEntryToRow,
  buildFlyerEntryFromDraft,
  buildTextEntryFromCopy,
  syncPromotionRowLegacy,
  updateFlyerEntryOnRow,
  updateTextEntryOnRow,
} from "@/lib/promotion-row-ops";
import {
  composeFallbackPromotionText,
  defaultPromotionTextEntryTitle,
  PROMOTION_TEXT_FORMAT_DEFAULT,
  readPromotionTextEntries,
  type PromotionTextEntry,
} from "@/lib/promotion-text";
import { makePromotionId } from "@/lib/manager-promotions-storage";

export const DEFAULT_PROMOTION_FLYER_SEED_SUFFIX = "::default-flyer";
export const DEFAULT_PROMOTION_TEXT_SEED_SUFFIX = "::default-text";

export function defaultPromotionFlyerEntryId(propertyId: string): string {
  return `${propertyId.trim()}${DEFAULT_PROMOTION_FLYER_SEED_SUFFIX}`;
}

export function defaultPromotionTextEntryId(propertyId: string): string {
  return `${propertyId.trim()}${DEFAULT_PROMOTION_TEXT_SEED_SUFFIX}`;
}

/** System-seeded flyer / listing blurb — auto-refreshes from listing facts; not user-deletable. */
export function isSystemOwnedPromotionEntryId(entryId: string): boolean {
  const id = entryId.trim();
  return id.endsWith(DEFAULT_PROMOTION_FLYER_SEED_SUFFIX) || id.endsWith(DEFAULT_PROMOTION_TEXT_SEED_SUFFIX);
}

/**
 * The contact line a flyer or promotion text carries: the workspace work number and work email,
 * and nothing else. No work number means no contact line at all - never a personal phone and never
 * PropLane's own support line standing in for the manager's number.
 */
export function promotionWorkContactLine(workPhone?: string | null, workEmail?: string | null): string {
  const phone = (workPhone ?? "").trim();
  if (!phone) return "";
  return [phone, (workEmail ?? "").trim()].filter(Boolean).join(" · ");
}

function defaultPromotionContact(managerContact?: string): string {
  return managerContact?.trim() ?? "";
}

function inputsFromListing(
  property: MockProperty,
  opts?: { managerContact?: string; appOrigin?: string },
): PromotionInputs {
  const autofill = buildPromotionDraftAutofill(property, {
    managerContact: defaultPromotionContact(opts?.managerContact),
    appOrigin: opts?.appOrigin,
  });
  return {
    headline: autofill.headline,
    sellingPoints: autofill.sellingPoints,
    price: autofill.price,
    promo: autofill.promo,
    cta: autofill.cta,
    contact: autofill.contact || defaultPromotionContact(opts?.managerContact),
    tone: PROMOTION_TONE_OPTIONS[0]!,
    address: autofill.address,
    customDetails: autofill.customDetails,
    schedulingUrl: autofill.schedulingUrl,
    includeSchedulingLink: autofill.includeSchedulingLink,
    images: autofill.images,
  };
}

function emptyPromotionRow(args: {
  propertyId: string;
  propertyLabel: string;
  managerUserId: string;
  now: string;
}): ManagerPromotionRow {
  return {
    id: makePromotionId(),
    managerUserId: args.managerUserId,
    propertyId: args.propertyId,
    propertyLabel: args.propertyLabel,
    title: "Promotion",
    theme: "cobalt",
    flyerSize: "letter",
    template: PROMOTION_TEMPLATE_DEFAULT,
    status: "draft",
    inputs: {
      headline: "",
      sellingPoints: "",
      price: "",
      promo: "",
      cta: "",
      contact: "",
      tone: PROMOTION_TONE_OPTIONS[0]!,
      customDetails: "",
      images: [],
    },
    copy: null,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

function buildDefaultFlyerEntry(
  propertyId: string,
  inputs: PromotionInputs,
  propertyLabel: string,
  now: string,
): FlyerEntry {
  const copy = composeFallbackFlyerCopy(inputs, propertyLabel);
  return {
    ...buildFlyerEntryFromDraft({
      title: defaultFlyerEntryTitle(1),
      copy,
      inputs,
      theme: "cobalt",
      flyerSize: "letter",
      template: PROMOTION_TEMPLATE_DEFAULT,
      now,
    }),
    id: defaultPromotionFlyerEntryId(propertyId),
  };
}

function buildDefaultTextEntry(
  propertyId: string,
  inputs: PromotionInputs,
  propertyLabel: string,
  now: string,
): PromotionTextEntry {
  const copy = composeFallbackPromotionText(inputs, propertyLabel, PROMOTION_TEXT_FORMAT_DEFAULT);
  return {
    ...buildTextEntryFromCopy(copy, defaultPromotionTextEntryTitle(1), now),
    id: defaultPromotionTextEntryId(propertyId),
  };
}

function flyerEntrySyncPayload(entry: FlyerEntry): string {
  return JSON.stringify({
    copy: entry.copy,
    inputs: entry.inputs,
    template: entry.template,
    theme: entry.theme,
    flyerSize: entry.flyerSize,
  });
}

function textEntrySyncPayload(entry: PromotionTextEntry): string {
  return JSON.stringify(entry.copy);
}

export type EnsureDefaultPromotionOpts = {
  propertyId: string;
  property: MockProperty;
  managerUserId: string;
  managerContact?: string;
  appOrigin?: string;
  existingRow?: ManagerPromotionRow | null;
};

export type PromotionPresetKind = "default_flyer" | "default_listing_blurb";

export const PROMOTION_PRESET_DEFS: ReadonlyArray<{
  kind: PromotionPresetKind;
  name: string;
  description: string;
}> = [
  {
    kind: "default_flyer",
    name: "Flyer from listing",
    description: "Printable flyer from your listing photos and facts (no AI).",
  },
  {
    kind: "default_listing_blurb",
    name: "Listing blurb",
    description: "Short marketing copy for email and social from listing details.",
  },
] as const;

export function missingPromotionPresets(
  propertyId: string,
  existingRow: ManagerPromotionRow | null,
): PromotionPresetKind[] {
  const pid = propertyId.trim();
  if (!pid) return [];
  const flyers = existingRow ? readFlyerEntries(existingRow) : [];
  const texts = existingRow ? readPromotionTextEntries(existingRow) : [];
  const missing: PromotionPresetKind[] = [];
  const flyerId = defaultPromotionFlyerEntryId(pid);
  const textId = defaultPromotionTextEntryId(pid);
  if (!flyers.some((e) => e.id === flyerId)) missing.push("default_flyer");
  if (!texts.some((e) => e.id === textId)) missing.push("default_listing_blurb");
  return missing;
}

/**
 * Add one listing-derived default promotion the manager chose — never runs on
 * panel open. Returns null when that preset already exists on the row.
 */
export function addDefaultPromotionPreset(
  opts: EnsureDefaultPromotionOpts & { preset: PromotionPresetKind },
): ManagerPromotionRow | null {
  const propertyId = opts.propertyId.trim();
  if (!propertyId) return null;

  const inputs = inputsFromListing(opts.property, {
    managerContact: opts.managerContact,
    appOrigin: opts.appOrigin,
  });
  const propertyLabel = buildPromotionDraftAutofill(opts.property, {
    managerContact: opts.managerContact,
    appOrigin: opts.appOrigin,
  }).propertyLabel;

  const now = new Date().toISOString();
  const flyerSeedId = defaultPromotionFlyerEntryId(propertyId);
  const textSeedId = defaultPromotionTextEntryId(propertyId);
  const existingFlyers = opts.existingRow ? readFlyerEntries(opts.existingRow) : [];
  const existingTexts = opts.existingRow ? readPromotionTextEntries(opts.existingRow) : [];

  let row =
    opts.existingRow ??
    emptyPromotionRow({
      propertyId,
      propertyLabel,
      managerUserId: opts.managerUserId,
      now,
    });

  let changed = false;

  if (opts.preset === "default_flyer" && !existingFlyers.some((e) => e.id === flyerSeedId)) {
    row = appendFlyerEntryToRow(
      row,
      buildDefaultFlyerEntry(propertyId, inputs, propertyLabel, now),
    );
    changed = true;
  }

  if (opts.preset === "default_listing_blurb" && !existingTexts.some((e) => e.id === textSeedId)) {
    row = appendTextEntryToRow(row, buildDefaultTextEntry(propertyId, inputs, propertyLabel, now));
    changed = true;
  }

  if (!changed) return null;

  return syncPromotionRowLegacy({
    ...row,
    managerUserId: opts.managerUserId,
    propertyId,
    propertyLabel,
    inputs,
    updatedAt: now,
  });
}

/**
 * Create or refresh the seeded default flyer and listing blurb from current
 * listing facts. Used by test seeds — not called on manager panel open.
 */
export function ensureDefaultPromotionAssets(opts: EnsureDefaultPromotionOpts): ManagerPromotionRow | null {
  const propertyId = opts.propertyId.trim();
  if (!propertyId) return null;

  const inputs = inputsFromListing(opts.property, {
    managerContact: opts.managerContact,
    appOrigin: opts.appOrigin,
  });
  const propertyLabel = buildPromotionDraftAutofill(opts.property, {
    managerContact: opts.managerContact,
    appOrigin: opts.appOrigin,
  }).propertyLabel;

  const now = new Date().toISOString();
  const flyerSeedId = defaultPromotionFlyerEntryId(propertyId);
  const textSeedId = defaultPromotionTextEntryId(propertyId);
  const freshFlyer = buildDefaultFlyerEntry(propertyId, inputs, propertyLabel, now);
  const freshText = buildDefaultTextEntry(propertyId, inputs, propertyLabel, now);

  const existingFlyers = opts.existingRow ? readFlyerEntries(opts.existingRow) : [];
  const existingTexts = opts.existingRow ? readPromotionTextEntries(opts.existingRow) : [];
  const currentFlyer = existingFlyers.find((e) => e.id === flyerSeedId) ?? null;
  const currentText = existingTexts.find((e) => e.id === textSeedId) ?? null;

  const needsFlyer = !currentFlyer;
  const needsText = !currentText;
  const flyerStale = currentFlyer ? flyerEntrySyncPayload(currentFlyer) !== flyerEntrySyncPayload(freshFlyer) : false;
  const textStale = currentText ? textEntrySyncPayload(currentText) !== textEntrySyncPayload(freshText) : false;

  if (!needsFlyer && !needsText && !flyerStale && !textStale) return null;

  let row =
    opts.existingRow ??
    emptyPromotionRow({
      propertyId,
      propertyLabel,
      managerUserId: opts.managerUserId,
      now,
    });

  if (needsFlyer) {
    row = appendFlyerEntryToRow(row, freshFlyer);
  } else if (flyerStale && currentFlyer) {
    row = updateFlyerEntryOnRow(row, currentFlyer.id, {
      copy: freshFlyer.copy,
      inputs: freshFlyer.inputs,
      template: freshFlyer.template,
      theme: freshFlyer.theme,
      flyerSize: freshFlyer.flyerSize,
    });
  }

  if (needsText) {
    row = appendTextEntryToRow(row, freshText);
  } else if (textStale && currentText) {
    row = updateTextEntryOnRow(row, currentText.id, { copy: freshText.copy });
  }

  return syncPromotionRowLegacy({
    ...row,
    managerUserId: opts.managerUserId,
    propertyId,
    propertyLabel,
    inputs,
    updatedAt: now,
  });
}

/** @deprecated Use {@link ensureDefaultPromotionAssets} — kept for tests/docs. */
export function syncDefaultPromotionAssets(opts: EnsureDefaultPromotionOpts): ManagerPromotionRow | null {
  return ensureDefaultPromotionAssets(opts);
}
