"use client";

import { useMemo, useState } from "react";
import { PromotionAiDraftPhotoPicker } from "@/components/portal/promotion-ai-draft-card";
import { PromotionFlyerPreview } from "@/components/portal/promotion-flyer-preview";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Input, Select, Textarea } from "@/components/ui/input";
import type { ManagerPromotionPropertyOption } from "@/lib/manager-property-links";
import { fileToFlyerImage } from "@/lib/promotion-image-upload";
import { enrichPromotionDraftFromListing } from "@/lib/promotion-listing-context";
import {
  FLYER_IMAGE_LIMIT,
  PROMOTION_TEMPLATE_DEFAULT,
  PROMOTION_TEMPLATE_OPTIONS,
  PROMOTION_THEME_OPTIONS,
  PROMOTION_TONE_OPTIONS,
  PROMOTION_SIZE_OPTIONS,
  type FlyerSize,
  type ManagerPromotionRow,
  type PromotionInputs,
  type PromotionTemplate,
  type PromotionTheme,
} from "@/lib/promotion-flyer";

export type PromotionDraft = {
  propertyKey: string;
  propertyLabel: string;
  address: string;
  title: string;
  headline: string;
  sellingPoints: string;
  customDetails: string;
  price: string;
  promo: string;
  cta: string;
  contact: string;
  schedulingUrl: string;
  includeSchedulingLink: boolean;
  theme: PromotionTheme;
  flyerSize: FlyerSize;
  template: PromotionTemplate;
  tone: string;
  /** Free-form notes for AI draft / generate — not persisted on the saved flyer row. */
  aiPrompt: string;
  /** Uploaded property photos as downscaled data URLs. */
  images: string[];
};

export const CUSTOM_PROPERTY_KEY = "__custom__";

/** Shown instead of a property name when a promotion isn't linked to a property. */
export const UNTITLED_PROMOTION_LABEL = "Untitled promotion";

export const EMPTY_DRAFT: PromotionDraft = {
  propertyKey: CUSTOM_PROPERTY_KEY,
  propertyLabel: "",
  address: "",
  title: "",
  headline: "",
  sellingPoints: "",
  customDetails: "",
  price: "",
  promo: "",
  cta: "",
  contact: "",
  schedulingUrl: "",
  includeSchedulingLink: true,
  theme: "cobalt",
  flyerSize: "letter",
  template: PROMOTION_TEMPLATE_DEFAULT,
  tone: PROMOTION_TONE_OPTIONS[0]!,
  aiPrompt: "",
  images: [],
};

export function draftInputs(draft: PromotionDraft): PromotionInputs {
  return {
    headline: draft.headline.trim(),
    sellingPoints: draft.sellingPoints.trim(),
    price: draft.price.trim(),
    promo: draft.promo.trim(),
    cta: draft.cta.trim(),
    contact: draft.contact.trim(),
    tone: draft.tone.trim(),
    address: draft.address.trim(),
    customDetails: draft.customDetails.trim(),
    schedulingUrl: draft.schedulingUrl.trim(),
    includeSchedulingLink: draft.includeSchedulingLink,
    images: draft.images.slice(0, FLYER_IMAGE_LIMIT),
  };
}

/**
 * C039 (captain, BUILD-WAVE2 §4): a render-ready row for the flyer LIVE
 * preview inside the create/edit form — not persisted. `copy: null` lets
 * {@link buildFlyerHtml} fall back to `composeFallbackFlyerCopy`, so the
 * preview updates from the typed inputs alone, with no AI round trip.
 */
