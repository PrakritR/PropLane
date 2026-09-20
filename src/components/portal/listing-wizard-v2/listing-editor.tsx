"use client";

/**
 * Phase 2 of the redesigned wizard: six short, named steps that complete a
 * listing which already exists.
 *
 * Every field the old wizard asked for still has a home here. What changed is
 * WHERE it is asked and HOW OFTEN:
 *
 * - A room's money lives with that room, in one place. The old wizard split a
 *   single room's price across two steps — monthly rent on Pricing, weekly and
 *   daily rent on Rooms — so nothing on screen ever showed the full price.
 * - The two fields both labelled "Rent / day" are now named for what they do:
 *   the room's offered daily rate versus the rate used only to split a partial
 *   first or last month.
 * - House defaults mean ten near-identical rooms are typed once, not ten times.
 * - Anything a manager rarely changes sits behind "More options", so no screen
 *   exceeds roughly seven visible fields.
 *
 * The submission shape is unchanged, so drafts, validation, publishing and every
 * downstream reader keep working exactly as before.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Input, Textarea } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { OccupiedDates } from "@/components/portal/listing-wizard-v2/occupied-dates";
import { cn } from "@/lib/utils";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  normalizeListingPaymentWaiverCode,
} from "@/lib/payment-policy";
import { isProcessingCoverageCodeShape } from "@/lib/processing-coverage-codes";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { uploadListingImageFiles } from "@/lib/listing-media-client";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import { FieldMark, FoundOnlineCard } from "@/components/portal/listing-wizard-v2/found-online-card";
import { prefillMarkFor } from "@/lib/listing-prefill/apply";
import {
  leaseChargeDefaultMark,
  resolvedLeaseChargeValue,
  withoutLeaseChargeDefault,
  type LeaseChargeDefaultKey,
} from "@/lib/lease-charge-defaults";
import type { PrefillAddressInput } from "@/lib/listing-prefill/types";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { buildListingModalAssistantContext } from "@/lib/listing-assistant-context";
import { DoorOpen, Bath, Building, Building2, Home, Layers, LayoutGrid, Store, Warehouse, type LucideIcon } from "lucide-react";
import {
  BATHROOM_EXTRA_AMENITY_PRESETS,
  HOUSE_WIDE_AMENITY_PRESETS,
  LISTING_PROPERTY_TYPE_OPTIONS,
  LISTING_STORIES_OPTIONS,
  ROOM_AMENITY_PRESETS,
  SHARED_SPACE_KIND_OPTIONS,
  floorLevelSelectOptions,
  sharedSpaceAmenityPresetsForKind,
  listingAmenityLinesFromValue,
} from "@/data/manager-listing-presets";
import {
  emptyQuickFactRow,
  formatLeaseTermsBodyFromAllowed,
  resolveAllowedLeaseTerms,
  syncAirbnbLeaseTermInAllowed,
  syncShortTermLeaseTermInAllowed,
  duplicateBathroomEntry,
  duplicateRoomEntry,
  duplicateSharedSpaceEntry,
  MAX_LISTING_BATHROOMS,
  MAX_LISTING_ROOMS,
  type ManagerListingSubmissionV1,
  type ManagerBathroomRoomAccessKind,
  type ManagerBathroomSubmission,
  type ManagerRoomSubmission,
  type ManagerRoomBed,
  type ManagerSharedSpaceSubmission,
  LONG_TERM_LENGTH_CHOICES,
  normalizeLongTermLengths,
  ROOM_BED_TYPES,
  bedsLine,
  parseBedsLine,
  isRoomSlotRemovable,
} from "@/lib/manager-listing-submission";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  LEASE_TERM_CHOICES,
  SHORT_TERM_LEASE_TERM,
  sortLeaseTermsCanonical,
} from "@/lib/rental-application/lease-terms";
import {
} from "@/lib/listing-room-derived-pricing";
import { getHouseInfoValue, normalizeHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { applyListingBathroomSlots, applyListingBedroomSlots } from "@/lib/manager-listing-submission";
import { useConfirm, useOptionalAppUi } from "@/components/providers/app-ui-provider";
import {
  applyBathroomDefaults,
  BATHROOM_INHERIT_FIELDS,
  bathroomDefaultsForSubmission,
  bathroomFieldValue,
  bathroomTypeOf,
  defaultValueIsUnset,
  defaultValuesMatch,
  emptyBathroomDefaults,
  writeBathroomField,
  writeBathroomType,
  type BathroomDefaults,
  type BathroomInheritField,
  type BathroomType,
} from "@/lib/listing-record-defaults";
import {
  encodeSharedSpaceAccessPick,
  encodeSharedSpaceEveryone,
  retainSharedSpaceAccessAfterRoomsChange,
  sharedSpaceAccessMenuSelected,
  sharedSpaceAccessOptions,
  sharedSpaceAccessTriggerLabel,
} from "@/lib/listing-shared-space-access";
import { listingLeaseTypeScopeOptions } from "@/lib/listing-fee-scope";
import { LONG_TERM_LEASE_TERM as DEFAULT_QUOTE_TERM } from "@/lib/rental-application/lease-terms";
import { ListingPricingSections } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import {
  BathroomCoveragePanel,
  ListingPreviewPanel,
  PricingReceiptPanel,
  RoomPreviewPanel,
  SharedSpacesPanel,
} from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  applyHouseDefaultsToRooms,
  houseDefaultsForSubmission,
  roomInheritsDefault,
  type ListingHouseDefaults,
  type ListingHouseDefaultField,
} from "@/lib/listing-house-defaults";
import {
  AddRowButton,
  ColumnHelp,
  EditorDone,
  MoreRows,
  SameAsAllToggle,
  CardFields,
  CheckboxOption,
  Field,
  FieldRow,
  FactRow,
  AdvancedGroup,
  AdvancedPanel,
  ChoiceCard,
  CountStepper,
  KindTile,
  MultiPick,
  RecordCard,
  RowSelectCell,
  RailCover,
  RailNotice,
  RailStatus,
  SectionGroup,
  SideBelow,
  StepColumn,
  ResetAllInheritanceButton,
  StepHeading,
  StepRail,
  ListingWorkspace,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";

/**
 * Six steps, and Pricing is one of them.
 *
 * The money used to live on a step called **Advanced**, behind an accordion,
 * beside the certificate of occupancy. That is the wrong place for the thing a
 * manager opens the editor to change: rent, deposits, fees and what is collected
 * before move-in are now their own named step, where the live receipt can sit
 * beside them.
 *
 * What is left of Advanced is genuine paperwork a home has once — the building,
 * move-in logistics, local compliance — and it sits behind a disclosure at the
 * foot of Basics rather than pretending to be a stage of the work.
 */
export const LISTING_V2_STEPS = [
  { id: "basics", label: "Basics" },
  { id: "rooms", label: "Rooms" },
  { id: "bathrooms", label: "Bathrooms" },
  { id: "spaces", label: "Shared spaces" },
  { id: "pricing", label: "Pricing" },
  { id: "review", label: "Review" },
] as const;

export type ListingV2StepId = (typeof LISTING_V2_STEPS)[number]["id"];

/** A caller-owned step drawn before Basics on the rail (see `ListingEditorV2`). */
export type ListingEditorLeadingStep = {
  id: string;
  label: string;
  /** What the rail says under the label — the file name, the count found. */
  summary?: ReactNode;
  /** Steps the caller draws as needing attention, for the rail's red dot. */
  attention?: number;
  /** The manager chose it (from the rail or Back on Basics). */
  onOpen: () => void;
};

/**
 * "For listing only have title, pictures, price and description."
 * "There is too much on the listing."
 *
 * The steps a listing HAS to pass through. Basics already carries the title,
 * the photos and the description; Pricing carries the price; Review publishes.
 * Rooms, Bathrooms and Shared spaces are detail a manager adds when they want
 * to — Continue skips them, and the rail marks them optional.
 *
 * The one exception is deliberate: a home let BY THE ROOM keeps Rooms on the
 * path, because there the rooms are the product and each carries its own price.
 * That choice is the manager's own answer on Basics — never inferred from a
 * blank — which is why it, and not a room count, decides this.
 *
 * A detail step the manager has already filled in stays on the path too: work
 * they did should not disappear from Continue.
 */
export function listingV2PathStepIds(sub: ManagerListingSubmissionV1): ListingV2StepId[] {
  const byTheRoom = sub.listingPlaceCategoryId === "shared_home";
  const hasRooms = byTheRoom || (sub.rooms?.length ?? 0) > 0;
  const hasBathrooms = (sub.bathrooms ?? []).length > 0;
  const hasSpaces = (sub.sharedSpaces ?? []).length > 0;
  return LISTING_V2_STEPS.map((step) => step.id).filter((id) => {
    if (id === "rooms") return hasRooms;
    if (id === "bathrooms") return hasBathrooms;
    if (id === "spaces") return hasSpaces;
    return true;
  });
}

export function listingV2StepIndex(id: ListingV2StepId | null | undefined): number {
  if (!id) return 0;
  const index = LISTING_V2_STEPS.findIndex((step) => step.id === id);
  return index >= 0 ? index : 0;
}

/**
 * What the left rail says for a listing — cover, finish count, per-step
 * summaries and attention dots. Import and the editor both call this so the
 * Found list cannot drift from Basics.
 */
export type ListingRailChrome = {
  attention: Record<string, number>;
  summaries: {
    basics: string;
    rooms: string;
    bathrooms: string;
    spaces: string;
    pricing: string;
    review: string;
    open: number;
  };
  coverUrl: string | null;
  photoCount: number;
};

export function listingRailChrome(submission: ManagerListingSubmissionV1): ListingRailChrome {
  const rooms = submission.rooms ?? [];
  const leaseTerms = listingLeaseTypeScopeOptions(submission);
  const checks = listingReadiness(submission);
  const unresolved = (id: string) => checks.find((c) => c.id === id && c.state !== "done");
  const attention = {
    basics: [unresolved("address"), unresolved("description")].filter(Boolean).length,
    rooms: [unresolved("rooms"), unresolved("photos")].filter(Boolean).length,
    bathrooms: (submission.bathrooms ?? []).length === 0 ? 1 : 0,
    spaces: 0,
    pricing: [unresolved("terms"), unresolved("deposit")].filter(Boolean).length,
    review: 0,
  } as Record<string, number>;
  const open = checks.filter((c) => c.state !== "done").length;
  const withPhotos = rooms.filter((r) => (r.photoDataUrls ?? []).length > 0).length;
  const priced = rooms.map((r) => r.monthlyRent).filter((n) => n > 0);
  const from = priced.length > 0 ? Math.min(...priced) : 0;
  const typeLabel = LISTING_PROPERTY_TYPE_OPTIONS.find((o) => o.id === submission.listingPropertyTypeId)?.label;
  const baths = (submission.bathrooms ?? []).length;
  const spaces = (submission.sharedSpaces ?? []).length;
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return {
    attention,
    summaries: {
      basics:
        [
          submission.address.split(",")[0]!.trim(),
          submission.listingPlaceCategoryId === "entire_home" ? "Whole place" : "By the room",
          typeLabel,
        ]
          .filter(Boolean)
          .join(" · ") || "Address and type",
      rooms:
        rooms.length === 0
          ? "Add the first room"
          : `${plural(rooms.length, "room")} · ${withPhotos === rooms.length ? "all with photos" : `${withPhotos} with photos`}`,
      bathrooms: baths === 0 ? "None yet" : plural(baths, "bathroom"),
      spaces: spaces === 0 ? "None listed" : plural(spaces, "shared space"),
      pricing:
        from > 0
          ? `From $${Math.round(from).toLocaleString("en-US")} a month · ${plural(leaseTerms.length, "lease type")}`
          : "Rent not set",
      review: open === 0 ? "Ready to publish" : `${open} to finish`,
      open,
    },
    coverUrl: (submission.housePhotoDataUrls ?? [])[0] ?? rooms.flatMap((r) => r.photoDataUrls ?? [])[0] ?? null,
    photoCount:
      (submission.housePhotoDataUrls ?? []).length +
      rooms.reduce((n, r) => n + (r.photoDataUrls ?? []).length, 0) +
      (submission.bathrooms ?? []).reduce((n, b) => n + (b.photoDataUrls ?? []).length, 0),
  };
}

/** How a room reaches its bathroom. Mirrors ManagerBathroomRoomAccessKind. */
const BATHROOM_ACCESS_OPTIONS = [
  { value: "ensuite", label: "Ensuite" },
  { value: "shared", label: "Shared" },
  { value: "hall", label: "Private" },
] as const;

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

/* ─────────────────────── shared little helpers ─────────────────────── */

function money(value: string | undefined): string {
  return (value ?? "").replace(/^\$/, "");
}


/**
 * Photos for a room, bathroom or shared space.
 *
 * Images are read as data URLs and held on the submission, which is what the
 * existing wizard does; the publish path uploads them and swaps in permanent
 * URLs. Keeping the same shape means a listing edited here uploads exactly as
 * one edited in the previous wizard.
 */
function PhotoStrip({
  urls,
  onChange,
  max = 8,
  label,
  inherited = false,
}: {
  urls: string[];
  onChange: (next: string[]) => void;
  max?: number;
  label: string;
  /** Following the Default card: the tiles draw dashed, the way an inherited row does. */
  inherited?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /*
   * Photos upload as they are chosen, through the same client path the rest of
   * the product uses, so the submission carries permanent URLs rather than
   * base64. Twelve house photos held as data URLs made every draft save carry
   * the images again, and a file the browser could not read used to be dropped
   * in silence — a manager saw one fewer photo and no reason why.
   */
  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const room = Math.max(0, max - urls.length);
    if (room === 0) {
      setError(`Up to ${max} photos.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const uploaded = await uploadListingImageFiles(Array.from(files).slice(0, room));
      onChange([...urls, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That photo could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {urls.map((url, i) => (
          <span key={`${url.slice(0, 24)}-${i}`} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${label} photo ${i + 1}`}
              className={cn("h-16 w-20 rounded-lg border border-border object-cover", inherited && "border-dashed opacity-80")}
            />
            <button
              type="button"
              aria-label={`Remove ${label} photo ${i + 1}`}
              onClick={() => onChange(urls.filter((_, j) => j !== i))}
              className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-[11px] text-muted shadow-sm"
            >
              ✕
            </button>
          </span>
        ))}
        {urls.length < max ? (
          <label className="grid h-16 w-20 cursor-pointer place-items-center rounded-lg border border-dashed border-border bg-accent/20 text-[18px] text-muted">
            {busy ? <span className="text-[11px] font-bold">…</span> : "+"}
            <input
              type="file"
              accept="image/*"
              multiple
              disabled={busy}
              className="sr-only"
              aria-label={`Add ${label} photos`}
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-[12px] font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}

/**
 * One short video for a room, bathroom, shared space or the house.
 *
 * Separate from {@link PhotoStrip} because the model holds exactly one video per
 * entity, not a list — offering a gallery here would imply a second clip could
 * be added and then silently drop it.
 */
function VideoSlot({
  url,
  onChange,
  label,
  inherited = false,
}: {
  url: string | null | undefined;
  onChange: (next: string | null) => void;
  label: string;
  inherited?: boolean;
}) {
  const read = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result ?? "") || null);
    reader.readAsDataURL(file);
  };
  return (
    <div>
      {/*
       * The same tile a photo uses. A pill button beside a grid of squares read
       * as a different kind of control, when adding a clip is the same act as
       * adding a picture.
       */}
      <div className="flex flex-wrap gap-2">
        {url ? (
          <span className="relative">
            <video src={url} className={cn("h-16 w-20 rounded-lg border border-border object-cover", inherited && "border-dashed opacity-80")} />
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label={`Remove ${label} video`}
              className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-[11px] text-muted shadow-sm"
            >
              ✕
            </button>
          </span>
        ) : (
          <label className="grid h-16 w-20 cursor-pointer place-items-center rounded-lg border border-dashed border-border bg-accent/20 text-[18px] text-muted">
            +
            <input
              type="file"
              accept="video/*"
              className="sr-only"
              aria-label={`Add ${label} video`}
              onChange={(e) => {
                read(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── step 1 · basics ─────────────────────────── */

/**
 * The six shapes a manager recognises their own property in.
 *
 * Worded as things rather than categories — "A house", not "Single-family
 * residential" — because a manager is matching a picture in their head, not
 * classifying an asset. The ids are the listing's own property-type ids.
 */
const PROPERTY_KIND_TILES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "house", label: "A house", icon: Home },
  { id: "townhouse", label: "A townhouse", icon: Layers },
  { id: "condo", label: "A condo", icon: Building2 },
  { id: "duplex", label: "A small building", icon: Warehouse },
  { id: "apartment", label: "An apartment", icon: Building },
  { id: "other", label: "Something else", icon: Store },
];

/** `listingTotalBathroomsId` is an id from LISTING_TOTAL_BATH_OPTIONS; the stepper counts in halves and "4+" is its top. */
function bathCountFromId(id: string | undefined): number {
  if (!id) return 1;
  if (id === "4+") return 4.5;
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function bathIdFromCount(n: number): string {
  if (n >= 4.5) return "4+";
  return String(n);
}

/** Amenity presets are `{ id, label }`; the stored value is newline-separated labels, custom lines kept. */
function AmenityPick({
  label,
  presets,
  value,
  onChange,
  inherited,
  dataAttr,
}: {
  label: string;
  presets: readonly { id: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  inherited?: boolean;
  dataAttr?: string;
}) {
  const lines = listingAmenityLinesFromValue(value);
  const labels = presets.map((p) => p.label);
  return (
    <MultiPick
      label={label}
      options={labels}
      selected={lines}
      inherited={inherited}
      dataAttr={dataAttr}
      onChange={(next) => {
        const picked = new Set(next);
        // Presets in catalogue order, custom lines after — the stored shape AmenityChips kept.
        onChange([...labels.filter((l) => picked.has(l)), ...next.filter((l) => !labels.includes(l))].join("\n"));
      }}
    />
  );
}

function StepBasics({
  sub,
  patch,
  lead,
  onHouseDefaults,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  lead?: ReactNode;
  onHouseDefaults: (next: ListingHouseDefaults) => void;
}) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const roomCount = sub.rooms?.length || sub.listingBedroomSlots || 1;
  const setRentModel = (id: "shared_home" | "entire_home") => patch({ listingPlaceCategoryId: id, rentalModelStamp: id });
  const setBedrooms = (next: number) => {
    const prevIds = (sub.rooms ?? []).map((room) => room.id);
    const applied = applyListingBedroomSlots({ ...sub, listingBedroomSlots: next }, next);
    // A refusal means the count could not be honoured; keep the rooms the
    // manager has rather than writing a number they do not match.
    if (!applied.ok) {
      patch({ listingBedroomSlots: next });
      return;
    }
    const nextIds = (applied.sub.rooms ?? []).map((room) => room.id);
    patch({
      ...applied.sub,
      listingBedroomSlots: next,
      sharedSpaces: (applied.sub.sharedSpaces ?? sub.sharedSpaces ?? []).map((space) => ({
        ...space,
        roomAccessIds: retainSharedSpaceAccessAfterRoomsChange(space.roomAccessIds, prevIds, nextIds),
      })),
    });
  };
  /**
   * The bathroom count makes the bathroom cards, the way the bedroom count
   * makes the rooms: 2.5 opens the Bathrooms step with two full baths and a
   * half. A card this creates copies the Default bathroom. Lowering the count
   * removes untouched cards from the end and, as with bedrooms, keeps the cards
   * and moves only the number when the last card has been filled in.
   */
  const setBathrooms = (next: number) => {
    const id = bathIdFromCount(next);
    const before = sub.bathrooms?.length ?? 0;
    const applied = applyListingBathroomSlots({ ...sub, listingTotalBathroomsId: id }, next);
    if (!applied.ok) {
      patch({ listingTotalBathroomsId: id });
      return;
    }
    // Only what the manager SET on the Default bathroom reaches a new card —
    // never a type guessed from the cards that exist, and never a type at all
    // on the card the half adds, which is a half bath by definition.
    const stored: BathroomDefaults = { ...emptyBathroomDefaults(), ...(sub.bathroomDefaults ?? {}) };
    const halfIndex = next % 1 !== 0 ? applied.sub.bathrooms.length - 1 : -1;
    const bathrooms = applied.sub.bathrooms.map((bath, i) => (i >= before ? applyBathroomDefaults(bath, i === halfIndex ? { ...stored, type: "" } : stored) : bath));
    patch({ ...applied.sub, bathrooms, listingTotalBathroomsId: id });
  };
  const stories = Number(sub.listingStoriesId) || 1;
  // The address the manager PICKED from the dropdown — what the lookup keys on.
  // A hand-typed street never triggers it.
  const [lookup, setLookup] = useState<PrefillAddressInput | null>(null);
  const mark = (key: keyof ManagerListingSubmissionV1) => <FieldMark kind={prefillMarkFor(sub, key)} />;
  return (
    <StepColumn>
      <StepHeading title="The home itself" />
      {/* A caller's way in ahead of the first question — Create's "Start from a file" strip. */}
      {lead}

      {/*
       * What it is and how it is let come FIRST: the type is the picture in the
       * manager's head, and by-the-room versus whole-place changes every screen
       * after it — whether rent is per room or set once, and whether Rooms is
       * about bedrooms or about one household.
       */}
      <SectionGroup first>
        <Field label="Property type" required group labelAside={mark("listingPropertyTypeId")}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {PROPERTY_KIND_TILES.map((k) => (
              <KindTile
                key={k.id}
                icon={k.icon}
                label={k.label}
                selected={sub.listingPropertyTypeId === k.id}
                dataAttr={`listing-v2-kind-${k.id}`}
                onSelect={() => patch({ listingPropertyTypeId: k.id })}
              />
            ))}
          </div>
        </Field>
        <Field label="How you rent it" required group>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <ChoiceCard selected={rentByRoom} title="By the room" dataAttr="listing-v2-rent-model-shared" onSelect={() => setRentModel("shared_home")} />
            <ChoiceCard selected={!rentByRoom} title="The whole place" dataAttr="listing-v2-rent-model-entire" onSelect={() => setRentModel("entire_home")} />
          </div>
        </Field>
        <div className="rounded-2xl border border-border bg-card">
          <FactRow first required label={<>{rentByRoom ? "Bedrooms to rent" : "Bedrooms"} {mark("listingBedroomSlots")}</>}>
            <CountStepper compact value={roomCount} min={1} max={20} onChange={setBedrooms} label="bedrooms" dataAttr="listing-v2-bedrooms" />
          </FactRow>
          <FactRow required label={<>Bathrooms {mark("listingTotalBathroomsId")}</>}>
            <CountStepper
              compact
              value={bathCountFromId(sub.listingTotalBathroomsId)}
              min={1}
              max={4.5}
              step={0.5}
              onChange={setBathrooms}
              label="bathrooms"
              dataAttr="listing-v2-bathrooms"
            />
          </FactRow>
          <FactRow required label={<>Floors {mark("listingStoriesId")}</>}>
            <CountStepper
              compact
              value={stories}
              min={1}
              max={LISTING_STORIES_OPTIONS.length}
              onChange={(n) => patch({ listingStoriesId: String(n) })}
              label="floors"
              dataAttr="listing-v2-floors"
            />
          </FactRow>
          <FactRow label={<>Home size {mark("houseSizeSqft")}</>}>
            <span className="flex items-center gap-1.5">
              <Input
                inputMode="numeric"
                value={sub.houseSizeSqft ?? ""}
                placeholder="1,450"
                aria-label="Home size in square feet"
                data-attr="listing-v2-home-size"
                className="w-24 text-right"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                  patch({ houseSizeSqft: n > 0 ? n : undefined });
                }}
              />
              <span className="whitespace-nowrap text-[13px] font-semibold text-foreground/70">sq ft</span>
            </span>
          </FactRow>
          <FactRow label={<>Built {mark("yearBuilt")}</>}>
            <Input
              inputMode="numeric"
              value={sub.yearBuilt ?? ""}
              placeholder="1962"
              aria-label="Year built"
              data-attr="listing-v2-year-built"
              className="w-20 text-right"
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^0-9]/g, "").slice(0, 4));
                patch({ yearBuilt: n > 0 ? n : undefined });
              }}
            />
          </FactRow>
          {rentByRoom ? null : (
            <FactRow required label="Residents">
              <CountStepper
                compact
                value={sub.entireHomeMaxResidents ?? Math.max(1, roomCount)}
                min={1}
                max={30}
                onChange={(n) => patch({ entireHomeMaxResidents: n })}
                label="residents"
                dataAttr="listing-v2-residents"
              />
            </FactRow>
          )}
        </div>
      </SectionGroup>

      <SectionGroup title="Where it is">
        <Field label="Street address" required>
          <ListingAddressAutocomplete
            value={sub.address}
            placeholder="142 Ash St"
            onChange={(next) => patch({ address: next })}
            onSelect={(suggestion) => {
              const picked = {
                address: suggestion.address || suggestion.label,
                city: suggestion.city || sub.city,
                state: suggestion.state || sub.state,
                zip: suggestion.zip || sub.zip,
              };
              patch({ ...picked, neighborhood: suggestion.neighborhood || sub.neighborhood });
              setLookup(picked);
            }}
          />
        </Field>
        <FoundOnlineCard sub={sub} patch={patch} lookup={lookup} onHouseDefaults={onHouseDefaults} />
        <FieldRow cols={4}>
          <Field label="City" required>
            <Input value={sub.city} onChange={(e) => patch({ city: e.target.value })} />
          </Field>
          <Field label="State" required>
            <Input value={sub.state} onChange={(e) => patch({ state: e.target.value })} />
          </Field>
          <Field label="ZIP" required>
            <Input value={sub.zip} onChange={(e) => patch({ zip: e.target.value })} />
          </Field>
          <Field label="Neighborhood">
            <Input value={sub.neighborhood} onChange={(e) => patch({ neighborhood: e.target.value })} />
          </Field>
        </FieldRow>
        {/* One name for the home. A separate headline asked the same question twice; the tagline stays in the model for listings that already have one. */}
        <Field label="Property name">
          <Input value={sub.buildingName} placeholder={sub.address || "Magnolia House"} onChange={(e) => patch({ buildingName: e.target.value })} />
        </Field>
        <Field label="Description" labelAside={mark("houseOverview")}>
          <Textarea rows={4} value={sub.houseOverview} onChange={(e) => patch({ houseOverview: e.target.value })} placeholder="Describe the home and who it suits…" />
        </Field>
      </SectionGroup>

      <SectionGroup title="Photos and video">
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Photos">
            <PhotoStrip label="house" max={12} urls={sub.housePhotoDataUrls ?? []} onChange={(next) => patch({ housePhotoDataUrls: next })} />
          </Field>
          <Field label="Video">
            <VideoSlot label="house" url={sub.houseVideoDataUrl} onChange={(next) => patch({ houseVideoDataUrl: next })} />
          </Field>
        </div>
      </SectionGroup>

      <SectionGroup title="Amenities and pets">
        <div className="rounded-2xl border border-border bg-card">
          <FactRow first label={<>Amenities {mark("amenitiesText")}</>}>
            <AmenityPick label="Amenities" presets={HOUSE_WIDE_AMENITY_PRESETS} value={sub.amenitiesText} onChange={(next) => patch({ amenitiesText: next })} dataAttr="listing-v2-house-amenities" />
          </FactRow>
          <FactRow label={<>Pets {mark("petFriendly")}</>}>
            <RowSelectCell
              ariaLabel="Pets"
              value={sub.petFriendly ? "yes" : "no"}
              options={[
                { value: "no", label: "No pets" },
                { value: "yes", label: "Pets allowed, subject to approval" },
              ]}
              onChange={(v) => patch({ petFriendly: v === "yes" })}
            />
          </FactRow>
        </div>
      </SectionGroup>
    </StepColumn>
  );
}

/* ─────────────────────────── step 2 · rooms ─────────────────────────── */

/**
 * Which rate fields a room shows, decided by the lease types the LISTING offers.
 *
 * A room let long-term has exactly one rate: a monthly one. Showing an empty
 * "rent / night" beside it invites a manager to fill in a number that nothing
 * will ever bill, because the application flow refuses a type the listing does
 * not offer. So a rate appears only once the type that uses it does.
 *
 * The weekly rate is the one exception: it is a display convenience on a
 * monthly let, so it is a switch the manager flips rather than a locked field.
 */
export function roomRateVisibility(sub: ManagerListingSubmissionV1) {
  const allowed = resolveAllowedLeaseTerms(sub);
  const longTerm = allowed.includes(LONG_TERM_LEASE_TERM);
  const custom = allowed.includes(CUSTOM_LEASE_TERM);
  const monthToMonth = allowed.includes("Month-to-Month");
  return {
    longTerm,
    custom,
    monthToMonth,
    /** Long-term, custom and month-to-month all quote one monthly figure. */
    monthly: longTerm || custom || monthToMonth,
    /** Only a term that can start mid-month needs a partial month split. */
    prorate: longTerm || custom,
    shortTerm: Boolean(sub.shortTermRentalsAllowed),
    /**
     * Airbnb has NO pricing here at all. The stay is booked and paid for on
     * Airbnb, so PropLane raises no rent charge for it — the lease type exists
     * only so that resident is tracked through the listing like any other. A
     * nightly box beside it would collect a number nothing reads.
     */
    airbnb: Boolean(sub.airbnbRentalsAllowed),
    nightly: Boolean(sub.shortTermRentalsAllowed),
    shortStayCharges: Boolean(sub.shortTermRentalsAllowed),
  };
}

/** What a furnished room usually comes with. Stored inside the free-text `furnishing` line. */
const FURNISHING_ITEMS = [
  "Bed",
  "Desk",
  "Chair",
  "Dresser",
  "Wardrobe",
  "Nightstand",
  "Bookshelf",
  "Mirror",
  "Lamp",
  "Rug",
] as const;

/**
 * Furnishing is one stored line: empty means unfurnished, anything else means
 * furnished and lists what is included. "Furnished" alone is the sentinel for a
 * room the manager marked furnished before naming a single item — an empty
 * line would snap it straight back to Unfurnished.
 */
const FURNISHED_SENTINEL = "Furnished";
function furnishingItems(value: string): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter((p) => p && p.toLowerCase() !== FURNISHED_SENTINEL.toLowerCase());
}
function furnishingLine(items: readonly string[]): string {
  return items.length > 0 ? items.join(", ") : FURNISHED_SENTINEL;
}
function isFurnished(value: string): boolean {
  return (value ?? "").trim().length > 0;
}
function furnishingSummary(value: string): string {
  if (!isFurnished(value)) return "Unfurnished";
  const n = furnishingItems(value).length;
  return n === 0 ? "Furnished" : `Furnished · ${n} ${n === 1 ? "item" : "items"}`;
}

const FURNISHING_OPTIONS = [
  { value: "unfurnished", label: "Unfurnished" },
  { value: "furnished", label: "Furnished" },
] as const;

/** The fields a room card and the Default room card both know how to mark. */
type RoomInheritField = Extract<
  ListingHouseDefaultField,
  | "floor"
  | "bedsLine"
  | "occupancyCapacity"
  | "furnishing"
  | "roomAmenitiesText"
  | "sizeSqft"
  | "moveInInspectionRequired"
  | "moveOutInspectionRequired"
  | "photoDataUrls"
  | "videoDataUrl"
  | "detail"
  | "moveInInstructions"
  | "moveInPhotoDataUrls"
  | "moveInVideoDataUrl"
>;

const ROOM_INHERIT_FIELDS: readonly RoomInheritField[] = [
  "floor",
  "bedsLine",
  "occupancyCapacity",
  "furnishing",
  "roomAmenitiesText",
  "sizeSqft",
  "moveInInspectionRequired",
  "moveOutInspectionRequired",
  "photoDataUrls",
  "videoDataUrl",
  "detail",
  "moveInInstructions",
  "moveInPhotoDataUrls",
  "moveInVideoDataUrl",
];

/** The pictures and clips — the fields "Make all the same" asks about before it replaces them. */
const ROOM_MEDIA_FIELDS: readonly RoomInheritField[] = ["photoDataUrls", "videoDataUrl", "moveInPhotoDataUrls", "moveInVideoDataUrl"];