export function draftToPreviewRow(draft: PromotionDraft): ManagerPromotionRow {
  const now = new Date().toISOString();
  return {
    id: "preview",
    managerUserId: null,
    propertyId: null,
    propertyLabel: draft.propertyLabel.trim(),
    title: draft.title,
    theme: draft.theme,
    flyerSize: draft.flyerSize,
    template: draft.template,
    status: "draft",
    inputs: draftInputs(draft),
    copy: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function draftWithPropertyKey(
  base: PromotionDraft,
  key: string,
  listings: ManagerPromotionPropertyOption[],
  opts?: { managerContact?: string },
): PromotionDraft {
  if (key === CUSTOM_PROPERTY_KEY) return { ...base, propertyKey: key };
  const property = listings.find((l) => l.id === key)?.property;
  if (!property) return { ...base, propertyKey: key };
  return enrichPromotionDraftFromListing({ ...base, propertyKey: key }, property, opts);
}

/**
 * Row identity for a text promotion built from a draft. The text composer has no
 * label field of its own, so `propertyLabel`/`headline` on a Custom draft can
 * only be autofill left over from a listing that was picked and then switched
 * away from — deriving the label from `propertyKey` keeps a row from naming a
 * property it has no `propertyId` for. The flyer form is not routed through
 * here: there the manager owns the "Property label (shown on flyer)" field.
 */
export function promotionTextIdentityFromDraft(draft: PromotionDraft): {
  propertyId: string | null;
  propertyLabel: string;
} {
  if (draft.propertyKey === CUSTOM_PROPERTY_KEY) {
    return { propertyId: null, propertyLabel: UNTITLED_PROMOTION_LABEL };
  }
  return {
    propertyId: draft.propertyKey,
    propertyLabel:
      draft.propertyLabel.trim() || draft.headline.trim() || UNTITLED_PROMOTION_LABEL,
  };
}

/**
 * Property / listing picker shared by the flyer builder and the promotion-text
 * composer, so both create surfaces attach a promotion to a real property
 * instead of silently saving it unattached.
 */
export function PromotionPropertyPicker({
  id,
  value,
  listings,
  onSelect,
  customLabel = "Custom (type below)",
}: {
  id?: string;
  value: string;
  listings: ManagerPromotionPropertyOption[];
  onSelect: (key: string) => void;
  customLabel?: string;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-muted" htmlFor={id}>
        Property / listing
      </label>
      <Select id={id} className="mt-1" value={value} onChange={(e) => onSelect(e.target.value)}>
        <option value={CUSTOM_PROPERTY_KEY}>{customLabel}</option>
        {listings.map((l) => (
          <option key={l.id} value={l.id}>
            {l.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Tiny abstract sketch of each template's layout so the picker reads visually
 * (photo areas = tinted blocks, text = hairlines) without rendering real flyers.
 */
function TemplateThumb({ id }: { id: PromotionTemplate }) {
  const photo = "rounded-[3px] bg-primary/50";
  const bar = "rounded-[2px] bg-foreground/60";
  const line = "rounded-[2px] bg-foreground/25";
  const frame = "flex h-16 w-full flex-col gap-1 rounded-md border border-border bg-card p-1.5";
  const circle = "rounded-full bg-primary/50";
  if (id === "showcase") {
    return (
      <div className={`${frame} flex-row items-start justify-between`} aria-hidden="true">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={`${line} h-1 w-1/2`} />
          <div className={`${bar} h-1.5 w-full`} />
          <div className={`${line} h-1 w-2/3`} />
        </div>
        <div className={`${circle} h-8 w-8 shrink-0`} />
      </div>
    );
  }
  if (id === "listing_sheet") {
    return (
      <div className={frame} aria-hidden="true">
        <div className={`${bar} mx-auto h-1.5 w-2/3`} />
        <div className="flex flex-1 gap-1">
          <div className={`${photo} h-full w-3/5`} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className={`${line} h-1.5 w-full`} />
            <div className={`${line} h-1 w-full`} />
            <div className={`${line} h-1 w-2/3`} />
          </div>
        </div>
      </div>
    );
  }
  if (id === "photo_hero") {
    return (
      <div className={frame} aria-hidden="true">
        <div className={`${photo} h-7 w-full`} />
        <div className={`${bar} h-1.5 w-3/4`} />
        <div className={`${line} h-1 w-full`} />
        <div className={`${line} h-1 w-2/3`} />
      </div>
    );
  }
  if (id === "split") {
    return (
      <div className={`${frame} flex-row`} aria-hidden="true">
        <div className={`${photo} h-full w-2/5`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={`${bar} h-1.5 w-3/4`} />
          <div className={`${line} h-1 w-full`} />
          <div className={`${line} h-1 w-5/6`} />
          <div className={`${line} h-1 w-2/3`} />
        </div>
      </div>
    );
  }
  if (id === "feature_grid") {
    return (
      <div className={frame} aria-hidden="true">
        <div className={`${bar} h-1.5 w-full`} />
        <div className={`${photo} h-4 w-full`} />
        <div className="grid flex-1 grid-cols-2 gap-1">
          <div className={`${line} h-full`} />
          <div className={`${line} h-full`} />
          <div className={`${line} h-full`} />
          <div className={`${line} h-full`} />
        </div>
      </div>
    );
  }
  if (id === "bold_banner") {
    return (
      <div className={frame} aria-hidden="true">
        <div className={`${bar} h-4 w-full`} />
        <div className={`${photo} h-3 w-full`} />
        <div className={`${line} h-1 w-full`} />
        <div className={`${bar} h-2 w-full`} />
      </div>
    );
  }
  return (
    <div className={`${frame} items-center`} aria-hidden="true">
      <div className={`${line} h-1 w-1/3`} />
      <div className={`${bar} h-1.5 w-2/3`} />
      <div className={`${photo} h-5 w-1/2`} />
      <div className={`${line} h-1 w-1/2`} />
    </div>
  );
}

export function PromotionForm({
  draft,
  setDraft,
  listings,
  onSelectProperty,
  hidePropertyPicker = false,
}: {
  draft: PromotionDraft;
  setDraft: React.Dispatch<React.SetStateAction<PromotionDraft>>;
  listings: ManagerPromotionPropertyOption[];
  onSelectProperty: (key: string) => void;
  hidePropertyPicker?: boolean;
}) {
  const { showToast } = useAppUi();
  const [readingPhotos, setReadingPhotos] = useState(false);
  const isCustom = draft.propertyKey === CUSTOM_PROPERTY_KEY;
  const selectedTemplate =
    PROMOTION_TEMPLATE_OPTIONS.find((t) => t.id === draft.template) ?? PROMOTION_TEMPLATE_OPTIONS[0]!;
  // C039: the flyer preview renders live as fields fill in, not only in a
  // separate preview step.
  const previewRow = useMemo(() => draftToPreviewRow(draft), [draft]);

  async function onPhotoFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const room = FLYER_IMAGE_LIMIT - draft.images.length;
    const files = Array.from(list).slice(0, Math.max(0, room));
    setReadingPhotos(true);
    try {
      const results = await Promise.all(files.map(fileToFlyerImage));
      const added = results.filter((src): src is string => Boolean(src));
      if (added.length) {
        setDraft((d) => ({ ...d, images: [...d.images, ...added].slice(0, FLYER_IMAGE_LIMIT) }));
      }
      if (added.length < list.length) {
        showToast(
          added.length < files.length
            ? "Some files couldn't be read as images."
            : `Up to ${FLYER_IMAGE_LIMIT} photos per flyer.`,
        );
      }
    } finally {
      setReadingPhotos(false);
    }
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2 rounded-xl border border-border bg-card p-3">
        <PromotionAiDraftPhotoPicker
          images={draft.images}
          readingPhotos={readingPhotos}
          onPhotoFiles={(files) => void onPhotoFiles(files)}
          onRemovePhoto={(i) => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}
        />
      </div>
      {hidePropertyPicker ? null : (
        <PromotionPropertyPicker
          id="promotion-flyer-property"
          value={draft.propertyKey}
          listings={listings}
          onSelect={onSelectProperty}
        />
      )}
      <div>
        <label className="text-xs font-semibold text-muted">Property label (shown on flyer)</label>
        <Input
          className="mt-1"
          value={draft.propertyLabel}
          onChange={(e) => setDraft((d) => ({ ...d, propertyLabel: e.target.value }))}
          placeholder="The Pioneer, Pioneer Square"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Address (shown on flyer)</label>
        <Input
          className="mt-1"
          value={draft.address}
          onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
          placeholder="1420 Broadway, Seattle, WA 98122"
        />
      </div>
      {isCustom && !hidePropertyPicker ? (
        <div className="sm:col-span-2">
          <label className="text-xs font-semibold text-muted">Custom property details</label>
          <Textarea
            className="mt-1"
            rows={4}
            value={draft.customDetails}
            onChange={(e) => setDraft((d) => ({ ...d, customDetails: e.target.value }))}
            placeholder={"Address, unit mix, square footage, standout features, neighborhood, or anything the flyer should highlight."}
          />
          <p className="mt-1 text-[11px] text-muted">
            Fed to the AI as facts to advertise. Used to fill in selling points when you leave them blank.
          </p>
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Flyer name</label>
        <Input
          className="mt-1"
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          placeholder="Spring leasing push"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Headline idea (optional)</label>
        <Input
          className="mt-1"
          value={draft.headline}
          onChange={(e) => setDraft((d) => ({ ...d, headline: e.target.value }))}
          placeholder="Modern living in the heart of the city"
        />
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Key selling points / amenities (one per line)</label>
        <Textarea
          className="mt-1"
          rows={4}
          value={draft.sellingPoints}
          onChange={(e) => setDraft((d) => ({ ...d, sellingPoints: e.target.value }))}
          placeholder={"In-unit laundry\nRooftop deck\nSteps from transit"}
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Price</label>
        <Input
          className="mt-1"
          value={draft.price}
          onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
          placeholder="$2,400/mo"
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Promotional offer</label>
        <Input
          className="mt-1"
          value={draft.promo}
          onChange={(e) => setDraft((d) => ({ ...d, promo: e.target.value }))}
          placeholder="First month free"
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Call to action</label>
        <Input
          className="mt-1"
          value={draft.cta}
          onChange={(e) => setDraft((d) => ({ ...d, cta: e.target.value }))}
          placeholder="Book a tour today"
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Contact</label>
        <Input
          className="mt-1"
          value={draft.contact}
          onChange={(e) => setDraft((d) => ({ ...d, contact: e.target.value }))}
          placeholder="leasing@proplane.ai · (206) 555-0142"
        />
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs font-semibold text-muted">
          <input
            type="checkbox"
            checked={draft.includeSchedulingLink}
            onChange={(e) => setDraft((d) => ({ ...d, includeSchedulingLink: e.target.checked }))}
          />
          Include scheduling link in flyer &amp; text
        </label>
        {draft.includeSchedulingLink ? (
          <Input
            className="mt-1"
            value={draft.schedulingUrl}
            onChange={(e) => setDraft((d) => ({ ...d, schedulingUrl: e.target.value }))}
            placeholder="https://…/rent/tours-contact?propertyId=…"
          />
        ) : null}
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Theme</label>
        <Select
          className="mt-1"
          value={draft.theme}
          onChange={(e) => setDraft((d) => ({ ...d, theme: e.target.value as PromotionTheme }))}
        >
          {PROMOTION_THEME_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="text-xs font-semibold text-muted">Tone</label>
        <Select
          className="mt-1"
          value={draft.tone}
          onChange={(e) => setDraft((d) => ({ ...d, tone: e.target.value }))}
        >
          {PROMOTION_TONE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Flyer size</label>
        <Select
          className="mt-1"
          value={draft.flyerSize}
          onChange={(e) => setDraft((d) => ({ ...d, flyerSize: e.target.value as FlyerSize }))}
          data-attr="promotion-flyer-size"
        >
          {PROMOTION_SIZE_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Flyer template</label>
        <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label="Flyer template">
          {PROMOTION_TEMPLATE_OPTIONS.map((t) => {
            const active = draft.template === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={active}
                title={t.description}
                onClick={() => setDraft((d) => ({ ...d, template: t.id }))}
                className={`rounded-xl border p-2 text-left outline-none transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-primary/25 ${
                  active ? "border-primary/60 ring-2 ring-primary/20" : "border-border hover:border-primary/30"
                }`}
                data-attr="promotion-template-option"
              >
                <TemplateThumb id={t.id} />
                <div className={`mt-1.5 truncate text-[11px] font-semibold ${active ? "text-primary" : "text-foreground"}`}>
                  {t.label}
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-muted">{selectedTemplate.description}</p>
      </div>
      <div className="sm:col-span-2">
        <label className="text-xs font-semibold text-muted">Preview</label>
        <div className="mt-1 flex justify-center">
          <PromotionFlyerPreview promotion={previewRow} embedded />
        </div>
      </div>
    </div>
  );
}