/** Which tracked field a key on the room record belongs to, so a hand edit marks the right one. */
const ROOM_INHERIT_FIELD_BY_KEY: Partial<Record<keyof ManagerRoomSubmission, RoomInheritField>> = {
  floor: "floor",
  beds: "bedsLine",
  bedCount: "bedsLine",
  occupancyCapacity: "occupancyCapacity",
  furnishing: "furnishing",
  roomAmenitiesText: "roomAmenitiesText",
  sizeSqft: "sizeSqft",
  moveInInspectionRequired: "moveInInspectionRequired",
  moveOutInspectionRequired: "moveOutInspectionRequired",
  photoDataUrls: "photoDataUrls",
  videoDataUrl: "videoDataUrl",
  detail: "detail",
  moveInInstructions: "moveInInstructions",
  moveInPhotoDataUrls: "moveInPhotoDataUrls",
  moveInVideoDataUrl: "moveInVideoDataUrl",
};

/**
 * Forget a room's own value for one field, so the Default room's value (blank
 * included) can take its place. `applyHouseDefaultsToRooms` leaves a room alone
 * when the default is unset; a Reset must still clear what the room had.
 */
function clearRoomField(room: ManagerRoomSubmission, field: RoomInheritField): ManagerRoomSubmission {
  switch (field) {
    case "floor":
      return { ...room, floor: "" };
    case "bedsLine":
      return { ...room, beds: undefined, bedCount: undefined };
    case "occupancyCapacity":
      return { ...room, occupancyCapacity: undefined };
    case "furnishing":
      return { ...room, furnishing: "" };
    case "roomAmenitiesText":
      return { ...room, roomAmenitiesText: "" };
    case "sizeSqft":
      return { ...room, sizeSqft: undefined };
    case "moveInInspectionRequired":
      return { ...room, moveInInspectionRequired: false };
    case "moveOutInspectionRequired":
      return { ...room, moveOutInspectionRequired: false };
    case "photoDataUrls":
      return { ...room, photoDataUrls: [] };
    case "videoDataUrl":
      return { ...room, videoDataUrl: null };
    case "detail":
      return { ...room, detail: "" };
    case "moveInInstructions":
      return { ...room, moveInInstructions: "" };
    case "moveInPhotoDataUrls":
      return { ...room, moveInPhotoDataUrls: [] };
    case "moveInVideoDataUrl":
      return { ...room, moveInVideoDataUrl: null };
  }
}

/** 1–8 residents per room; the same range on the "Every room" card and each room. */
const OCCUPANCY_MAX = 8;

/**
 * The bed list under Furnishing: one row per bed type, a type to pick and a
 * count to nudge. It only exists while the room is furnished.
 */
function BedsRows({
  beds,
  inherited,
  onChange,
  who,
}: {
  beds: ManagerRoomBed[];
  inherited: boolean;
  onChange: (next: ManagerRoomBed[]) => void;
  who: string;
}) {
  const rows = beds.length > 0 ? beds : [{ type: "Full", count: 1 }];
  const typeOptions = (current: string) =>
    [...ROOM_BED_TYPES.map((t) => ({ value: t, label: t })), ...(ROOM_BED_TYPES.includes(current as (typeof ROOM_BED_TYPES)[number]) ? [] : [{ value: current, label: current }])];
  return (
    <>
      {rows.map((bed, i) => (
        <FactRow key={i} sub label={i === 0 ? "Beds" : ""}>
          <span className="flex items-center gap-2">
            <RowSelectCell
              ariaLabel={`Bed ${i + 1} type for ${who}`}
              value={bed.type}
              options={typeOptions(bed.type)}
              inherited={inherited}
              className="w-[112px]"
              onChange={(v) => onChange(rows.map((b, j) => (j === i ? { ...b, type: v } : b)))}
            />
            <CountStepper compact inherited={inherited} value={bed.count} min={1} max={6} label={`${bed.type} beds for ${who}`} onChange={(n) => onChange(rows.map((b, j) => (j === i ? { ...b, count: n } : b)))} />
            {rows.length > 1 ? (
              <button type="button" aria-label={`Remove ${bed.type} from ${who}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-foreground/[0.06] hover:text-foreground">
                ✕
              </button>
            ) : null}
          </span>
        </FactRow>
      ))}
      <div className="bg-foreground/[0.025] px-7 pb-2.5">
        <button
          type="button"
          data-attr="listing-v2-bed-add"
          onClick={() => {
            const used = rows.map((b) => b.type);
            const next = ROOM_BED_TYPES.find((t) => !used.includes(t)) ?? "Twin";
            onChange([...rows, { type: next, count: 1 }]);
          }}
          className="text-[12.5px] font-bold text-primary hover:underline"
        >
          + Add another bed type
        </button>
      </div>
    </>
  );
}

const ROOM_HELP = {
  all: "Set once. Every room ticked “Same as default room” copies this. Change one field on a room and only that field becomes its own; untick a room and the whole card does.",
  people: "How many residents can rent this room, each on their own lease. Not the number of beds.",
  bathroom: "The bathroom this room uses, and whether it is private (ensuite) or shared. Add bathrooms on the Bathrooms step first.",
  rent: "Set per room in Pricing. Shown here so every room’s price is in one place.",
} as const;

/** The ● Reset tag a field label wears when its value is the record's own — the same mark FactRow draws. */
function CellResetTag({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-attr="listing-v2-cell-reset"
      aria-label={label}
      title="Back to the Default card"
      className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-bold text-[var(--status-approved-fg)] hover:underline"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
      Reset
    </button>
  );
}

/**
 * The square-footage box.
 *
 * It keeps its own text while it has focus and commits on blur, so a manager
 * can clear a room's number without it snapping straight back to the Default
 * room's, and typing replaces the inherited figure instead of landing in
 * front of it. Focus selects the number for the same reason. Empty on blur
 * means "same as the Default room"; the placeholder is a dash, never a number
 * that could read as the size.
 */
function SizeInput({ who, value, inherited, onCommit }: { who: string; value: number; inherited: boolean; onCommit: (n: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value > 0 ? String(value) : "");
  return (
    <span className="relative inline-block w-[118px]">
      <input
        inputMode="numeric"
        aria-label={`Size of ${who}`}
        placeholder="—"
        value={shown}
        onFocus={(e) => {
          setDraft(shown);
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => {
          const n = Number(draft ?? shown) || 0;
          setDraft(null);
          onCommit(n > 0 ? n : null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className={cn(
          "min-h-[36px] w-full rounded-lg border bg-card pl-2.5 pr-12 text-right text-[13.5px] font-semibold tabular-nums text-foreground outline-none focus:border-primary",
          inherited && draft === null ? "border-dashed border-border text-muted" : "border-border",
        )}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[12px] text-muted">sq ft</span>
    </span>
  );
}

/**
 * The rows a room card unfolds. `room` null is the "All rooms" card: the same
 * rows, applied to every room that still follows it.
 *
 * The important questions come first — residents, bathroom, floor — and
 * everything else sits behind one More ▾. An open room card ends in Done.
 */
function RoomCardBody({
  room,
  propertyId = null,
  who,
  defaults,
  wholePlace,
  bathrooms,
  access,
  onAccess,
  onGoToBathrooms,
  onRoom,
  onDefault,
  onResetField,
  onGoToPricing,
  onDone,
  storiesId,
  isOwn,
}: {
  room: ManagerRoomSubmission | null;
  /** The listing's record id, for the room's booked rows. */
  propertyId?: string | null;
  who: string;
  defaults: ListingHouseDefaults;
  wholePlace: boolean;
  bathrooms: number;
  /** The room's access kind (or, for the defaults card, what every room gets). */
  access: string;
  onAccess: (kind: string) => void;
  onGoToBathrooms: () => void;
  onRoom: (patch: Partial<ManagerRoomSubmission>) => void;
  onDefault: <K extends ListingHouseDefaultField>(field: K, value: ListingHouseDefaults[K]) => void;
  onResetField: (field: RoomInheritField) => void;
  onGoToPricing: () => void;
  onDone?: () => void;
  storiesId: string | undefined;
  /** The step's per-field answer to "is this the room's own" — it remembers hand edits the values alone cannot show. */
  isOwn?: (field: RoomInheritField) => boolean;
}) {
  const own = (field: RoomInheritField) => Boolean(room) && (isOwn ? isOwn(field) : !roomInheritsDefault(room!, defaults, field));
  const inherits = (field: RoomInheritField) => Boolean(room) && !own(field);
  /** The ● Reset tag beside a label whose value is the room's own — the same one FactRow draws. */
  const resetTag = (field: RoomInheritField, what: string) => (own(field) ? <CellResetTag onClick={() => onResetField(field)} label={`Reset ${what} for ${who} to the Default room`} /> : null);
  const photos = room ? room.photoDataUrls ?? [] : defaults.photoDataUrls;
  const video = room ? room.videoDataUrl : defaults.videoDataUrl;
  const detail = room ? room.detail ?? "" : defaults.detail;
  const moveInInstructions = room ? room.moveInInstructions ?? "" : defaults.moveInInstructions;
  const entryPhotos = room ? room.moveInPhotoDataUrls ?? [] : defaults.moveInPhotoDataUrls;
  const arrivalClip = room ? room.moveInVideoDataUrl : defaults.moveInVideoDataUrl;
  const inheritedText = (field: RoomInheritField) => (inherits(field) ? "border-dashed text-muted" : undefined);
  const beds: ManagerRoomBed[] = room ? room.beds ?? parseBedsLine(defaults.bedsLine) : parseBedsLine(defaults.bedsLine);
  const residents = room ? room.occupancyCapacity ?? defaults.occupancyCapacity : defaults.occupancyCapacity;
  const furnishing = room ? room.furnishing || defaults.furnishing : defaults.furnishing;
  const amenities = room ? room.roomAmenitiesText || defaults.roomAmenitiesText : defaults.roomAmenitiesText;
  const size = room ? room.sizeSqft ?? defaults.sizeSqft : defaults.sizeSqft;
  const floorOptions = floorLevelSelectOptions(storiesId, room?.floor ?? defaults.floor).map((l) => ({ value: l, label: l }));
  const writeFurnishing = (next: string) => (room ? onRoom({ furnishing: next }) : onDefault("furnishing", next));
  const writeBeds = (next: ManagerRoomBed[]) => {
    if (room) onRoom({ beds: next, bedCount: next.reduce((n, b) => n + b.count, 0) });
    else onDefault("bedsLine", bedsLine(next));
  };
  const reset = (field: RoomInheritField) => (own(field) ? () => onResetField(field) : undefined);
  const help = (title: string, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      {title}
      <ColumnHelp title={title} text={text} />
    </span>
  );

  return (
    <>
      {wholePlace ? null : (
        <FactRow first label={help("Residents per room", ROOM_HELP.people)} own={own("occupancyCapacity")} onReset={reset("occupancyCapacity")} resetLabel={`Reset residents for ${who} to the Default room`}>
          <CountStepper
            compact
            inherited={inherits("occupancyCapacity")}
            value={residents}
            min={1}
            max={OCCUPANCY_MAX}
            label={`Residents per room for ${who}`}
            onChange={(n) => (room ? onRoom({ occupancyCapacity: n }) : onDefault("occupancyCapacity", n))}
          />
        </FactRow>
      )}
      {wholePlace ? null : bathrooms === 0 ? (
        <FactRow label={help("Bathroom", ROOM_HELP.bathroom)}>
          <button type="button" onClick={onGoToBathrooms} data-attr="listing-v2-add-bathroom-first" className="text-[13.5px] font-bold text-primary hover:underline">
            Add a bathroom first →
          </button>
        </FactRow>
      ) : (
        <FactRow label={help("Bathroom", ROOM_HELP.bathroom)}>
          <RowSelectCell ariaLabel={`Bathroom access for ${who}`} value={access} options={BATHROOM_ACCESS_OPTIONS} placeholder="Select…" onChange={onAccess} />
        </FactRow>
      )}
      <FactRow first={wholePlace} label="Floor" own={own("floor")} onReset={reset("floor")} resetLabel={`Reset floor for ${who} to the Default room`}>
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={room ? room.floor : defaults.floor} options={floorOptions} placeholder="Floor…" inherited={inherits("floor")} onChange={(v) => (room ? onRoom({ floor: v }) : onDefault("floor", v))} />
      </FactRow>

      <MoreRows dataAttr={room ? "listing-v2-room-more" : "listing-v2-defaults-more"}>
        <FactRow label="Furnishing" own={own("furnishing")} onReset={reset("furnishing")} resetLabel={`Reset furnishing for ${who} to the Default room`}>
          <RowSelectCell
            ariaLabel={`Furnishing for ${who}`}
            value={isFurnished(furnishing) ? "furnished" : "unfurnished"}
            options={FURNISHING_OPTIONS}
            inherited={inherits("furnishing")}
            onChange={(v) => writeFurnishing(v === "furnished" ? furnishingLine(furnishingItems(furnishing)) : "")}
          />
        </FactRow>
        {isFurnished(furnishing) ? (
          <>
            <BedsRows beds={beds} inherited={inherits("bedsLine")} onChange={writeBeds} who={who} />
            <FactRow sub label="Included">
              <MultiPick
                label={`Included in ${who}`}
                options={FURNISHING_ITEMS}
                selected={furnishingItems(furnishing)}
                inherited={inherits("furnishing")}
                emptyLabel="Choose…"
                onChange={(next) => writeFurnishing(furnishingLine(next))}
              />
            </FactRow>
          </>
        ) : null}
        <FactRow label="Room amenities" own={own("roomAmenitiesText")} onReset={reset("roomAmenitiesText")} resetLabel={`Reset amenities for ${who} to the Default room`}>
          <AmenityPick label={`Room amenities for ${who}`} presets={ROOM_AMENITY_PRESETS} value={amenities} inherited={inherits("roomAmenitiesText")} onChange={(next) => (room ? onRoom({ roomAmenitiesText: next }) : onDefault("roomAmenitiesText", next))} />
        </FactRow>
        <FactRow label="Size" own={own("sizeSqft")} onReset={reset("sizeSqft")} resetLabel={`Reset size for ${who} to the Default room`}>
          <SizeInput
            who={who}
            value={size}
            inherited={inherits("sizeSqft")}
            onCommit={(n) => {
              if (!room) onDefault("sizeSqft", n ?? 0);
              else if (n) onRoom({ sizeSqft: n });
              else onResetField("sizeSqft");
            }}
          />
        </FactRow>

        <CardFields cols={2}>
          <Field label="Photos" labelAside={resetTag("photoDataUrls", "photos")}>
            <PhotoStrip label={room ? "room" : "every room"} urls={photos} inherited={inherits("photoDataUrls")} onChange={(next) => (room ? onRoom({ photoDataUrls: next }) : onDefault("photoDataUrls", next))} />
          </Field>
          <Field label="Video" labelAside={resetTag("videoDataUrl", "video")}>
            <VideoSlot label={room ? "room" : "every room"} url={video} inherited={inherits("videoDataUrl")} onChange={(next) => (room ? onRoom({ videoDataUrl: next }) : onDefault("videoDataUrl", next))} />
          </Field>
        </CardFields>
        <CardFields>
          <Field label="Description" labelAside={resetTag("detail", "description")}>
            <Textarea
              rows={3}
              value={detail}
              placeholder={room ? "What a renter should know about this room" : "What a renter should know about every room"}
              className={inheritedText("detail")}
              onChange={(e) => (room ? onRoom({ detail: e.target.value }) : onDefault("detail", e.target.value))}
            />
          </Field>
        </CardFields>
        {room ? <OccupiedDates room={room} propertyId={propertyId} onRoom={onRoom} /> : null}

        <div className="grid grid-cols-2 gap-x-4 border-t border-border px-3.5 pb-1 pt-2">
          <div className="flex items-center gap-2">
            <CheckboxOption
              label="Move-in checklist required"
              checked={room ? Boolean(room.moveInInspectionRequired) : defaults.moveInInspectionRequired}
              onChange={(next) => (room ? onRoom({ moveInInspectionRequired: next }) : onDefault("moveInInspectionRequired", next))}
            />
            {resetTag("moveInInspectionRequired", "move-in checklist")}
          </div>
          <div className="flex items-center gap-2">
            <CheckboxOption
              label="Move-out checklist required"
              checked={room ? Boolean(room.moveOutInspectionRequired) : defaults.moveOutInspectionRequired}
              onChange={(next) => (room ? onRoom({ moveOutInspectionRequired: next }) : onDefault("moveOutInspectionRequired", next))}
            />
            {resetTag("moveOutInspectionRequired", "move-out checklist")}
          </div>
        </div>

        <CardFields>
          <Field label="Move-in instructions" labelAside={resetTag("moveInInstructions", "move-in instructions")}>
            <Textarea
              rows={2}
              value={moveInInstructions}
              placeholder="Which key opens it, where to park"
              className={inheritedText("moveInInstructions")}
              onChange={(e) => (room ? onRoom({ moveInInstructions: e.target.value }) : onDefault("moveInInstructions", e.target.value))}
            />
          </Field>
        </CardFields>
        <CardFields cols={2}>
          <Field label="Entry photos" labelAside={resetTag("moveInPhotoDataUrls", "entry photos")}>
            <PhotoStrip label="entry" urls={entryPhotos} inherited={inherits("moveInPhotoDataUrls")} onChange={(next) => (room ? onRoom({ moveInPhotoDataUrls: next }) : onDefault("moveInPhotoDataUrls", next))} />
          </Field>
          <Field label="Arrival clip" labelAside={resetTag("moveInVideoDataUrl", "arrival clip")}>
            <VideoSlot label="arrival" url={arrivalClip} inherited={inherits("moveInVideoDataUrl")} onChange={(next) => (room ? onRoom({ moveInVideoDataUrl: next }) : onDefault("moveInVideoDataUrl", next))} />
          </Field>
        </CardFields>

        {room && !wholePlace ? (
          <FactRow label={help("Rent", ROOM_HELP.rent)}>
            <button type="button" onClick={onGoToPricing} data-attr="listing-v2-room-set-in-pricing" className="text-[13.5px] font-bold text-primary hover:underline">
              Set in Pricing →
            </button>
          </FactRow>
        ) : null}
      </MoreRows>

      {room && onDone ? <EditorDone onClick={onDone} dataAttr="listing-v2-room-done" /> : null}
    </>
  );
}


function StepRooms({
  sub,
  propertyId = null,
  patch,
  defaults,
  setDefaults,
  onGoToPricing,
  onGoToBathrooms,
}: {
  sub: ManagerListingSubmissionV1;
  propertyId?: string | null;
  patch: Patch;
  defaults: ListingHouseDefaults;
  setDefaults: (next: ListingHouseDefaults) => void;
  onGoToPricing: () => void;
  onGoToBathrooms: () => void;
}) {
  /** Which card is open: a room id, "defaults", or nothing. */
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Which FIELDS the manager has set by hand on which room, this session.
   *
   * Value comparison alone is not enough to answer "is this the room's own":
   * while a house default is blank, every room reads as following it, so a
   * room given its own size before the top card was filled in would be swept
   * up the first time the top card changed. This remembers the act — per
   * field, not per room. A room on its own floor still follows the Default
   * room for its size, amenities and checklists; only the field that was
   * touched comes unlinked. The Bathrooms and Shared spaces steps keep the
   * same rule.
   */
  const own = useOwnFields();
  /** Rooms whose "Same as default room" was unticked on purpose: their own on every field until re-ticked. */
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const confirm = useConfirm();
  const ui = useOptionalAppUi();
  const rooms = sub.rooms ?? [];
  const baths = sub.bathrooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const noun = wholePlace ? "bedroom" : "room";

  const writeRooms = (next: ManagerRoomSubmission[]) => {
    const prevIds = rooms.map((room) => room.id);
    const nextIds = next.map((room) => room.id);
    const idSetChanged =
      prevIds.length !== nextIds.length ||
      prevIds.some((id) => !nextIds.includes(id)) ||
      nextIds.some((id) => !prevIds.includes(id));
    if (!idSetChanged) {
      patch({ rooms: next });
      return;
    }
    patch({
      rooms: next,
      sharedSpaces: (sub.sharedSpaces ?? []).map((space) => ({
        ...space,
        roomAccessIds: retainSharedSpaceAccessAfterRoomsChange(space.roomAccessIds, prevIds, nextIds),
      })),
    });
  };
  /** A hand edit: whichever tracked fields the patch names become this room's own. Name, photos of the room's own, dates mark nothing. */
  const writeRoom = (id: string, roomPatch: Partial<ManagerRoomSubmission>) => {
    for (const key of Object.keys(roomPatch) as (keyof ManagerRoomSubmission)[]) {
      const field = ROOM_INHERIT_FIELD_BY_KEY[key];
      if (field) own.mark(id, field);
    }
    writeRooms(rooms.map((r) => (r.id === id ? { ...r, ...roomPatch } : r)));
  };
  const isOwn = (room: ManagerRoomSubmission, field: RoomInheritField) => own.has(room.id, field) || !roomInheritsDefault(room, defaults, field);
  /** The rooms a change to ONE default field may move: not unticked, and not their own on that field, judged against the default as it was. */
  const followersOf = (field: ListingHouseDefaultField, against: ListingHouseDefaults) =>
    rooms.filter((room) => !unticked.has(room.id) && !own.has(room.id, field) && roomInheritsDefault(room, against, field)).map((room) => room.id);

  function editDefault<K extends ListingHouseDefaultField>(field: K, value: ListingHouseDefaults[K]) {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    // Followers are judged against the PREVIOUS default — see
    // applyHouseDefaultsToRooms. Judging against the new one freezes every room.
    // The Default room is saved with the listing, so it is there on reopen.
    patch({ rooms: applyHouseDefaultsToRooms(rooms, next, { onlyFields: [field], roomIds: followersOf(field, previous) }), houseDefaults: next });
  }
  /** Copy the Default room into these rooms for every tracked field, blanks included. */
  const copyDefaultsInto = (ids: readonly string[]) => {
    const scope = new Set(ids);
    return rooms.map((room) =>
      scope.has(room.id)
        ? applyHouseDefaultsToRooms([ROOM_INHERIT_FIELDS.reduce(clearRoomField, room)], defaults, { onlyFields: ROOM_INHERIT_FIELDS, roomIds: [room.id] })[0]!
        : room,
    );
  };
  /** Put one field back on the house: forget the hand edit and take the Default room's value, blank included. */
  const resetField = (id: string, field: RoomInheritField) => {
    own.clear(id, field);
    writeRooms(rooms.map((r) => (r.id === id ? applyHouseDefaultsToRooms([clearRoomField(r, field)], defaults, { onlyFields: [field], roomIds: [id] })[0]! : r)));
  };

  /** The checkbox: no field is the room's own, its bathroom access was not set by hand, and it was not unticked. */
  const sameAsAll = (room: ManagerRoomSubmission) =>
    !unticked.has(room.id) && !own.has(room.id, "access") && ROOM_INHERIT_FIELDS.every((field) => !isOwn(room, field));
  /**
   * Tick: copy the Default room into every field. Untick: nothing moves —
   * what the room shows right now becomes its own, stored on the room, so a
   * later change to the card cannot reach it through a blank.
   */
  const setSameAsAll = (room: ManagerRoomSubmission, same: boolean) => {
    setUnticked((prev) => {
      const out = new Set(prev);
      if (same) out.delete(room.id);
      else out.add(room.id);
      return out;
    });
    if (same) {
      own.clearRecord(room.id);
      writeRooms(copyDefaultsInto([room.id]));
    } else {
      writeRooms(applyHouseDefaultsToRooms(rooms, defaults, { onlyFields: ROOM_INHERIT_FIELDS, roomIds: [room.id] }));
    }
  };
  const roomsHaveOverrides = rooms.some((room) => !sameAsAll(room));
  const resetAllRooms = async () => {
    if (rooms.length === 0) return;
    // Facts were always safe to overwrite; pictures were not inheritable until
    // now, so a room's own photos get one question before they go.
    const withOwnMedia = rooms.filter((room) => ROOM_MEDIA_FIELDS.some((field) => isOwn(room, field)));
    if (withOwnMedia.length > 0) {
      const names = withOwnMedia.map((room, i) => room.name.trim() || `Room ${rooms.indexOf(room) + 1 || i + 1}`).join(", ");
      const ok = await confirm({
        title: "Replace their photos too?",
        description: `${names} ${withOwnMedia.length === 1 ? "has" : "have"} photos or clips of ${withOwnMedia.length === 1 ? "its" : "their"} own. Making all the same replaces them with the Default ${noun}'s.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    own.resetAll();
    setUnticked(new Set());
    writeRooms(copyDefaultsInto(rooms.map((room) => room.id)));
  };

  /* Bathroom access lives on the BATHROOM (`assignedRoomIds`), shown from the room's side. */
  const withRoomAttached = (roomId: string): ManagerBathroomSubmission[] => {
    if (baths.length === 0) return baths;
    if (baths.some((b) => (b.assignedRoomIds ?? []).includes(roomId))) return baths;
    return baths.map((b, idx) => (idx === 0 ? { ...b, assignedRoomIds: [...(b.assignedRoomIds ?? []), roomId] } : b));
  };
  const accessForRoom = (roomId: string): string =>
    baths.find((b) => (b.assignedRoomIds ?? []).includes(roomId))?.accessKindByRoomId?.[roomId] ?? "";
  const setAccessForRoom = (roomId: string, kind: string) => {
    const next = BATHROOM_ACCESS_OPTIONS.some((o) => o.value === kind) ? (kind as ManagerBathroomRoomAccessKind) : undefined;
    own.mark(roomId, "access");
    patch({
      bathrooms: withRoomAttached(roomId).map((b) =>
        (b.assignedRoomIds ?? []).includes(roomId) ? { ...b, accessKindByRoomId: { ...(b.accessKindByRoomId ?? {}), [roomId]: next } } : b,
      ),
    });
  };
  const setAccessForAllRooms = (kind: string) => {
    const next = BATHROOM_ACCESS_OPTIONS.some((o) => o.value === kind) ? (kind as ManagerBathroomRoomAccessKind) : undefined;
    if (baths.length === 0) return;
    const ids = rooms.filter((room) => !unticked.has(room.id) && !own.has(room.id, "access")).map((room) => room.id);
    if (ids.length === 0) return;
    patch({
      bathrooms: baths.map((b, idx) => {
        const assigned = idx === 0 ? Array.from(new Set([...(b.assignedRoomIds ?? []), ...ids])) : b.assignedRoomIds ?? [];
        const kinds = { ...(b.accessKindByRoomId ?? {}) };
        for (const id of assigned) if (ids.includes(id)) kinds[id] = next;
        return { ...b, assignedRoomIds: assigned, accessKindByRoomId: kinds };
      }),
    });
  };
  const accessLabel = (kind: string) => BATHROOM_ACCESS_OPTIONS.find((o) => o.value === kind)?.label;

  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));

  const summaryFor = (room: ManagerRoomSubmission) => {
    const residents = room.occupancyCapacity ?? defaults.occupancyCapacity;
    const furnishing = room.furnishing || defaults.furnishing;
    const beds = room.beds ?? parseBedsLine(defaults.bedsLine);
    const bedText = isFurnished(furnishing) && beds.length > 0 ? bedsLine(beds).toLowerCase() : "";
    const parts = wholePlace
      ? [room.floor || defaults.floor || "Floor not set", furnishingSummary(furnishing), bedText]
      : [
          `${residents} ${residents === 1 ? "resident" : "residents"}`,
          room.floor || defaults.floor || "Floor not set",
          accessLabel(accessForRoom(room.id))?.toLowerCase() ? `${accessLabel(accessForRoom(room.id))!.toLowerCase()} bath` : "",
          furnishingSummary(furnishing),
          bedText,
        ];
    return parts.filter(Boolean).join(" · ");
  };

  return (
    <StepColumn>
      <StepHeading
        title={`${rooms.length} ${rooms.length === 1 ? noun : `${noun}s`}`}
        action={
          rooms.length > 0 ? (
            <ResetAllInheritanceButton label="Make all the same" dataAttr="listing-v2-rooms-reset-all" disabled={!roomsHaveOverrides} onClick={() => void resetAllRooms()} />
          ) : null
        }
      />

      {/* Default room — the defaults, in a room's clothes. Its important rows are always visible. */}
      <RecordCard
        every
        title={`Default ${noun}`}
        help={ROOM_HELP.all}
        dataAttr="listing-v2-defaults-card"
        rows={
          <div data-attr="listing-v2-defaults-editor">
            <RoomCardBody
              room={null}
              who="every room"
              defaults={defaults}
              wholePlace={wholePlace}
              bathrooms={baths.length}
              access={rooms[0] ? accessForRoom(rooms[0].id) : ""}
              onAccess={setAccessForAllRooms}
              onGoToBathrooms={onGoToBathrooms}
              onRoom={() => {}}
              onDefault={editDefault}
              onResetField={() => {}}
              onGoToPricing={onGoToPricing}
              storiesId={sub.listingStoriesId}
            />
          </div>
        }
      />

      {rooms.map((room, i) => {
        const isOpen = open === room.id;
        const label = room.name.trim() || `${wholePlace ? "Bedroom" : "Room"} ${i + 1}`;
        return (
          <RecordCard
            key={room.id}
            name={room.name}
            nameLabel={`Name for room ${i + 1}`}
            namePlaceholder={`${wholePlace ? "Bedroom" : "Room"} ${i + 1}`}
            onName={(v) => writeRoom(room.id, { name: v })}
            same={<SameAsAllToggle same={sameAsAll(room)} noun={noun} onChange={(next) => setSameAsAll(room, next)} onReset={() => setSameAsAll(room, true)} dataAttr="listing-v2-room-same-as-all" />}
            onDuplicate={() => {
              if (rooms.length >= MAX_LISTING_ROOMS) {
                ui?.showToast("Maximum 20 rooms.");
                return;
              }
              const copy = duplicateRoomEntry(room);
              const idx = rooms.findIndex((r) => r.id === room.id);
              writeRooms([...rooms.slice(0, idx + 1), copy, ...rooms.slice(idx + 1)]);
              setOpen(copy.id);
            }}
            onRemove={rooms.length > 1 && isRoomSlotRemovable(room) ? () => { writeRooms(rooms.filter((r) => r.id !== room.id)); if (open === room.id) setOpen(null); } : undefined}
            removeLabel={`Remove ${label}`}
            summary={summaryFor(room)}
            open={isOpen}
            onToggle={() => toggle(room.id)}
            toggleLabel={label}
            dataAttr="listing-v2-room-card"
          >
            <div data-attr="listing-v2-room-editor">
              <RoomCardBody
                room={room}
                propertyId={propertyId}
                who={label}
                defaults={defaults}
                wholePlace={wholePlace}
                bathrooms={baths.length}
                access={accessForRoom(room.id)}
                onAccess={(v) => setAccessForRoom(room.id, v)}
                onGoToBathrooms={onGoToBathrooms}
                onRoom={(p) => writeRoom(room.id, p)}
                onDefault={editDefault}
                onResetField={(f) => resetField(room.id, f)}
                onGoToPricing={onGoToPricing}
                onDone={() => setOpen(null)}
                storiesId={sub.listingStoriesId}
                isOwn={(f) => isOwn(room, f)}
              />
            </div>
          </RecordCard>
        );
      })}

      <AddRowButton
        label={wholePlace ? "Add bedroom" : "Add room"}
        icon={DoorOpen}
        dataAttr="listing-v2-add-room"
        onClick={() => {
          const base = rooms[0];
          const id = `room-${Date.now()}`;
          const blank = base ? { ...base, id, name: "", photoDataUrls: [], videoDataUrl: null } : ({ id, name: "" } as ManagerRoomSubmission);
          writeRooms([...rooms, applyHouseDefaultsToRooms([blank], defaults)[0]!]);
          setOpen(id);
        }}
      />
    </StepColumn>
  );
}


/* ─────────────────────────── step 3 · spaces ─────────────────────────── */

/* ────────────── bathrooms + shared spaces · the same cards ────────────── */

/**
 * Both steps are the Rooms cards in different clothes: an "Every …" card that
 * holds the defaults with its rows always visible, one card per record that
 * unfolds in place, and a dashed ADD row. Grey dashed = following the top
 * card, ink with Reset = the record's own, per field.
 *
 * Follow/own is decided the way the rooms cards decide it: a field is the
 * record's own once the manager has edited it by hand (remembered per field,
 * so a later top-card change never sweeps it up), or when its stored value
 * already differs from the top card (a listing saved before the top card
 * existed). The defaults themselves are a session convenience, never stored.
 */
type OwnFields = Record<string, Set<string>>;
function useOwnFields() {
  const [own, setOwn] = useState<OwnFields>({});
  const mark = (id: string, field: string) =>
    setOwn((prev) => {
      const next = new Set(prev[id] ?? []);
      next.add(field);
      return { ...prev, [id]: next };
    });
  const clear = (id: string, field: string) =>
    setOwn((prev) => {
      const next = new Set(prev[id] ?? []);
      next.delete(field);
      return { ...prev, [id]: next };
    });
  const has = (id: string, field: string) => own[id]?.has(field) ?? false;
  const clearRecord = (id: string) =>
    setOwn((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  const resetAll = () => setOwn({});
  return { mark, clear, clearRecord, has, resetAll };
}

/* ── bathrooms ── */

/** Full, three-quarter (shower, no tub), half (toilet and sink), quarter (toilet only). */
const BATHROOM_TYPE_OPTIONS: readonly { value: BathroomType; label: string }[] = [
  { value: "full", label: "Full bath" },
  { value: "shower", label: "Three-quarter bath" },
  { value: "half", label: "Half bath" },
  { value: "quarter", label: "Quarter bath" },
];

const BATHROOM_HELP = {
  all: "Set once. Every bathroom ticked “Same as default bathroom” copies this. Change one field on a bathroom and only that field becomes its own; untick one and the whole card does.",
  type: "Full = tub and shower. Three-quarter = shower, no tub. Half = toilet and sink. Quarter = toilet only.",
} as const;

function BathroomCardBody({
  bath,
  who,
  rooms,
  wholePlace,
  storiesId,
  isOwn,
  onField,
  onReset,
  onChange,
  onDone,
}: {
  bath: ManagerBathroomSubmission;
  who: string;
  rooms: readonly ManagerRoomSubmission[];
  wholePlace: boolean;
  storiesId: string | undefined;
  isOwn: (field: BathroomInheritField) => boolean;
  onField: (field: BathroomInheritField, value: string) => void;
  onReset: (field: BathroomInheritField) => void;
  onChange: (patch: Partial<ManagerBathroomSubmission>) => void;
  onDone: () => void;
}) {
  const floors = floorLevelSelectOptions(storiesId, bath.location ?? "").map((l) => ({ value: l, label: l }));
  const assigned = bath.assignedRoomIds ?? [];
  const resetTag = (field: BathroomInheritField, what: string) => (isOwn(field) ? <CellResetTag onClick={() => onReset(field)} label={`Reset ${what} for ${who} to the Default bathroom`} /> : null);
  return (
    <>
      <FactRow first label="Floor" own={isOwn("location")} onReset={() => onReset("location")} resetLabel={`Reset floor for ${who} to every bathroom`}>
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={bath.location ?? ""} options={floors} placeholder="Floor…" inherited={!isOwn("location")} onChange={(v) => onField("location", v)} />
      </FactRow>
      <FactRow label={<span className="inline-flex items-center gap-1.5">Type <ColumnHelp title="Type" text={BATHROOM_HELP.type} /></span>} own={isOwn("type")} onReset={() => onReset("type")} resetLabel={`Reset type of ${who} to every bathroom`}>
        <RowSelectCell ariaLabel={`Type of ${who}`} value={bathroomTypeOf(bath)} options={BATHROOM_TYPE_OPTIONS} inherited={!isOwn("type")} onChange={(v) => onField("type", v)} />
      </FactRow>
      <FactRow label="Finishes" own={isOwn("amenitiesText")} onReset={() => onReset("amenitiesText")} resetLabel={`Reset finishes for ${who} to every bathroom`}>
        <AmenityPick label={`Finishes for ${who}`} presets={BATHROOM_EXTRA_AMENITY_PRESETS} value={bath.amenitiesText ?? ""} inherited={!isOwn("amenitiesText")} onChange={(next) => onField("amenitiesText", next)} />
      </FactRow>
      {wholePlace || rooms.length === 0 ? null : (
        <FactRow label="Who uses it">
          <CheckboxMultiSelect
            hideLabel
            label={`Who uses ${who}`}
            dataAttr="listing-v2-bath-who-uses"
            variant="cell"
            className="min-w-[150px] max-w-[220px]"
            options={rooms.map((room, i) => ({
              value: room.id,
              label: room.name.trim() || `Room ${i + 1}`,
            }))}
            selected={bath.allResidents ? rooms.map((room) => room.id) : assigned}
            selectionTriggerLabel={
              bath.allResidents
                ? "Every room"
                : assigned.length === 0
                  ? "No rooms yet"
                  : assigned
                      .map((id) => {
                        const index = rooms.findIndex((room) => room.id === id);
                        const room = index >= 0 ? rooms[index] : null;
                        return room?.name.trim() || (index >= 0 ? `Room ${index + 1}` : id);
                      })
                      .join(", ")
            }
            emptyLabel="No rooms yet"
            onChange={(next) => {
              const kinds = { ...(bath.accessKindByRoomId ?? {}) };
              for (const id of Object.keys(kinds)) if (!next.includes(id)) delete kinds[id];
              onChange({
                assignedRoomIds: next,
                allResidents: next.length > 0 && next.length === rooms.length,
                accessKindByRoomId: kinds,
              });
            }}
          />
        </FactRow>
      )}
      <MoreRows dataAttr="listing-v2-bath-more">
        <CardFields>
          <Field label="Description" labelAside={resetTag("detail", "description")}>
            <Textarea rows={2} value={bath.detail ?? ""} placeholder="What a renter should know about this bathroom" className={isOwn("detail") ? undefined : "border-dashed text-muted"} onChange={(e) => onChange({ detail: e.target.value })} />
          </Field>
        </CardFields>
        <CardFields cols={2}>
          <Field label="Photos" labelAside={resetTag("photoDataUrls", "photos")}>
            <PhotoStrip label="bathroom" urls={bath.photoDataUrls ?? []} inherited={!isOwn("photoDataUrls")} onChange={(next) => onChange({ photoDataUrls: next })} />
          </Field>
          <Field label="Video" labelAside={resetTag("videoDataUrl", "video")}>
            <VideoSlot label="bathroom" url={bath.videoDataUrl} inherited={!isOwn("videoDataUrl")} onChange={(next) => onChange({ videoDataUrl: next })} />
          </Field>
        </CardFields>
      </MoreRows>
      <EditorDone onClick={onDone} dataAttr="listing-v2-bath-done" />
    </>
  );
}

function StepBathrooms({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [open, setOpen] = useState<string | null>(null);
  /** The Default bathroom is saved with the listing, so it is there on reopen; an older listing infers it from its bathrooms. */
  const defaults = bathroomDefaultsForSubmission(sub);
  const own = useOwnFields();
  const confirm = useConfirm();
  const ui = useOptionalAppUi();
  const baths = sub.bathrooms ?? [];
  const rooms = sub.rooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const floors = floorLevelSelectOptions(sub.listingStoriesId, "").map((l) => ({ value: l, label: l }));

  /**
   * A field is the bathroom's own once the manager edited it by hand
   * (remembered per field, so a later top-card change never sweeps it up), or
   * when its stored value already differs from the top card — a listing saved
   * before the top card existed. Type always has a value, so it is never own
   * merely for being set.
   */
  const isOwn = (bath: ManagerBathroomSubmission, field: BathroomInheritField) => {
    if (own.has(bath.id, field)) return true;
    const value = bathroomFieldValue(bath, field);
    const def = defaults[field];
    // A blank is showing the top card, whatever the top card says.
    if (defaultValueIsUnset(value)) return false;
    if (defaultValueIsUnset(def)) return field !== "type";
    return !defaultValuesMatch(value, def);
  };
  const writeBath = (id: string, next: ManagerBathroomSubmission) => patch({ bathrooms: baths.map((b) => (b.id === id ? next : b)) });
  const setField = (bath: ManagerBathroomSubmission, field: BathroomInheritField, value: string) => {
    own.mark(bath.id, field);
    writeBath(bath.id, writeBathroomField(bath, field, value));
  };
  /** A patch from the card body: whichever tracked fields it names become the bathroom's own. */
  const patchBath = (bath: ManagerBathroomSubmission, p: Partial<ManagerBathroomSubmission>) => {
    for (const key of Object.keys(p)) if ((BATHROOM_INHERIT_FIELDS as readonly string[]).includes(key)) own.mark(bath.id, key);
    writeBath(bath.id, { ...bath, ...p });
  };
  const resetField = (bath: ManagerBathroomSubmission, field: BathroomInheritField) => {
    own.clear(bath.id, field);
    writeBath(bath.id, writeBathroomField(bath, field, defaults[field]));
  };
  const copyDefaultsInto = (bath: ManagerBathroomSubmission) => {
    let next = bath;
    for (const field of BATHROOM_INHERIT_FIELDS) next = writeBathroomField(next, field, defaults[field]);
    return next;
  };
  /** Bathrooms the manager unticked ("Same as default bathroom") without changing a value yet. */
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const sameAsAll = (bath: ManagerBathroomSubmission) => !unticked.has(bath.id) && !BATHROOM_INHERIT_FIELDS.some((field) => isOwn(bath, field));
  const setSameAsAll = (bath: ManagerBathroomSubmission, same: boolean) => {
    setUnticked((prev) => {
      const out = new Set(prev);
      if (same) out.delete(bath.id);
      else out.add(bath.id);
      return out;
    });
    if (same) {
      own.clearRecord(bath.id);
      writeBath(bath.id, copyDefaultsInto(bath));
      return;
    }
    // Untick moves nothing: what the card shows becomes the bathroom's own, stored on it.
    let next = bath;
    for (const field of BATHROOM_INHERIT_FIELDS) if (!defaultValueIsUnset(defaults[field])) next = writeBathroomField(next, field, defaults[field]);
    if (next !== bath) writeBath(bath.id, next);
  };
  const bathroomsHaveOverrides = baths.some((bath) => !sameAsAll(bath));
  const resetAllBathrooms = async () => {
    if (baths.length === 0) return;
    const withOwnMedia = baths.filter((bath) => isOwn(bath, "photoDataUrls") || isOwn(bath, "videoDataUrl"));
    if (withOwnMedia.length > 0) {
      const names = withOwnMedia.map((bath) => bath.name.trim() || `Bathroom ${baths.indexOf(bath) + 1}`).join(", ");
      const ok = await confirm({
        title: "Replace their photos too?",
        description: `${names} ${withOwnMedia.length === 1 ? "has" : "have"} photos or a clip of ${withOwnMedia.length === 1 ? "its" : "their"} own. Making all the same replaces them with the Default bathroom's.`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    own.resetAll();
    setUnticked(new Set());
    patch({ bathrooms: baths.map(copyDefaultsInto) });
  };
  function editDefault<K extends BathroomInheritField>(field: K, value: BathroomDefaults[K]) {
    // Followers are judged against the PREVIOUS default, then moved with it.
    const followers = baths.filter((b) => !isOwn(b, field) && !unticked.has(b.id));
    const next: BathroomDefaults = { ...defaults, [field]: value };
    patch({ bathrooms: baths.map((b) => (followers.includes(b) ? writeBathroomField(b, field, value) : b)), bathroomDefaults: next });
  }
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
  const typeLabel = (bath: ManagerBathroomSubmission) => BATHROOM_TYPE_OPTIONS.find((o) => o.value === bathroomTypeOf(bath))?.label ?? "";
  const summaryFor = (bath: ManagerBathroomSubmission) => {
    const using = bath.allResidents
      ? ["Every room"]
      : rooms.filter((r) => (bath.assignedRoomIds ?? []).includes(r.id)).map((r, i) => r.name.trim() || `Room ${i + 1}`);
    return [bath.location || defaults.location || "Floor not set", typeLabel(bath), wholePlace ? "" : using.length ? using.join(" & ") : "No rooms yet"].filter(Boolean).join(" · ");
  };

  return (
    <StepColumn>
      <StepHeading
        title={`${baths.length} ${baths.length === 1 ? "bathroom" : "bathrooms"}`}
        action={
          baths.length > 0 ? (
            <ResetAllInheritanceButton label="Make all the same" dataAttr="listing-v2-bathrooms-reset-all" disabled={!bathroomsHaveOverrides} onClick={() => void resetAllBathrooms()} />
          ) : null
        }
      />

      {/* Default bathroom — the same card shape as the Default room: important rows on top, one More with words and pictures. */}
      <RecordCard
        every
        title="Default bathroom"
        help={BATHROOM_HELP.all}
        dataAttr="listing-v2-bath-defaults-card"
        rows={
          <div data-attr="listing-v2-bath-defaults-editor">
            <FactRow first label="Floor">
              <RowSelectCell ariaLabel="Floor for every bathroom" value={defaults.location} options={floors} placeholder="Floor…" onChange={(v) => editDefault("location", v)} />
            </FactRow>
            <FactRow label={<span className="inline-flex items-center gap-1.5">Type <ColumnHelp title="Type" text={BATHROOM_HELP.type} /></span>}>
              <RowSelectCell ariaLabel="Type of every bathroom" value={defaults.type} options={BATHROOM_TYPE_OPTIONS} placeholder="Type…" onChange={(v) => editDefault("type", v as BathroomType)} />
            </FactRow>
            <FactRow label="Finishes">
              <AmenityPick label="Finishes for every bathroom" presets={BATHROOM_EXTRA_AMENITY_PRESETS} value={defaults.amenitiesText} onChange={(next) => editDefault("amenitiesText", next)} />
            </FactRow>
            <MoreRows dataAttr="listing-v2-bath-defaults-more">
              <CardFields>
                <Field label="Description">
                  <Textarea rows={2} value={defaults.detail} placeholder="What a renter should know about every bathroom" onChange={(e) => editDefault("detail", e.target.value)} />
                </Field>
              </CardFields>
              <CardFields cols={2}>
                <Field label="Photos">
                  <PhotoStrip label="every bathroom" urls={defaults.photoDataUrls} onChange={(next) => editDefault("photoDataUrls", next)} />
                </Field>
                <Field label="Video">
                  <VideoSlot label="every bathroom" url={defaults.videoDataUrl} onChange={(next) => editDefault("videoDataUrl", next)} />
                </Field>
              </CardFields>
            </MoreRows>
          </div>
        }
      />

      {baths.map((bath, i) => {
        const isOpen = open === bath.id;
        const label = bath.name.trim() || `Bathroom ${i + 1}`;
        return (
          <RecordCard
            key={bath.id}
            name={bath.name}
            nameLabel={`Name for bathroom ${i + 1}`}
            namePlaceholder={`Bathroom ${i + 1}`}
            onName={(v) => writeBath(bath.id, { ...bath, name: v })}
            same={<SameAsAllToggle same={sameAsAll(bath)} noun="bathroom" onChange={(next) => setSameAsAll(bath, next)} onReset={() => setSameAsAll(bath, true)} dataAttr="listing-v2-bath-same-as-all" />}
            onDuplicate={() => {
              if (baths.length >= MAX_LISTING_BATHROOMS) {
                ui?.showToast("Maximum 12 bathrooms.");
                return;
              }
              const copy = duplicateBathroomEntry(bath);
              const idx = baths.findIndex((b) => b.id === bath.id);
              patch({ bathrooms: [...baths.slice(0, idx + 1), copy, ...baths.slice(idx + 1)] });
              setOpen(copy.id);
            }}
            onRemove={() => {
              patch({ bathrooms: baths.filter((b) => b.id !== bath.id) });
              if (open === bath.id) setOpen(null);
            }}
            removeLabel={`Remove ${label}`}
            summary={summaryFor(bath)}
            open={isOpen}
            onToggle={() => toggle(bath.id)}
            toggleLabel={label}
            dataAttr="listing-v2-bath-card"
          >
            <div data-attr="listing-v2-bath-editor">
              <BathroomCardBody
                bath={bath}
                who={label}
                rooms={rooms}
                wholePlace={wholePlace}
                storiesId={sub.listingStoriesId}
                isOwn={(f) => isOwn(bath, f)}
                onField={(f, v) => setField(bath, f, v)}
                onReset={(f) => resetField(bath, f)}
                onChange={(p) => patchBath(bath, p)}
                onDone={() => setOpen(null)}
              />
            </div>
          </RecordCard>
        );
      })}

      <AddRowButton
        label="Add bathroom"
        icon={Bath}
        dataAttr="listing-v2-add-bath"
        onClick={() => {
          if (baths.length >= MAX_LISTING_BATHROOMS) {
            ui?.showToast("Maximum 12 bathrooms.");
            return;
          }
          const base = baths[0];
          const id = `bath-${Date.now()}`;
          const blank = base
            ? { ...base, id, name: "", photoDataUrls: [], videoDataUrl: null, assignedRoomIds: [], accessKindByRoomId: {}, detail: "" }
            : writeBathroomType({ id, name: "" } as ManagerBathroomSubmission, "full");
          patch({ bathrooms: [...baths, applyBathroomDefaults(blank, defaults)] });
          setOpen(id);
        }}
      />
    </StepColumn>
  );
}

/* ── shared spaces ── */

const SPACE_HELP = {
  who: "Every room, unless this space is only for some of them.",
} as const;

/**
 * A shared space is its own record: there is no Default card for shared spaces
 * and nothing for a space to follow or reset to. Rooms and Bathrooms keep theirs.
 */
function SharedSpaceCardBody({
  space,
  who,
  rooms,
  wholePlace,
  storiesId,
  onChange,
  onDone,
}: {
  space: ManagerSharedSpaceSubmission;
  who: string;
  rooms: readonly ManagerRoomSubmission[];
  wholePlace: boolean;
  storiesId: string | undefined;
  onChange: (patch: Partial<ManagerSharedSpaceSubmission>) => void;
  onDone: () => void;
}) {
  const kinds = SHARED_SPACE_KIND_OPTIONS.map((o) => ({ value: o.id, label: o.label }));
  const roomLabel = (r: ManagerRoomSubmission, i: number) => r.name.trim() || `Room ${i + 1}`;
  const roomIds = rooms.map((room) => room.id);
  return (
    <>
      <FactRow first label="Type">
        <RowSelectCell ariaLabel={`Type of ${who}`} value={space.spaceKind ?? ""} options={kinds} placeholder="Type…" onChange={(v) => onChange({ spaceKind: v as ManagerSharedSpaceSubmission["spaceKind"] })} />
      </FactRow>
      <FactRow label="Floor">
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={space.location ?? ""} options={floorLevelSelectOptions(storiesId, space.location).map((l) => ({ value: l, label: l }))} placeholder="Floor…" onChange={(v) => onChange({ location: v })} />
      </FactRow>
      {wholePlace || rooms.length === 0 ? null : (
        <FactRow label={<span className="inline-flex items-center gap-1.5">Who may use it <ColumnHelp title="Who may use it" text={SPACE_HELP.who} /></span>}>
          <CheckboxMultiSelect
            hideLabel
            label={`Who may use ${who}`}
            dataAttr="listing-v2-space-who"
            variant="cell"
            className="min-w-[150px] max-w-[220px]"
            options={sharedSpaceAccessOptions(rooms.map((room, i) => ({ id: room.id, name: roomLabel(room, i) })))}
            selected={sharedSpaceAccessMenuSelected(space.roomAccessIds, roomIds)}
            selectionTriggerLabel={sharedSpaceAccessTriggerLabel(space.roomAccessIds, roomIds)}
            emptyLabel="Everyone"
            onChange={(next) =>
              onChange({
                roomAccessIds: encodeSharedSpaceAccessPick({
                  nextSelected: next,
                  roomIds,
                  previousAccessIds: space.roomAccessIds,
                }),
              })
            }
          />
        </FactRow>
      )}
      <MoreRows dataAttr="listing-v2-space-more">
        <FactRow label="What is in it">
          <AmenityPick label={`What is in ${who}`} presets={sharedSpaceAmenityPresetsForKind(space.spaceKind)} value={space.amenitiesText ?? ""} onChange={(next) => onChange({ amenitiesText: next })} />
        </FactRow>
        <FactRow label="Size">
          <SizeInput
            who={who}
            value={space.sizeSqft ?? 0}
            inherited={false}
            onCommit={(n) => onChange({ sizeSqft: n ?? undefined })}
          />
        </FactRow>
        <CardFields>
          <Field label="Description">
            <Textarea rows={2} value={space.detail ?? ""} onChange={(e) => onChange({ detail: e.target.value })} placeholder="Sunny room off the kitchen, seats six" />
          </Field>
        </CardFields>
        <CardFields cols={2}>
          <Field label="Photos">
            <PhotoStrip label="shared space" urls={space.photoDataUrls ?? []} onChange={(next) => onChange({ photoDataUrls: next })} />
          </Field>
          <Field label="Video">
            <VideoSlot label="shared space" url={space.videoDataUrl} onChange={(next) => onChange({ videoDataUrl: next })} />
          </Field>
        </CardFields>
      </MoreRows>
      <EditorDone onClick={onDone} dataAttr="listing-v2-space-done" />
    </>
  );
}

/**
 * One card per shared space and nothing above them. A listing saved while the
 * shared-space Default card existed still carries a `sharedSpaceDefaults` block;
 * this step neither reads nor writes it — every space always held its own copy.
 */
function StepSharedSpaces({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [open, setOpen] = useState<string | null>(null);
  const spaces = sub.sharedSpaces ?? [];
  const rooms = sub.rooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  /** The listing's ground floor — where a new space starts. */
  const groundFloor = floorLevelSelectOptions(sub.listingStoriesId, "")[0] ?? "";

  const writeSpace = (id: string, next: ManagerSharedSpaceSubmission) => patch({ sharedSpaces: spaces.map((sp) => (sp.id === id ? next : sp)) });
  const patchSpace = (space: ManagerSharedSpaceSubmission, p: Partial<ManagerSharedSpaceSubmission>) => writeSpace(space.id, { ...space, ...p });
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
  const accessSummary = (space: ManagerSharedSpaceSubmission) =>
    sharedSpaceAccessTriggerLabel(
      space.roomAccessIds,
      rooms.map((room) => room.id),
    );
  const summaryFor = (space: ManagerSharedSpaceSubmission) =>
    [SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === space.spaceKind)?.label, space.location || "Floor not set", wholePlace ? "" : accessSummary(space)]
      .filter(Boolean)
      .join(" · ");

  return (
    <StepColumn>
      <StepHeading title={`${spaces.length} shared ${spaces.length === 1 ? "space" : "spaces"}`} />

      {spaces.map((space, i) => {
        const isOpen = open === space.id;
        const label = space.name.trim() || `Shared space ${i + 1}`;
        return (
          <RecordCard
            key={space.id}
            name={space.name}
            nameLabel={`Name for shared space ${i + 1}`}
            namePlaceholder="Kitchen"
            onName={(v) => writeSpace(space.id, { ...space, name: v })}
            onDuplicate={() => {
              const copy = duplicateSharedSpaceEntry(space);
              const idx = spaces.findIndex((sp) => sp.id === space.id);
              patch({ sharedSpaces: [...spaces.slice(0, idx + 1), copy, ...spaces.slice(idx + 1)] });
              setOpen(copy.id);
            }}
            onRemove={() => {
              patch({ sharedSpaces: spaces.filter((sp) => sp.id !== space.id) });
              if (open === space.id) setOpen(null);
            }}
            removeLabel={`Remove ${label}`}
            summary={summaryFor(space)}
            open={isOpen}
            onToggle={() => toggle(space.id)}
            toggleLabel={label}
            dataAttr="listing-v2-space-card"
          >
            <div data-attr="listing-v2-space-editor">
              <SharedSpaceCardBody
                space={space}
                who={label}
                rooms={rooms}
                wholePlace={wholePlace}
                storiesId={sub.listingStoriesId}
                onChange={(p) => patchSpace(space, p)}
                onDone={() => setOpen(null)}
              />
            </div>
          </RecordCard>
        );
      })}

      <AddRowButton
        label="Add shared space"
        icon={LayoutGrid}
        dataAttr="listing-v2-add-space"
        onClick={() => {
          const id = `space-${Date.now()}`;
          const blank: ManagerSharedSpaceSubmission = {
            id,
            name: "",
            location: groundFloor,
            detail: "",
            amenitiesText: "",
            photoDataUrls: [],
            videoDataUrl: null,
            roomAccessIds: encodeSharedSpaceEveryone(),
          };
          patch({ sharedSpaces: [...spaces, blank] });
          setOpen(id);
        }}
      />
    </StepColumn>
  );
}

/* ─────────────────────── step 4 · rent & fees ─────────────────────── */

/**
 * The money that belongs to the LISTING rather than to one room: the lease
 * lengths on offer, the application fee, what is due at signing, late fees.
 *
 * A room's own deposit, move-in fee, utilities and prorated rent are NOT here —
 * they live in that room's Details, next to its rent, because that is the only
 * place a manager can see one room's whole price at once.
 */
/* ───────────────── house advanced · the nine groups ───────────────── */

/**
 * The lease types this listing is offered on.
 *
 * Types live on the LISTING, not the room: the application flow reads the
 * listing's list, so a room offering a type the listing does not have would
 * advertise something an applicant could never choose. The same control is
 * therefore shown inside a room's Leasing section — editing it there edits the
 * listing, which is what a manager means when they open one room and change
 * what it is let on.
 */
function LongTermLengthsField({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const lengths = normalizeLongTermLengths(sub.longTermLengthsOffered);
  const label = (months: number) => `${months} months`;
  return (
    <FactRow label="Long-term lengths">
      <MultiPick
        label="Long-term lengths offered"
        dataAttr="long-term-length"
        options={LONG_TERM_LENGTH_CHOICES.map(label)}
        selected={lengths.map(label)}
        allowOther={false}
        emptyLabel="Any length"
        onChange={(next) => patch({ longTermLengthsOffered: normalizeLongTermLengths(LONG_TERM_LENGTH_CHOICES.filter((m) => next.includes(label(m)))) })}
      />
    </FactRow>
  );
}

const LEASE_TYPE_LABELS: readonly { value: string; label: string }[] = [
  { value: LONG_TERM_LEASE_TERM, label: "Long-term" },
  { value: "Month-to-Month", label: "Month to month" },
  { value: CUSTOM_LEASE_TERM, label: "Custom" },
  { value: SHORT_TERM_LEASE_TERM, label: "Short-term" },
  { value: AIRBNB_LEASE_TERM, label: "Airbnb" },
];

function LeaseTypesField({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const allowed = resolveAllowedLeaseTerms(sub);
  const named = LEASE_TERM_CHOICES.filter((t) => t !== CUSTOM_LEASE_TERM);
  /* One order for the picker and every summary — `sortLeaseTermsCanonical` is
     the single authority (lease-terms.ts). */
  const selected = sortLeaseTermsCanonical([
    ...named.filter((t) => allowed.includes(t)),
    ...(sub.shortTermRentalsAllowed ? [SHORT_TERM_LEASE_TERM] : []),
    ...(sub.airbnbRentalsAllowed ? [AIRBNB_LEASE_TERM] : []),
    ...(allowed.includes(CUSTOM_LEASE_TERM) ? [CUSTOM_LEASE_TERM] : []),
  ]);
  const toLabel = (value: string) => LEASE_TYPE_LABELS.find((o) => o.value === value)?.label ?? value;
  const toValue = (label: string) => LEASE_TYPE_LABELS.find((o) => o.label === label)?.value ?? label;
  return (
    <FactRow first label="Lease types" required>
      <MultiPick
        label="Lease types you offer"
        dataAttr="lease-type"
        options={LEASE_TYPE_LABELS.map((o) => o.label)}
        selected={selected.map(toLabel)}
        allowOther={false}
        emptyLabel="Choose…"
        onChange={(labels) => {
          const next = labels.map(toValue);
          const shortTerm = next.includes(SHORT_TERM_LEASE_TERM);
          const airbnb = next.includes(AIRBNB_LEASE_TERM);
          // Short-term and Airbnb each have a flag AND a term in the list; the
          // sync helpers keep the two halves from disagreeing.
          let terms = next.filter((t) => t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM);
          terms = syncShortTermLeaseTermInAllowed(terms, shortTerm);
          terms = syncAirbnbLeaseTermInAllowed(terms, airbnb);
          patch({
            shortTermRentalsAllowed: shortTerm,
            airbnbRentalsAllowed: airbnb,
            allowedLeaseTerms: terms,
            leaseTermsBody: formatLeaseTermsBodyFromAllowed(terms),
          });
        }}
      />
    </FactRow>
  );
}

/**
 * What the LEASE DOCUMENT says — break-lease, holdover, quiet hours, venue.
 *
 * None of it is a price a manager sets while pricing a room, and all of it is
 * rarely touched, so it sits behind a disclosure at the foot of Pricing. Which
 * lease types are offered moved OUT of here and to the top of the step: it is
 * the answer every other price on the screen depends on.
 */
function LeaseDocumentGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  /**
   * A charge still at its prefilled default shows the "Filled" mark and, when it follows
   * the rent, the figure the CURRENT rent gives. Typing drops the mark and the typed value
   * stands (`lease-charge-defaults.ts`).
   */
  const chargeMark = (key: LeaseChargeDefaultKey) => <FieldMark kind={leaseChargeDefaultMark(sub, key)} />;
  const chargeValue = (key: LeaseChargeDefaultKey) => money(resolvedLeaseChargeValue(sub, key));
  const writeCharge = (key: LeaseChargeDefaultKey, value: string) =>
    patch({ [key]: value, leaseChargeDefaultKeys: withoutLeaseChargeDefault(sub, key) } as Partial<ManagerListingSubmissionV1>);
  return (
    <>
      <Field label="Lease template">
        <Input
          value={sub.leaseTemplateDocName ?? ""}
          placeholder="magnolia-lease-2026.pdf"
          onChange={(e) => patch({ leaseTemplateDocName: e.target.value })}
        />
      </Field>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Charges the lease names</p>
      <FieldRow cols={2}>
        <Field label="Early move-out fee" labelAside={chargeMark("longTermBreakLeaseFee")}>
          <Input value={chargeValue("longTermBreakLeaseFee")} onChange={(e) => writeCharge("longTermBreakLeaseFee", e.target.value)} data-attr="listing-v2-lease-early-move-out-fee" />
        </Field>
        <Field label="Holdover / day" labelAside={chargeMark("longTermHoldoverDailyRate")}>
          <Input value={chargeValue("longTermHoldoverDailyRate")} onChange={(e) => writeCharge("longTermHoldoverDailyRate", e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Returned payment fee" labelAside={chargeMark("longTermReturnedPaymentFee")}>
          <Input value={chargeValue("longTermReturnedPaymentFee")} onChange={(e) => writeCharge("longTermReturnedPaymentFee", e.target.value)} />
        </Field>
        <Field label="Trash violation fee" labelAside={chargeMark("longTermTrashViolationFee")}>
          <Input value={chargeValue("longTermTrashViolationFee")} onChange={(e) => writeCharge("longTermTrashViolationFee", e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Deposit labor rate / hour" labelAside={chargeMark("longTermDepositLaborRate")}>
          <Input value={chargeValue("longTermDepositLaborRate")} onChange={(e) => writeCharge("longTermDepositLaborRate", e.target.value)} />
        </Field>
        <Field label="Deposit reissue fee" labelAside={chargeMark("longTermDepositReissueFee")}>
          <Input value={chargeValue("longTermDepositReissueFee")} onChange={(e) => writeCharge("longTermDepositReissueFee", e.target.value)} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Lease-up fee %">
          <Input
            value={sub.longTermLeaseUpFeePercent ? String(sub.longTermLeaseUpFeePercent) : ""}
            inputMode="numeric"
            onChange={(e) => patch({ longTermLeaseUpFeePercent: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
          />
        </Field>
        <Field label="Guest cap">
          <Input
            value={sub.longTermGuestCap ? String(sub.longTermGuestCap) : ""}
            inputMode="numeric"
            onChange={(e) => patch({ longTermGuestCap: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>
      </FieldRow>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Rules the lease states</p>
      <FieldRow cols={2}>
        <Field label="Quiet hours">
          <Input value={sub.longTermQuietHours ?? ""} placeholder="10pm – 8am" onChange={(e) => patch({ longTermQuietHours: e.target.value })} />
        </Field>
        <Field label="Dispute venue">
          <Input value={sub.longTermDisputeVenue ?? ""} placeholder="King County, WA" onChange={(e) => patch({ longTermDisputeVenue: e.target.value })} />
        </Field>
      </FieldRow>
      <Field group label="At the end of the term">
        <CheckboxOption
          label="Rolls to month-to-month"
          checked={Boolean(sub.rolloverToMonthToMonth)}
          onChange={(next) => patch({ rolloverToMonthToMonth: next })}
        />
        <CheckboxOption
          label="Professional cleaning required at move-out"
          checked={Boolean(sub.longTermProfessionalCleaningRequired)}
          onChange={(next) => patch({ longTermProfessionalCleaningRequired: next })}
        />
      </Field>

      {sub.shortTermRentalsAllowed ? (
        <>
          <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Short stays</p>
          <Field label="What a short stay requires">
            <Textarea
              rows={2}
              value={sub.shortTermRequirements ?? ""}
              onChange={(e) => patch({ shortTermRequirements: e.target.value })}
              placeholder="Minimum nights, ID, no parties…"
            />
          </Field>
        </>
      ) : null}
    </>
  );
}
/**
 * The house-level Payments group: who pays the card fee, and how money arrives.
 *
 * Deliberately holds NO amounts. Every cost a resident is charged now lives in
 * the room's Pricing section, inside the lease-type card it belongs to, so a
 * figure is asked for exactly once and there is no second copy to disagree
 * with. What is left here is not a cost: whose bill the processing fee lands
 * on, and which rails you accept money over.
 */
function HousePaymentsGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  // Who pays card processing (and the promo code that lets PropLane cover it) is
  // asked once, here — never twice. The whole place's rent is on its own card
  // under "The whole place".
  return <HouseStripePaymentsGroup sub={sub} patch={patch} />;
}

function HouseStripePaymentsGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const stripeOn = sub.axisPaymentsEnabled !== false;
  const payer = sub.serviceFeePayer ?? "resident";
  /*
   * The code is asked for EVERY time PropLane pays is selected, on every listing
   * — never skipped because the account "already has coverage". That bypass is
   * what made the setting stick without anyone re-entering anything, and it fired
   * off any promo code at all, including plain subscription discounts.
   * Switching the payer still clears the stored code below, so changing it and
   * changing it back asks again, exactly as the captain asked.
   */
  const needsCoverageCode = stripeOn && payer === "proplane";
  const coverageCodeTyped = (sub.serviceFeeWaiverCode ?? "").length > 0;
  const coverageCodeValid = isProcessingCoverageCodeShape(sub.serviceFeeWaiverCode);

  return (
    <>
      <div className="px-3.5 py-1">
        <CheckboxOption
          label="Stripe (card or bank on PropLane)"
          checked={stripeOn}
          onChange={(next) =>
            patch({
              axisPaymentsEnabled: next,
              applicationFeeStripeEnabled: next,
            })
          }
        />
      </div>
      {stripeOn ? (
        <>
          <FactRow label="Processing fee">
            <RowSelectCell
              ariaLabel="Stripe processing fee"
              value={payer}
              dataAttr="listing-v2-service-fee-payer"
              options={[
                { value: "resident", label: "Resident pays" },
                { value: "manager", label: "I pay" },
                { value: "proplane", label: "PropLane pays" },
              ]}
              onChange={(v) =>
                patch({
                  serviceFeePayer: v as ManagerListingSubmissionV1["serviceFeePayer"],
                  serviceFeeWaiverCode: undefined,
                })
              }
            />
          </FactRow>
          {needsCoverageCode ? (
            <FactRow sub label="Coverage code">
              <span className="flex flex-col items-end gap-1">
                <input
                  style={{ textTransform: "uppercase" }}
                  autoComplete="off"
                  aria-label="Processing coverage code"
                  value={sub.serviceFeeWaiverCode ?? ""}
                  placeholder="Processing coverage code"
                  data-attr="listing-v2-service-fee-code"
                  onChange={(e) => patch({ serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(e.target.value) || undefined })}
                  className="min-h-[36px] w-[170px] rounded-lg border border-border bg-card px-2.5 text-[13.5px] font-semibold text-foreground outline-none focus:border-primary"
                />
                {coverageCodeTyped && !coverageCodeValid ? <span className="text-[12px] font-semibold text-red-600">{LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID}</span> : null}
              </span>
            </FactRow>
          ) : null}
        </>
      ) : null}
    </>
  );
}
function HouseMoveInGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <>
      <FieldRow cols={2}>
        <Field label="The home is available from">
          <Input
            value={sub.houseMoveInAvailableDate ?? ""}
            placeholder="1 Oct 2026"
            onChange={(e) => patch({ houseMoveInAvailableDate: e.target.value })}
          />
        </Field>
        {/* These used to write `wifiNetworkName` / `wifiPassword`, which the
            resident portal stopped reading — a manager could fill them in and
            no resident ever saw it. They now write the structured house info
            the portal actually renders. */}
        <Field label="Wifi network">
          <Input
            value={getHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "wifi", "network")}
            onChange={(e) =>
              patch({ houseInfo: setHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "wifi", "network", e.target.value) })
            }
          />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Wifi password">
          <Input
            value={getHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "wifi", "password")}
            onChange={(e) =>
              patch({ houseInfo: setHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "wifi", "password", e.target.value) })
            }
          />
        </Field>
        <Field label="Front door code">
          <Input
            value={getHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "access", "doorCode")}
            placeholder="001000"
            onChange={(e) =>
              patch({ houseInfo: setHouseInfoValue(normalizeHouseInfo(sub.houseInfo), "access", "doorCode", e.target.value) })
            }
          />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Entry photos">
          <PhotoStrip
            label="entry"
            urls={sub.houseMoveInPhotoDataUrls ?? []}
            onChange={(next) => patch({ houseMoveInPhotoDataUrls: next })}
          />
        </Field>
        <Field label="Arrival clip">
          <VideoSlot
            label="arrival"
            url={sub.houseMoveInVideoDataUrl}
            onChange={(next) => patch({ houseMoveInVideoDataUrl: next })}
          />
        </Field>
      </FieldRow>
      <Field label="Move-in instructions for the house">
        <Textarea
          rows={3}
          value={sub.houseMoveInInstructions ?? ""}
          onChange={(e) => patch({ houseMoveInInstructions: e.target.value })}
          placeholder="Parking, entry, bins, wifi…"
        />
      </Field>
    </>
  );
}

function HouseApplicationsGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  /*
   * The application fee, the short-term fee and the waiver code are asked on
   * Pricing → Applications and deliberately NOT repeated here. One question,
   * one place, one sanitiser.
   */
  return (
    <div className="px-3.5 py-1">
      <CheckboxOption
        label="Waive for returning residents"
        checked={Boolean(sub.waiveApplicationFeeForReturningResidents)}
        onChange={(next) =>
          patch({
            waiveApplicationFeeForReturningResidents: next,
            applicationFeeOnlyFirstApplication: next,
          })
        }
      />
    </div>
  );
}

function HouseBuildingGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <>
      <FieldRow cols={2}>
        <Field label="Floor plan">
          <PhotoStrip
            label="floor plan"
            max={1}
            urls={sub.propertyFloorPlanDataUrl ? [sub.propertyFloorPlanDataUrl] : []}
            onChange={(next) => patch({ propertyFloorPlanDataUrl: next[0] ?? null })}
          />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Year built">
          <Input
            value={sub.yearBuilt ? String(sub.yearBuilt) : ""}
            inputMode="numeric"
            placeholder="1962"
            onChange={(e) => patch({ yearBuilt: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>
        <Field label="Layout note">
          <Input
            value={sub.homeStructureNote}
            placeholder="3-story townhouse · 3.5 baths"
            onChange={(e) => patch({ homeStructureNote: e.target.value })}
          />
        </Field>
      </FieldRow>
      <Field group label="Utilities and upkeep">
        <CheckboxOption
          label="Utilities are shared, not separately metered"
          checked={Boolean(sub.sharedUtilityMetering)}
          onChange={(next) => patch({ sharedUtilityMetering: next })}
        />
        <CheckboxOption
          label="Regular pest service"
          checked={Boolean(sub.hasPeriodicPestService)}
          onChange={(next) => patch({ hasPeriodicPestService: next })}
        />
      </Field>
      <Field
        label="Also listed as"
      >
        <Textarea
          rows={2}
          value={sub.alsoListedAs}
          onChange={(e) => patch({ alsoListedAs: e.target.value })}
          placeholder="Cozy room near UW — $1050&#10;Magnolia house share"
        />
      </Field>
      <Field
        label="House rules"
      >
        <Textarea
          rows={3}
          value={sub.houseRulesText}
          onChange={(e) => patch({ houseRulesText: e.target.value })}
          placeholder="Quiet hours, guests, smoking…"
        />
      </Field>
      <Field label="Quick facts">
        <>
          {(sub.quickFacts ?? []).map((qf, i) => (
            <FieldRow cols={2} key={qf.id}>
              <Field label={`Fact ${i + 1}`}>
                <Input
                  value={qf.label}
                  placeholder="Parking"
                  onChange={(e) =>
                    patch({ quickFacts: (sub.quickFacts ?? []).map((q) => (q.id === qf.id ? { ...q, label: e.target.value } : q)) })
                  }
                />
              </Field>
              <Field label="Value">
                <Input
                  value={qf.value}
                  placeholder="Driveway, 2 cars"
                  onChange={(e) =>
                    patch({ quickFacts: (sub.quickFacts ?? []).map((q) => (q.id === qf.id ? { ...q, value: e.target.value } : q)) })
                  }
                />
              </Field>
            </FieldRow>
          ))}
          <button
            type="button"
            data-attr="listing-v2-add-fact"
            onClick={() => patch({ quickFacts: [...(sub.quickFacts ?? []), emptyQuickFactRow()] })}
            className="min-h-[38px] rounded-full border border-border bg-card px-4 text-[12.5px] font-bold text-primary"
          >
            Add a fact
          </button>
        </>
      </Field>
    </>
  );
}

function HouseComplianceGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <FieldRow cols={2}>
      <Field label="Certificate of occupancy date">
        <Input
          value={sub.certificateOfOccupancyDate ?? ""}
          placeholder="2024-05-01"
          onChange={(e) => patch({ certificateOfOccupancyDate: e.target.value })}
        />
      </Field>
      <Field label="RRIO registration number">
        <Input
          value={sub.rrioRegistrationNumber ?? ""}
          onChange={(e) => patch({ rrioRegistrationNumber: e.target.value })}
        />
      </Field>
    </FieldRow>
  );
}

/* ─────────────────────── step 5 · pricing ─────────────────────── */

/**
 * The money, on its own step.
 *
 * Both groups render exactly the fields they rendered inside Advanced — same
 * components, same submission, no second copy of any field — but open, in order,
 * and next to the receipt. A manager setting a deposit can now see what it does
 * to the move-in total without leaving the field.
 */
function StepPricing({
  sub,
  patch,
  defaults,
  setDefaults,
  onActiveLeaseTermChange,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  defaults: ListingHouseDefaults;
  setDefaults: (next: ListingHouseDefaults) => void;
  onActiveLeaseTermChange?: (leaseTerm: string) => void;
}) {
  const [leaseDocOpen, setLeaseDocOpen] = useState(false);
  return (
    <StepColumn wide>
      <StepHeading title="Pricing" />
      <RentEstimateLine sub={sub} />
      <ListingPricingSections
        sub={sub}
        patch={patch}
        defaults={defaults}
        setDefaults={setDefaults}
        leaseTypesField={
          <>
            <LeaseTypesField sub={sub} patch={patch} />
            {resolveAllowedLeaseTerms(sub).includes(LONG_TERM_LEASE_TERM) ? <LongTermLengthsField sub={sub} patch={patch} /> : null}
          </>
        }
        payments={<HousePaymentsGroup sub={sub} patch={patch} />}
        applications={<HouseApplicationsGroup sub={sub} patch={patch} />}
        onActiveLeaseTermChange={onActiveLeaseTermChange}
        leaseDocument={
          <AdvancedPanel
            summary="Lease document"
            open={leaseDocOpen}
            onToggle={() => setLeaseDocOpen((prev) => !prev)}
            dataAttr="listing-v2-lease-document"
          >
            <div className="px-1 pb-2">
              <LeaseDocumentGroup sub={sub} patch={patch} />
            </div>
          </AdvancedPanel>
        }
      />
    </StepColumn>
  );
}

/**
 * The paperwork a home has once — kept, but not made into a stage of the work.
 *
 * Rendered behind one disclosure at the foot of Basics. Every field is the same
 * component it was on the Advanced step, so nothing a manager already filled in
 * has moved anywhere they cannot reach.
 */
function HouseKeepingPanel({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  // The disclosure owns its own open state. It used to be rendered with
  // `open={false}` and a no-op toggle, so Move-in, The building and Local
  // compliance could never be reached from the editor.
  const [open, setOpen] = useState(false);
  return (
    <AdvancedPanel
      summary="Advanced"
      open={open}
      onToggle={() => setOpen((prev) => !prev)}
      dataAttr="listing-v2-house-keeping"
    >
      <HouseKeepingGroups sub={sub} patch={patch} />
    </AdvancedPanel>
  );
}

function HouseKeepingGroups({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const toggleGroup = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <AdvancedGroup
        title="Move-in"
        open={openGroup === "movein"}
        onToggle={() => toggleGroup("movein")}
        dataAttr="listing-v2-house-movein"
      >
        <HouseMoveInGroup sub={sub} patch={patch} />
      </AdvancedGroup>
      <AdvancedGroup
        title="The building"
        open={openGroup === "building"}
        onToggle={() => toggleGroup("building")}
        dataAttr="listing-v2-house-building"
      >
        <HouseBuildingGroup sub={sub} patch={patch} />
      </AdvancedGroup>
      <AdvancedGroup
        title="Local compliance"
        open={openGroup === "compliance"}
        onToggle={() => toggleGroup("compliance")}
        dataAttr="listing-v2-house-compliance"
      >
        <HouseComplianceGroup sub={sub} patch={patch} />
      </AdvancedGroup>
    </div>
  );
}

/**
 * What the records lookup and the pasted ad said about rent — shown, never
 * applied. The manager sets the price; these are two reference points.
 */
function RentEstimateLine({ sub }: { sub: ManagerListingSubmissionV1 }) {
  const r = sub.prefill;
  if (!r?.rentEstimateUsd) return null;
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  const range = r.rentEstimateLowUsd && r.rentEstimateHighUsd ? ` · range ${usd(r.rentEstimateLowUsd)}–${usd(r.rentEstimateHighUsd)}` : "";
  const perRoom = r.rentPerRoomUsd && r.fields.includes("houseDefaults") ? ` · ≈ ${usd(r.rentPerRoomUsd)} per room` : "";
  return (
    <p className="-mt-2 mb-4 text-[12.5px] font-semibold text-muted" data-attr="listing-v2-rent-estimate">
      <span aria-hidden className="mr-1 text-[var(--pl-blue-deep)]">✦</span>
      {`Estimate ≈ ${usd(r.rentEstimateUsd)}/mo${range}${perRoom}`}
    </p>
  );
}

/* ─────────────────────────── step 5 · review ─────────────────────────── */

export type ListingReadiness = { id: string; label: string; state: "done" | "todo" | "warn" };

/** What the review step reports, and what a completeness percentage means. */
export function listingReadiness(sub: ManagerListingSubmissionV1): ListingReadiness[] {
  const rooms = sub.rooms ?? [];
  const priced = rooms.filter((r) => r.monthlyRent > 0 || (r.dailyRentPrice ?? 0) > 0);
  const withPhotos = rooms.filter((r) => (r.photoDataUrls ?? []).length > 0);
  const allowed = resolveAllowedLeaseTerms(sub);
  return [
    { id: "address", label: "Address confirmed", state: sub.address.trim() ? "done" : "todo" },
    {
      id: "rooms",
      label:
        priced.length === rooms.length
          ? `${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}, all priced`
          : `${rooms.length - priced.length} of ${rooms.length} rooms have no rent`,
      state: rooms.length > 0 && priced.length === rooms.length ? "done" : "todo",
    },
    { id: "terms", label: "Lease lengths set", state: allowed.length > 0 ? "done" : "todo" },
    {
      id: "deposit",
      label: "Deposit and fees set",
      state: (sub.securityDeposit ?? "").trim() || (sub.applicationFee ?? "").trim() ? "done" : "todo",
    },
    {
      id: "photos",
      label:
        withPhotos.length === rooms.length
          ? "Every room has a photo"
          : `${rooms.length - withPhotos.length} rooms have no photo — they show a placeholder`,
      state: rooms.length > 0 && withPhotos.length === rooms.length ? "done" : "warn",
    },
    { id: "description", label: "Description written", state: sub.houseOverview.trim() ? "done" : "todo" },
    // "PropLane pays" without a code is stored, but checkout bills the resident
    // unless the account itself carries a grant — say so rather than let the
    // manager believe the fee is covered. A warning, not a blocker: an account
    // grant (staff approval or signup promo) satisfies it without any code.
    ...(sub.serviceFeePayer === "proplane" && !isProcessingCoverageCodeShape(sub.serviceFeeWaiverCode)
      ? [
          {
            id: "processing",
            label: "PropLane pays needs a promo code — until then the resident is billed",
            state: "warn" as const,
          },
        ]
      : []),
  ];
}

/** Which step closes a given readiness gap. */
const READINESS_STEP: Record<string, (typeof LISTING_V2_STEPS)[number]["id"]> = {
  address: "basics",
  description: "basics",
  rooms: "rooms",
  photos: "rooms",
  terms: "pricing",
  deposit: "pricing",
  processing: "pricing",
};

/**
 * The two doors a renter has to the manager, as the listing will print them.
 *
 * Neither is a field on the listing: the work number and the work email are
 * resolved from the OWNING manager's account, server-side, and the stored
 * listing blob is never trusted for them (see `listing-contact-card.tsx`). So
 * the editor cannot ask for a phone or an email here — it shows what the
 * listing will carry, and points at Settings when a door is missing.
 */
export type ListingContactDoors = {
  /** The work number, E.164, or null when the listing prints no Text button. */
  phone: string | null;
  /** The work email, or null when the listing prints no Email button. */
  email: string | null;
  /** Saves the draft and opens Settings → Messaging, where the doors are set up. */
  onSetUp?: () => void;
};

function ReachYouCard({ contact }: { contact: ListingContactDoors }) {
  const phoneLabel = contact.phone ? formatSmsPhoneLabel(contact.phone) : null;
  const setUp = contact.onSetUp ? (
    <button
      type="button"
      onClick={contact.onSetUp}
      data-attr="listing-v2-contact-set-up"
      className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-[12.5px] font-bold text-foreground hover:bg-accent/40"
    >
      Set up
    </button>
  ) : (
    <span className="text-[13px] text-muted">Not set</span>
  );
  const value = (text: string | null) =>
    text ? (
      <span className="flex min-w-0 items-center gap-2 text-[13px] text-foreground">
        <span className="truncate">{text}</span>
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-emerald-200 bg-emerald-50 text-[10px] font-extrabold text-emerald-700">
          ✓
        </span>
      </span>
    ) : (
      setUp
    );
  return (
    <div className="mt-8 max-w-[620px]" data-attr="listing-v2-reach-you">
      <b className="text-[13px] font-bold text-foreground">How renters reach you</b>
      <div className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
        <FactRow label="Text" first>
          {value(phoneLabel)}
        </FactRow>
        <FactRow label="Email">{value(contact.email)}</FactRow>
      </div>
    </div>
  );
}

function StepReview({
  sub,
  onJump,
  contact,
}: {
  sub: ManagerListingSubmissionV1;
  /** Take the manager to the step that closes a gap, rather than describing it. */
  onJump: (stepId: (typeof LISTING_V2_STEPS)[number]["id"]) => void;
  contact?: ListingContactDoors;
}) {
  const checks = listingReadiness(sub);
  const done = checks.filter((c) => c.state === "done").length;
  const pct = Math.round((done / checks.length) * 100);
  const open = checks.filter((c) => c.state !== "done");
  return (
    <StepColumn wide>
      <StepHeading title={open.length === 0 ? "Ready to publish" : `${open.length} ${open.length === 1 ? "thing needs" : "things need"} attention`} />
      <div className="max-w-[620px]">
        <b className="text-[13px] font-bold text-foreground">Listing completeness</b>
        <div className="my-2 h-2 overflow-hidden rounded-full bg-border">
          <span className="block h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <p className="mb-4 text-[12px] text-muted">{pct}% complete</p>
        <ul>
          {checks.map((c) => {
            const target = READINESS_STEP[c.id];
            return (
              <li
                key={c.id}
                className="flex items-center gap-2.5 border-b border-border/60 py-2.5 text-[13px] last:border-b-0"
              >
                <span
                  className={
                    c.state === "done"
                      ? "grid h-5 w-5 place-items-center rounded-full border border-emerald-200 bg-emerald-50 text-[10px] font-extrabold text-emerald-700"
                      : c.state === "warn"
                        ? "grid h-5 w-5 place-items-center rounded-full border border-amber-200 bg-amber-50 text-[10px] font-extrabold text-amber-700"
                        : "grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-[10px] font-extrabold text-muted/60"
                  }
                >
                  {c.state === "done" ? "✓" : c.state === "warn" ? "!" : "○"}
                </span>
                <span className="min-w-0 flex-1 text-foreground">{c.label}</span>
                {/*
                 * A gap the manager cannot act on from here is just a complaint.
                 * Every unfinished check carries the step that closes it.
                 */}
                {c.state !== "done" && target ? (
                  <button
                    type="button"
                    onClick={() => onJump(target)}
                    data-attr={`listing-v2-review-fix-${c.id}`}
                    className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-[12.5px] font-bold text-foreground hover:bg-accent/40"
                  >
                    Fix
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      {contact ? <ReachYouCard contact={contact} /> : null}
    </StepColumn>
  );
}

/* ─────────────────────────── orchestrator ─────────────────────────── */

export function ListingEditorV2({
  submission,
  propertyId = null,
  onChange,
  onClose,
  onSaveExit,
  onPublish,
  onStepChange,
  title,
  busy = false,
  isEdit = false,
  saveState,
  leadingStep,
  headerCenter,
  basicsLead,
  contact,
  initialStep,
}: {
  submission: ManagerListingSubmissionV1;
  /** The listing's record id when it already has one — booked rows on the Rooms step need it. Null for a brand-new listing. */
  propertyId?: string | null;
  onChange: (next: ManagerListingSubmissionV1) => void;
  /**
   * The Review step's explicit Save. Closing and typing already save
   * themselves in the parent; this is the visible commit a manager reaches for
   * on the last step — it writes whatever is unsaved and then leaves the
   * editor, and on a failed write it stays open rather than dropping the work.
   */
  onSaveExit?: (stepIndex: number) => void;
  /** Receives the step the manager left on, so a flush can keep the resume point. */
  onClose: (stepIndex: number) => void;
  /** Keep the parent's autosave resume point in sync while they stay in the editor. */
  onStepChange?: (stepIndex: number) => void;
  onPublish: () => void;
  title: string;
  busy?: boolean;
  /** Editing a listing that is already public, rather than building a new one. */
  isEdit?: boolean;
  /** Autosave status, stated once in the header. */
  saveState?: ReactNode;
  /**
   * A step the caller owns, drawn on the rail BEFORE Basics — the import's
   * Upload step. Choosing it, or pressing Back from Basics, hands control to
   * the caller; the six listing steps are untouched. Add property passes
   * nothing and renders exactly as before.
   */
  leadingStep?: ListingEditorLeadingStep;
  /** Header slot between the title and the save state (see ListingWorkspace). */
  headerCenter?: ReactNode;
  /** Drawn on Basics under its heading, ahead of Property type — Create's "Start from a file" strip. */
  basicsLead?: ReactNode;
  /** What the Review step says about how renters reach the manager. */
  contact?: ListingContactDoors;
  /** Open on this listing step — Import jumps to Rooms / Review without walking Basics. */
  initialStep?: ListingV2StepId;
}) {
  // Save and Publish share one `busy`; remember which was pressed so only that
  // button reads as in flight. The flag is read only while busy, so a stale
  // true after the write lands is harmless and the next press resets it.
  const [savePressed, setSavePressed] = useState(false);

  const [step, setStep] = useState(() => listingV2StepIndex(initialStep));
  useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(submission));
  /**
   * Steps the manager has actually opened.
   *
   * The rail marks a step done when it has been SEEN, not merely when it is
   * earlier in the list — on an edit a manager may only ever open Pricing, and
   * telling them Rooms is "done" because it is step 2 would be a lie.
   */
  const [visited, setVisited] = useState<Set<string>>(() => {
    const start = LISTING_V2_STEPS[listingV2StepIndex(initialStep)]!.id;
    return new Set([LISTING_V2_STEPS[0]!.id, start]);
  });
  /** Which room and lease type the receipt is quoting. */
  const [quoteRoomId, setQuoteRoomId] = useState<string | null>(null);
  const [quoteTerm, setQuoteTerm] = useState<string | null>(null);
  const patch: Patch = (next) => onChange({ ...submission, ...next });
  const last = LISTING_V2_STEPS.length - 1;
  const stepId = LISTING_V2_STEPS[step]!.id;

  const goTo = (index: number) => {
    const target = LISTING_V2_STEPS[Math.max(0, Math.min(last, index))]!;
    setStep(LISTING_V2_STEPS.indexOf(target));
    setVisited((prev) => (prev.has(target.id) ? prev : new Set(prev).add(target.id)));
  };

  // The short path (see listingV2PathStepIds). A step reached from the rail
  // that is not on it still gets Back/Continue that make sense: Continue goes
  // to the next step on the path after it, Back to the one before.
  const pathIds = listingV2PathStepIds(submission);
  const pathIndexOf = (id: ListingV2StepId) => pathIds.indexOf(id);
  const stepIndexOf = (id: ListingV2StepId) => LISTING_V2_STEPS.findIndex((s) => s.id === id);
  const nextOnPath = (): number | null => {
    const after = pathIds.find((id) => stepIndexOf(id) > step);
    return after ? stepIndexOf(after) : null;
  };
  const prevOnPath = (): number | null => {
    const before = [...pathIds].reverse().find((id) => stepIndexOf(id) < step);
    return before != null ? stepIndexOf(before) : null;
  };
  const nextStep = nextOnPath();
  const prevStep = prevOnPath();
  const onPath = pathIndexOf(stepId) !== -1;
  const pathPosition = onPath ? pathIndexOf(stepId) + 1 : null;

  const rooms = useMemo(() => submission.rooms ?? [], [submission.rooms]);
  const leaseTerms = useMemo(() => listingLeaseTypeScopeOptions(submission), [submission]);
  const receiptTerm = quoteTerm && leaseTerms.includes(quoteTerm) ? quoteTerm : leaseTerms[0] ?? DEFAULT_QUOTE_TERM;
  const receiptRoomId = quoteRoomId && rooms.some((r) => r.id === quoteRoomId) ? quoteRoomId : null;
  const openRoom = rooms.find((r) => r.id === receiptRoomId) ?? rooms[0] ?? null;

  // The same assistant the previous wizard offered, told which step it is on so
  // it can answer about the field in front of the manager.
  const assistantContext = useMemo(
    () =>
      buildListingModalAssistantContext({
        wizardTitle: title,
        stepLabel: LISTING_V2_STEPS[step]!.label,
        propertyId: null,
        submission,
      }),
    [title, step, submission],
  );

  const chrome = useMemo(() => listingRailChrome(submission), [submission]);
  const attention = chrome.attention;
  const summaries = chrome.summaries;

  const listingRailSteps = LISTING_V2_STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    attention: attention[s.id] ?? 0,
    summary: summaries[s.id],
    offPath: !pathIds.includes(s.id),
  }));
  // The leading step, when there is one, is index 0 on the rail and shifts the
  // listing steps by one; `step` itself still indexes LISTING_V2_STEPS.
  const railSteps = leadingStep
    ? [{ id: leadingStep.id, label: leadingStep.label, summary: leadingStep.summary, attention: leadingStep.attention ?? 0 }, ...listingRailSteps]
    : listingRailSteps;
  const railOffset = leadingStep ? 1 : 0;
  const onRailJump = (index: number) => {
    if (leadingStep && index === 0) {
      leadingStep.onOpen();
      return;
    }
    goTo(index - railOffset);
  };

  const coverUrl = chrome.coverUrl;
  const photoCount = chrome.photoCount;

  const body = useMemo(() => {
    switch (stepId) {
      case "basics":
        return (
          <>
            <StepBasics sub={submission} patch={patch} lead={basicsLead} onHouseDefaults={setDefaults} />
            <div className="mt-8 max-w-[860px]">
              <HouseKeepingPanel sub={submission} patch={patch} />
            </div>
          </>
        );
      case "rooms":
        return (
          <StepRooms
            propertyId={propertyId}
            sub={submission}
            patch={patch}
            defaults={defaults}
            setDefaults={setDefaults}
            onGoToPricing={() => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === "pricing"))}
            onGoToBathrooms={() => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === "bathrooms"))}
          />
        );
      case "bathrooms":
        return <StepBathrooms sub={submission} patch={patch} />;
      case "spaces":
        return <StepSharedSpaces sub={submission} patch={patch} />;
      case "pricing":
        return (
          <StepPricing
            sub={submission}
            patch={patch}
            defaults={defaults}
            setDefaults={setDefaults}
            onActiveLeaseTermChange={setQuoteTerm}
          />
        );
      default:
        return (
          <StepReview
            sub={submission}
            onJump={(id) => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === id))}
            contact={contact}
          />
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, submission, defaults, isEdit, basicsLead]);

  /**
   * The right-hand panel for this step.
   *
   * Every step has one. A step that had nothing worth showing would be a sign
   * the step itself is wrong, not a reason for an empty column.
   */
  const sidePanel = useMemo(() => {
    switch (stepId) {
      case "rooms":
        return <RoomPreviewPanel sub={submission} room={openRoom} />;
      case "bathrooms":
        return <BathroomCoveragePanel sub={submission} />;
      case "spaces":
        return <SharedSpacesPanel sub={submission} />;
      case "pricing":
        return (
          <PricingReceiptPanel
            sub={submission}
            patch={patch}
            leaseTerm={receiptTerm}
            roomId={receiptRoomId}
            leaseTerms={leaseTerms.length > 0 ? leaseTerms : [DEFAULT_QUOTE_TERM]}
            onRoomChange={setQuoteRoomId}
            onLeaseTermChange={setQuoteTerm}
            lockLeaseTerm
          />
        );
      default:
        return <ListingPreviewPanel sub={submission} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, submission, openRoom, receiptTerm, receiptRoomId, leaseTerms]);

  return (
    <ListingWorkspace
      title={title}
      subtitle={[submission.address, submission.city, submission.state].filter(Boolean).join(", ") || undefined}
      badge={
        isEdit ? (
          <span className="rounded-full bg-[var(--status-confirmed-bg)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--status-confirmed-fg)]">
            Listed
          </span>
        ) : null
      }
      saveState={saveState}
      onClose={() => onClose(step)}
      headerAside={<ModalAssistantStrip contextHint={assistantContext} storageScopeKey="listing-wizard-v2" />}
      headerCenter={headerCenter}
      rail={<StepRail steps={railSteps} current={step + railOffset} onJump={onRailJump} visited={visited} />}
      railHeader={
        <>
          <RailCover photoUrl={coverUrl} photoCount={photoCount} onAddPhotos={() => goTo(0)} />
          <RailNotice count={summaries.open} onOpen={() => goTo(last)} />
        </>
      }
      railFooter={<RailStatus listed={isEdit} />}
      sidePanel={sidePanel}
      footer={
        <>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={prevStep == null && !leadingStep}
              onClick={() => {
                if (prevStep != null) goTo(prevStep);
                else leadingStep?.onOpen();
              }}
              className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
            >
              Back
            </button>
          </div>
          {/*
           * The counter used to be desktop-only, so a phone showed Back and
           * Continue with nothing between them — no idea how much was left.
           * It fits between the two buttons at 375px, so it shows everywhere.
           */}
          <span className="min-w-0 flex-1 truncate text-center text-[12.5px] text-muted">
            {pathPosition != null ? `Step ${pathPosition + railOffset} of ${pathIds.length + railOffset}` : "Optional detail"}
          </span>
          {nextStep == null ? (
            <div className="flex items-center gap-2">
              {/* Review is Save + Publish — a draft stays a draft, a live
                  listing writes in place. ✕ still writes on close; this Save
                  is the explicit pair the Review step shows. */}
              <button
                type="button"
                onClick={() => {
                  setSavePressed(true);
                  onSaveExit?.(step);
                }}
                disabled={busy}
                data-attr={isEdit ? "listing-v2-save" : "listing-v2-save-draft"}
                className="min-h-[44px] rounded-full px-3 text-[14px] font-bold text-primary disabled:opacity-60 sm:border sm:border-border sm:bg-card sm:px-6 sm:text-foreground"
              >
                {busy && savePressed ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSavePressed(false);
                  onPublish();
                }}
                disabled={busy}
                data-attr="listing-v2-publish"
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy && !savePressed ? "Publishing…" : "Publish"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => goTo(nextStep)}
              data-attr="listing-v2-next"
              aria-label={`Continue to ${LISTING_V2_STEPS[nextStep]!.label}`}
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
            >
              <span className="sm:hidden">Continue</span>
              <span className="hidden sm:inline">Continue to {LISTING_V2_STEPS[nextStep]!.label}</span>
            </button>
          )}
        </>
      }
    >
      {body}
      <SideBelow>{sidePanel}</SideBelow>
    </ListingWorkspace>
  );
}
