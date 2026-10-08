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
import { useConfirm } from "@/components/providers/app-ui-provider";
import { WorkspaceFileCard, WorkspaceHeaderUploadPresent, type WorkspaceHeaderUploadProps } from "@/components/portal/add-workspace/upload-action";
import { Input, Textarea } from "@/components/ui/input";
import { validateStateAbbrev } from "@/app/(public)/rent/apply/apply-validation";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { BlockedDatesSection } from "@/components/portal/listing-room-editor/blocked-dates-section";
import { RoomBathroomFields } from "@/components/portal/listing-room-editor/room-bathroom-fields";
import { SharedRoomConfigRows } from "@/components/portal/listing-room-editor/shared-room-config-rows";
import { BathroomEditorMirrorFields } from "@/components/portal/listing-room-editor/bathroom-editor-mirror-fields";
import { bathFactLabel, copyRoomBathroomLinkFrom, roomBathroomState } from "@/lib/listing-room-editor/bathroom-link";
import { cn } from "@/lib/utils";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  normalizeListingPaymentWaiverCode,
} from "@/lib/payment-policy";
import { isProcessingCoverageCodeShape } from "@/lib/processing-coverage-codes";
import { uploadListingImageFiles, uploadListingVideoFile } from "@/lib/listing-media-client";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import {
  listingSyndicationHasStreetAddress,
  listingSyndicationPhotoUrls,
} from "@/lib/listing-syndication/zillow-feed";
import { track } from "@/lib/analytics/track-client";
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
import { ZillowRentalNetworkRow } from "@/components/portal/zillow-rental-network-row";
import { buildListingModalAssistantContext } from "@/lib/listing-assistant-context";
import { Building, Building2, DoorOpen, Home, Layers, Store, Warehouse, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import {
  basicsBathroomCount,
  basicsFloorCount,
  cleanSharedSpaceName,
  highestFloorInUse,
  sharedSpaceTitle,
  syncListingBasicsFromLists,
} from "@/lib/listing-basics-sync";
import { PortalRowMenu } from "@/components/portal/portal-row-menu";
import { ListingMediaRow } from "@/components/portal/listing-room-editor/listing-media-row";
import { applyRoomFurnitureItems, roomFurnitureItems, roomFurnishingLabel, ROOM_FURNITURE_ITEMS } from "@/lib/listing-room-editor";
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
  syncShortTermLeaseTermInAllowed,
  duplicateBathroomEntry,
  duplicateRoomEntry,
  duplicateSharedSpaceEntry,
  emptyBathroom,
  emptyRoom,
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
  isBathroomSlotRemovable,
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  roomOfferedLeaseTerms,
  roomOfferedLeaseTermsFromPick,
} from "@/lib/manager-listing-submission";
import {
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  LEASE_PICK_OPTIONS,
  LEASE_TYPES,
  leasePickFromStored,
  leasePickSummary,
  storedTermsFromLeasePick,
  type LeaseTypeId,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { getHouseInfoValue, normalizeHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { applyListingBathroomSlots, applyListingBedroomSlots } from "@/lib/manager-listing-submission";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { isValidZipInput, sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { markPaymentFieldOwn, type PaymentSettingsField } from "@/lib/property-payment-settings-scope";
import {
  bathroomTypeOf,
  copyBathroomSetupFrom,
  copySharedSpaceSetupFrom,
  bathroomSetupIsBlank,
  bathroomSetupMatches,
  sharedSpaceSetupIsBlank,
  sharedSpaceSetupMatches,
  writeBathroomType,
  type BathroomType,
} from "@/lib/listing-record-defaults";
import {
  encodeSharedSpaceAccessPick,
  encodeSharedSpaceEveryone,
  retainSharedSpaceAccessAfterRoomsChange,
  sharedSpaceAccessMenuSelected,
  sharedSpaceAccessOptions,
  sharedSpaceAccessTriggerLabel,
  sharedSpaceIsEveryone,
} from "@/lib/listing-shared-space-access";
import { listingLeaseTypeScopeOptions, listingPricingLeaseTabs, listingPricingTabToLeaseTerm } from "@/lib/listing-fee-scope";
import { isStayLeaseTerm } from "@/lib/listing-quote";
import { listingOfferedStays, staysPatch } from "@/lib/listing-stays";
import { submissionWithShortStayDefaults } from "@/lib/leasing-quick-add";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { LONG_TERM_LEASE_TERM as DEFAULT_QUOTE_TERM } from "@/lib/rental-application/lease-terms";
import { listingV2PublishPricingBlocker, PUBLISH_BLOCKER_RENT } from "@/lib/listing-wizard-validation";
import type { WorkspacePricingDefaults } from "@/lib/workspace-pricing-defaults";
import { ListingPricingSections } from "@/components/portal/listing-wizard-v2/listing-pricing-step";
import { ListingPreviewPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import {
  ListingDetailSummaryPanel,
  StepApplication,
  StepLease,
  StepMoveIn,
  StepPricing,
  listingDetailSummaries,
  type ListingDetailDoors,
  type ListingDetailStepId,
} from "@/components/portal/listing-wizard-v2/listing-detail-steps";
import {
  applyHouseDefaultsToRooms,
  copyRoomDescriptionFrom,
  houseDefaultsForSubmission,
  roomDescriptionIsBlank,
  roomDescriptionMatches,
  roomInheritsDefault,
  roomFollowsTermDefault,
  type ListingHouseDefaults,
  type ListingHouseDefaultField,
  type RoomDescriptionField,
} from "@/lib/listing-house-defaults";
import { roomHasStayOffer } from "@/lib/room-pricing";
import {
  AddRowButton,
  ColumnHelp,
  EditorDone,
  MoreRows,
  CardFields,
  CheckboxOption,
  Field,
  FieldRow,
  FactRow,
  MoneyInput,
  AdvancedGroup,
  AdvancedPanel,
  ChoiceCard,
  CheckCard,
  CountStepper,
  KindTile,
  MultiPick,
  LeaseTermsField,
  RecordCard,
  RowSelectCell,
  RailCover,
  RailNotice,
  RailStatus,
  SectionGroup,
  StepColumn,
  StepHeading,
  StepRail,
  ListingWorkspace,
  WizardFooterActions,
  WizardStepProgress,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";

/**
 * Nine steps. Application, Lease, Move-in and Pricing sit between Shared spaces and
 * Review (captain, Oct 3): a few flat rows each, over the property's own forms, with
 * "Edit in full" opening the same editor the property page opens. None is required.
 */
export const LISTING_V2_STEPS = [
  { id: "basics", label: "Basics" },
  { id: "rooms", label: "Rooms" },
  { id: "bathrooms", label: "Bathrooms" },
  { id: "spaces", label: "Shared spaces" },
  { id: "application", label: "Application" },
  { id: "lease", label: "Lease" },
  { id: "movein", label: "Move-in" },
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
 * The steps a listing HAS to pass through. Basics carries the title, photos and
 * description; Review publishes. Rent is set on the property Payments tab.
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
    application: string;
    lease: string;
    movein: string;
    pricing: string;
    review: string;
    open: number;
  };
  coverUrl: string | null;
  photoCount: number;
};

export function listingRailChrome(submission: ManagerListingSubmissionV1): ListingRailChrome {
  const rooms = submission.rooms ?? [];
  const checks = listingReadiness(submission);
  const unresolved = (id: string) => checks.find((c) => c.id === id && c.state !== "done");
  const attention = {
    basics: [unresolved("address"), unresolved("description")].filter(Boolean).length,
    rooms: [unresolved("rooms"), unresolved("photos")].filter(Boolean).length,
    bathrooms: (submission.bathrooms ?? []).length === 0 ? 1 : 0,
    spaces: 0,
    // None of the leasing steps is required to publish, so none raises a red dot.
    application: 0,
    lease: 0,
    movein: 0,
    pricing: 0,
    review: 0,
  } as Record<string, number>;
  const open = checks.filter((c) => c.state !== "done").length;
  const withPhotos = rooms.filter((r) => (r.photoDataUrls ?? []).length > 0).length;
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
      ...listingDetailSummaries(submission),
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
export function VideoSlot({
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  /*
   * Videos upload as they are chosen, through the same client path
   * PhotoStrip uses for photos, so the submission carries a permanent URL
   * rather than a base64 data URL. A 40-170MB phone clip held as a data URL
   * made the iOS web view fail in total silence: no error, no spinner, the
   * tile just stayed on "+".
   */
  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError("");
    setBusy(true);
    setProgress(0);
    try {
      const uploaded = await uploadListingVideoFile(file, { onProgress: setProgress });
      onChange(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const percent = Math.round(progress * 100);

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
          <label className="relative grid h-16 w-20 cursor-pointer place-items-center overflow-hidden rounded-lg border border-dashed border-border bg-accent/20 text-[18px] text-muted">
            {busy ? <span className="text-[12.5px] font-semibold">{percent}%</span> : "+"}
            {busy ? (
              <span className="absolute inset-x-0 bottom-0 h-1 bg-border/40">
                <span className="block h-1 rounded bg-primary" style={{ width: `${percent}%` }} />
              </span>
            ) : null}
            <input
              type="file"
              accept="video/*"
              disabled={busy}
              className="sr-only"
              aria-label={`Add ${label} video`}
              onChange={(e) => {
                void pick(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      {error ? <p className="mt-1 text-[12px] font-semibold text-red-700">{error}</p> : null}
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
  const offeredStays = listingOfferedStays(sub);
  const [refusedLastStay, setRefusedLastStay] = useState(false);
  // "Stays you offer" is the one place this is set. At least one stays on: turning the last one off is refused.
  const toggleStay = (stay: "long_term" | "short_term") => {
    const patchFor = staysPatch(sub, { ...offeredStays, [stay]: !offeredStays[stay] });
    if (!patchFor) {
      setRefusedLastStay(true);
      return;
    }
    setRefusedLastStay(false);
    // Ticking Short term adds the short-term application and lease; a long-term-only property never has them.
    patch(stay === "short_term" && !offeredStays.short_term ? submissionWithShortStayDefaults({ ...sub, ...patchFor }) : patchFor);
  };
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
   * half. A card this creates starts blank — a full bath, no rooms yet, and
   * no floor of its own (the card SHOWS the listing's ground floor) — except
   * the half the fractional count may add, which `applyListingBathroomSlots`
   * already shapes as a half bath and this leaves alone. Lowering the count
   * removes untouched cards from the end and, as with bedrooms, keeps the
   * cards and moves only the number when the last card has been filled in.
   */
  const setBathrooms = (next: number) => {
    const id = bathIdFromCount(next);
    const before = sub.bathrooms?.length ?? 0;
    const applied = applyListingBathroomSlots({ ...sub, listingTotalBathroomsId: id }, next);
    if (!applied.ok) {
      patch({ listingTotalBathroomsId: id });
      return;
    }
    const halfIndex = next % 1 !== 0 ? applied.sub.bathrooms.length - 1 : -1;
    const bathrooms = applied.sub.bathrooms.map((bath, i) => {
      // A pre-existing card, or the half the fractional count may add, is
      // left exactly as `applyListingBathroomSlots` shaped it. A card this
      // count makes is a full bath and nothing else: its floor stays BLANK
      // (the card shows the listing's ground floor as its default, and
      // writes one only when the manager picks). A stamped floor would make
      // `isBathroomSlotRemovable` read the card as filled in, and lowering
      // the count again would refuse — leaving three cards under a count
      // that says two.
      if (i < before || i === halfIndex) return bath;
      return writeBathroomType(bath, "full");
    });
    patch({ ...applied.sub, bathrooms, listingTotalBathroomsId: id });
  };
  const stories = basicsFloorCount(sub);
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
        <Field label="Stays you offer" required group>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <CheckCard checked={offeredStays.long_term} title="Long term" dataAttr="listing-v2-stay-long-term" onToggle={() => toggleStay("long_term")} />
            <CheckCard checked={offeredStays.short_term} title="Short term" dataAttr="listing-v2-stay-short-term" onToggle={() => toggleStay("short_term")} />
          </div>
          {refusedLastStay ? (
            <span role="alert" data-attr="listing-v2-stay-min-one" className="block text-xs font-semibold text-destructive">
              Keep at least one stay
            </span>
          ) : null}
        </Field>
        <div className="rounded-2xl border border-border bg-card">
          <FactRow first required label={<>{rentByRoom ? "Bedrooms to rent" : "Bedrooms"} {mark("listingBedroomSlots")}</>}>
            <CountStepper compact value={roomCount} min={1} max={20} onChange={setBedrooms} label="bedrooms" dataAttr="listing-v2-bedrooms" />
          </FactRow>
          <FactRow required label={<>Bathrooms {mark("listingTotalBathroomsId")}</>}>
            <CountStepper
              compact
              value={basicsBathroomCount(sub)}
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
              // The minus stops at the highest floor a room, bathroom or shared space sits on:
              // lowering never moves a record. Raising is free.
              min={Math.max(1, highestFloorInUse(sub))}
              max={LISTING_STORIES_OPTIONS.length}
              onChange={(n) => patch({ listingStoriesId: String(n) })}
              label="floors"
              dataAttr="listing-v2-floors"
            />
          </FactRow>
          <FactRow label={<>Home size {mark("houseSizeSqft")}</>}>
            <span className="relative flex w-36 items-center">
              <Input
                inputMode="numeric"
                value={sub.houseSizeSqft ?? ""}
                placeholder="1,450"
                aria-label="Home size in square feet"
                data-attr="listing-v2-home-size"
                className="w-full pr-12 text-right"
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                  patch({ houseSizeSqft: n > 0 ? n : undefined });
                }}
              />
              <span className="pointer-events-none absolute right-3 whitespace-nowrap text-[13px] font-semibold text-foreground/70">sq ft</span>
            </span>
          </FactRow>
          <FactRow label={<>Built {mark("yearBuilt")}</>}>
            <Input
              inputMode="numeric"
              value={sub.yearBuilt ?? ""}
              placeholder="1962"
              aria-label="Year built"
              data-attr="listing-v2-year-built"
              className="w-36 text-right"
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
            <Input aria-label="City" data-wizard-field="city" value={sub.city} onChange={(e) => patch({ city: e.target.value })} />
          </Field>
          <Field label="State" required>
            <Input aria-label="State" data-wizard-field="state" value={sub.state} onChange={(e) => patch({ state: e.target.value })} />
          </Field>
          <Field label="ZIP" required>
            <Input aria-label="ZIP" data-wizard-field="zip" value={sub.zip} onChange={(e) => patch({ zip: e.target.value })} />
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

/**
 * Which {@link RoomDescriptionField} a key on the room record belongs to, so a
 * hand edit — or a "Same as Room X" copy — records the right name in
 * `room.ownRoomFields`. Rooms have no Default card left to detach from; the
 * list is kept only because the field is still persisted on the record for
 * whatever else reads it.
 */
const ROOM_DESCRIPTION_FIELD_BY_KEY: Partial<Record<keyof ManagerRoomSubmission, RoomDescriptionField>> = {
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
  people: "How many residents can rent this room, each on their own lease. Not the number of beds.",
  bathroom: "The bathroom this room uses, and whether it is private (ensuite) or shared. Add bathrooms on the Bathrooms step first.",
  floor: "Which level this room is on.",
} as const;

/**
 * The square-footage box.
 *
 * It keeps its own text while it has focus and commits on blur, so a manager
 * can clear the number without a re-render snapping it back mid-edit, and
 * typing replaces the shown figure instead of landing in front of it. Focus
 * selects the number for the same reason. Empty on blur clears the field to
 * unset; the placeholder is a dash, never a number that could read as the
 * size.
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
 * The rows an open room card unfolds. Every room is its own record — nothing
 * here is inherited or dashed; "Same as {@link sameAsOptions}" is the one way
 * a room's description starts from another room's, and it is a one-time copy
 * (see `copyRoomDescriptionFrom`), never a standing link.
 */
/** The lease types a room can be limited to, with the wording the Leases offered row uses. */
const ROOM_LEASE_TERM_LABELS: readonly { value: string; label: string }[] = LEASE_TYPES.map((type) => ({
  value: type.term,
  label: type.label,
}));

/**
 * Captain, Oct 8: a room's Leases offered is Long-term and Short-term; Custom dates and Month-to-month are
 * indented checkboxes under Long-term, shown only while it is ticked. The picker speaks lease-type ids and the
 * room still stores the same terms (`storedTermsFromLeasePick`).
 */
const ROOM_LEASE_PICK_OPTIONS = LEASE_PICK_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
  parent: o.parent,
  ...(o.value === "custom" ? { info: "Starts any day of the month" } : {}),
}));

/**
 * One patch for a room's Leases offered pick: a type the listing does not offer yet is
 * switched on for the listing too (or an applicant could never choose it), and the room
 * stores a restriction only when it offers fewer types than the listing.
 */
export function roomLeasesOfferedPatch(
  sub: ManagerListingSubmissionV1,
  picked: readonly string[],
): { listing: Partial<ManagerListingSubmissionV1> | null; offeredLeaseTerms: string[] | undefined } {
  const listingTerms = listingPricingLeaseTabs(sub);
  const missing = picked.filter((t) => !listingTerms.includes(t));
  let listing: Partial<ManagerListingSubmissionV1> | null = null;
  let nextListingTerms = listingTerms;
  if (missing.length > 0) {
    const shortTerm = Boolean(sub.shortTermRentalsAllowed) || missing.includes(SHORT_TERM_LEASE_TERM);
    let allowed = [...(sub.allowedLeaseTerms ?? []), ...missing.filter((t) => t !== SHORT_TERM_LEASE_TERM)];
    allowed = Array.from(new Set(allowed));
    allowed = syncShortTermLeaseTermInAllowed(allowed, shortTerm);
    listing = { shortTermRentalsAllowed: shortTerm, allowedLeaseTerms: allowed, leaseTermsBody: formatLeaseTermsBodyFromAllowed(allowed) };
    nextListingTerms = listingPricingLeaseTabs({ ...sub, ...listing });
  }
  return { listing, offeredLeaseTerms: roomOfferedLeaseTermsFromPick(picked, nextListingTerms) };
}

/** The listing's own lease types a room can be limited to (never Airbnb; legacy fixed lengths read as Long-term). */
function roomLeaseTermChoices(sub: ManagerListingSubmissionV1): { value: string; label: string }[] {
  const offered = listingPricingLeaseTabs(sub);
  return ROOM_LEASE_TERM_LABELS.filter((o) => offered.includes(o.value));
}

/** "Long-term, Short term" when the room restricts its lease types, "" when it follows the listing. */
export function roomLeaseTermsFact(sub: ManagerListingSubmissionV1, room: ManagerRoomSubmission): string {
  if (!room.offeredLeaseTerms?.length) return "";
  const choices = roomLeaseTermChoices(sub);
  const own = roomOfferedLeaseTerms(
    room,
    choices.map((c) => c.value),
  );
  return choices
    .filter((c) => own.includes(c.value))
    .map((c) => c.label)
    .join(", ");
}

export function ListingRoomEditorBody({
  sub,
  room,
  propertyId = null,
  managerUserId = null,
  who,
  wholePlace,
  onPatchBathrooms,
  onGoToBathrooms,
  onRoom,
  onLeasesOffered,
  storiesId,
  sameAsOptions,
  sameAsValue,
  onSameAs,
  showSharedRoomConfig = false,
}: {
  sub: ManagerListingSubmissionV1;
  room: ManagerRoomSubmission;
  propertyId?: string | null;
  managerUserId?: string | null;
  who: string;
  wholePlace: boolean;
  onPatchBathrooms: (bathrooms: ManagerBathroomSubmission[]) => void;
  onGoToBathrooms: () => void;
  onRoom: (patch: Partial<ManagerRoomSubmission>) => void;
  /** Leases offered: a pick may also switch a lease type on for the listing (one patch). */
  onLeasesOffered?: (picked: string[]) => void;
  storiesId: string | undefined;
  sameAsOptions: readonly { value: string; label: string }[];
  sameAsValue: string;
  onSameAs: (roomId: string) => void;
  /** House details popup only — wizard pricing lives on Payments (C2-RE15). */
  showSharedRoomConfig?: boolean;
}) {
  const photos = room.photoDataUrls ?? [];
  const video = room.videoDataUrl;
  const detail = room.detail ?? "";
  const beds: ManagerRoomBed[] = room.beds ?? [];
  const residents = room.occupancyCapacity ?? 1;
  const bedCount = beds.reduce((n, b) => n + b.count, 0) || residents;
  const amenities = room.roomAmenitiesText || "";
  const size = room.sizeSqft ?? 0;
  const floorOptions = floorLevelSelectOptions(storiesId, room.floor).map((l) => ({ value: l, label: l }));
  const floorShown = (room.floor ?? "").trim() || floorOptions[0]?.value || "";
  const furnItems = roomFurnitureItems(room);
  // A room that does not restrict shows every lease type the listing offers ticked.
  const leaseSelected = leasePickFromStored(
    room.offeredLeaseTerms?.length
      ? [...room.offeredLeaseTerms]
      : roomOfferedLeaseTerms(room, roomLeaseTermChoices(sub).map((c) => c.value)),
  );
  const writeBeds = (next: ManagerRoomBed[]) => onRoom({ beds: next, bedCount: next.reduce((n, b) => n + b.count, 0) });
  const help = (title: string, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      {title}
      <ColumnHelp title={title} text={text} />
    </span>
  );

  return (
    <>
      <FactRow first label="Same as">
        <RowSelectCell ariaLabel={`Same as for ${who}`} value={sameAsValue} options={sameAsOptions} placeholder="Set for this room" onChange={onSameAs} />
      </FactRow>
      {wholePlace ? null : (
        <FactRow label={help("Residents", ROOM_HELP.people)}>
          <CountStepper compact value={residents} min={1} max={OCCUPANCY_MAX} label={`Residents for ${who}`} onChange={(n) => onRoom({ occupancyCapacity: n })} />
        </FactRow>
      )}
      <FactRow label="Beds">
        <CountStepper compact value={bedCount} min={1} max={OCCUPANCY_MAX} label={`Beds for ${who}`} onChange={(n) => writeBeds(beds.length ? beds.map((b, i) => (i === 0 ? { ...b, count: n } : b)) : [{ type: "Twin", count: n }])} />
      </FactRow>
      {wholePlace ? null : (
        <RoomBathroomFields
          sub={sub}
          room={room}
          who={who}
          onGoToBathrooms={onGoToBathrooms}
          onSubmission={(next) => onPatchBathrooms(next.bathrooms ?? [])}
        />
      )}
      {showSharedRoomConfig ? <SharedRoomConfigRows room={room} who={who} onRoom={onRoom} /> : null}
      <FactRow label={help("Floor", ROOM_HELP.floor)}>
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={floorShown} options={floorOptions} placeholder="Floor…" onChange={(v) => onRoom({ floor: v })} />
      </FactRow>
      <FactRow label="Furnished">
        <CheckboxMultiSelect
          hideLabel
          label={`Furnished for ${who}`}
          variant="cell"
          className="min-w-[150px] max-w-[240px]"
          options={ROOM_FURNITURE_ITEMS.map((v) => ({ value: v, label: v }))}
          selected={furnItems}
          selectionTriggerLabel={roomFurnishingLabel(furnItems)}
          emptyLabel="Not furnished"
          onChange={(next) => onRoom(applyRoomFurnitureItems(room, next))}
        />
      </FactRow>
      <FactRow label="Leases offered">
        <CheckboxMultiSelect
          hideLabel
          label={`Leases offered for ${who}`}
          variant="cell"
          className="min-w-[150px] max-w-[240px]"
          options={ROOM_LEASE_PICK_OPTIONS}
          selected={leaseSelected}
          selectionTriggerLabel={leasePickSummary(leaseSelected)}
          emptyLabel="All lease types"
          dataAttr="listing-v2-room-leases-offered"
          onChange={(next) => {
            const picked = storedTermsFromLeasePick(next as LeaseTypeId[]);
            if (onLeasesOffered) onLeasesOffered(picked);
            else onRoom({ offeredLeaseTerms: roomOfferedLeaseTermsFromPick(picked, roomLeaseTermChoices(sub).map((c) => c.value)) });
          }}
        />
      </FactRow>
      {/* Prorated rent and Daily rent live on Pricing (Partial months); the room card no longer edits them. */}

      <MoreRows dataAttr="listing-v2-room-more">
        <FactRow label="Room amenities">
          <AmenityPick label={`Room amenities for ${who}`} presets={ROOM_AMENITY_PRESETS} value={amenities} onChange={(next) => onRoom({ roomAmenitiesText: next })} />
        </FactRow>
        <FactRow label="Size">
          <SizeInput who={who} value={size} inherited={false} onCommit={(n) => onRoom({ sizeSqft: n ?? undefined })} />
        </FactRow>
        <div className="px-3.5 py-2">
          <ListingMediaRow
            photos={<PhotoStrip label="room" urls={photos} onChange={(next) => onRoom({ photoDataUrls: next })} />}
            video={<VideoSlot label="room" url={video} onChange={(next) => onRoom({ videoDataUrl: next })} />}
            photoSlot={null}
            videoSlot={null}
          />
        </div>
        <CardFields>
          <Field label="Description">
            <Textarea rows={3} value={detail} placeholder="What a renter should know about this room" onChange={(e) => onRoom({ detail: e.target.value })} />
          </Field>
        </CardFields>
        <BlockedDatesSection propertyId={propertyId} roomId={room.id} managerUserId={managerUserId} />
      </MoreRows>
    </>
  );
}


/**
 * A room is its own card end to end (PLAN-0921-1648): there is no more "All
 * rooms" card and no per-field follow/reset. "Same as Room X" — the first row
 * an open card unfolds — copies another room's description onto this one
 * once, right now (`copyRoomDescriptionFrom`); its derived value is whichever
 * other room this room's description still matches
 * (`roomDescriptionMatches`). Nothing is stored about the pick.
 */
function StepRooms({
  sub,
  propertyId = null,
  patch,
  onGoToBathrooms,
  onOpenRoomChange,
}: {
  sub: ManagerListingSubmissionV1;
  propertyId?: string | null;
  patch: Patch;
  onGoToBathrooms: () => void;
  onOpenRoomChange?: (roomId: string | null) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    onOpenRoomChange?.(open);
  }, [open, onOpenRoomChange]);
  const ui = useOptionalAppUi();
  const rooms = sub.rooms ?? [];
  const baths = sub.bathrooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const noun = wholePlace ? "bedroom" : "room";
  const groundFloor = floorLevelSelectOptions(sub.listingStoriesId, "")[0] ?? "";

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
  /**
   * A hand edit, or a "Same as Room X" copy: whichever tracked fields the
   * patch names are recorded on `room.ownRoomFields`. Nothing in this step
   * reads that list back — it is kept only because it is a persisted field on
   * the record other code may still consult.
   */
  const writeRoom = (id: string, roomPatch: Partial<ManagerRoomSubmission>) => {
    const touched = (Object.keys(roomPatch) as (keyof ManagerRoomSubmission)[])
      .map((key) => ROOM_DESCRIPTION_FIELD_BY_KEY[key])
      .filter((field): field is RoomDescriptionField => Boolean(field));
    writeRooms(
      rooms.map((r) =>
        r.id === id
          ? { ...r, ...roomPatch, ...(touched.length > 0 ? { ownRoomFields: Array.from(new Set([...(r.ownRoomFields ?? []), ...touched])) } : {}) }
          : r,
      ),
    );
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
    patch({
      bathrooms: withRoomAttached(roomId).map((b) =>
        (b.assignedRoomIds ?? []).includes(roomId) ? { ...b, accessKindByRoomId: { ...(b.accessKindByRoomId ?? {}), [roomId]: next } } : b,
      ),
    });
  };
  const accessLabel = (kind: string) => BATHROOM_ACCESS_OPTIONS.find((o) => o.value === kind)?.label;

  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));

  const roomLabel = (room: ManagerRoomSubmission, i: number) => room.name.trim() || `${wholePlace ? "Bedroom" : "Room"} ${i + 1}`;
  /** "—" plus every other room's name, in card order. */
  const sameAsOptions = (room: ManagerRoomSubmission) => [
    { value: "", label: "Set for this room" },
    ...rooms.filter((r) => r.id !== room.id).map((r) => ({ value: r.id, label: `Same as ${roomLabel(r, rooms.indexOf(r))}` })),
  ];
  /**
   * The first other room this room's description still matches, or "" —
   * derived every render, never stored. A card that describes nothing yet
   * reads "—": every room is minted identical, so matching a sibling by value
   * there announces a copy that never happened.
   */
  const sameAsValue = (room: ManagerRoomSubmission) =>
    roomDescriptionIsBlank(room) ? "" : rooms.find((r) => r.id !== room.id && roomDescriptionMatches(r, room))?.id ?? "";
  const applySameAs = (room: ManagerRoomSubmission, otherId: string) => {
    if (!otherId) return;
    const source = rooms.find((r) => r.id === otherId);
    if (!source) return;
    // `copyRoomDescriptionFrom` returns a whole room; `writeRoom` takes a
    // PATCH and reads the fields it names. Narrow the result to the
    // description keys so name, availability and every price key are not
    // re-written onto themselves.
    const copied = copyRoomDescriptionFrom(source, room);
    const roomPatch: Partial<ManagerRoomSubmission> = {};
    for (const key of Object.keys(ROOM_DESCRIPTION_FIELD_BY_KEY) as (keyof ManagerRoomSubmission)[]) {
      Object.assign(roomPatch, { [key]: copied[key] });
    }
    // One patch, not two: `copyRoomBathroomLinkFrom` returns a whole submission,
    // so applying it after `writeRoom` on the same stale `sub` would overwrite
    // the description just copied. Fold the room copy in first, then the link.
    const touched = (Object.keys(roomPatch) as (keyof ManagerRoomSubmission)[])
      .map((key) => ROOM_DESCRIPTION_FIELD_BY_KEY[key])
      .filter((field): field is RoomDescriptionField => Boolean(field));
    const nextRooms = rooms.map((r) =>
      r.id === room.id
        ? { ...r, ...roomPatch, ...(touched.length > 0 ? { ownRoomFields: Array.from(new Set([...(r.ownRoomFields ?? []), ...touched])) } : {}) }
        : r,
    );
    patch(copyRoomBathroomLinkFrom({ ...sub, rooms: nextRooms }, room.id, otherId));
  };

  const factsFor = (room: ManagerRoomSubmission, i: number) => {
    const residents = room.occupancyCapacity ?? 1;
    const floorShown = room.floor || groundFloor || "Floor not set";
    const bst = roomBathroomState(sub, room.id);
    const bath = bathFactLabel(bst.mode, bst.location, bst.sharedWithRoomIds.length + 1);
    const furn = roomFurnishingLabel(roomFurnitureItems(room));
    const leasesFact = roomLeaseTermsFact(sub, room);
    return (
      <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
        {!wholePlace ? <span>{residents === 1 ? "1 resident" : `${residents} residents`}</span> : null}
        <span>{floorShown}</span>
        {bath ? <span>{bath}</span> : null}
        <span>{furn}</span>
        {leasesFact ? <span>{leasesFact}</span> : null}
      </span>
    );
  };

  const summaryFor = (room: ManagerRoomSubmission) => {
    const residents = room.occupancyCapacity ?? 1;
    // What is ticked, never an old preset phrase (nothing ticked = "Not furnished").
    const furnLabel = roomFurnishingLabel(roomFurnitureItems(room));
    const beds = room.beds ?? [];
    const bedText = roomFurnitureItems(room).length > 0 && beds.length > 0 ? bedsLine(beds).toLowerCase() : "";
    const floorShown = room.floor || groundFloor || "Floor not set";
    const parts = wholePlace
      ? [floorShown, furnLabel, bedText]
      : [
          `${residents} ${residents === 1 ? "resident" : "residents"}`,
          floorShown,
          (() => {
            const bst = roomBathroomState(sub, room.id);
            const label = bathFactLabel(bst.mode, bst.location, bst.sharedWithRoomIds.length + 1);
            return label === "No bath" ? "" : label;
          })(),
          furnLabel,
          bedText,
        ];
    return parts.filter(Boolean).join(" · ");
  };

  const addRoom = () => {
    if (rooms.length >= MAX_LISTING_ROOMS) {
      ui?.showToast("Maximum 20 rooms.");
      return;
    }
    const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const blank: ManagerRoomSubmission = { ...emptyRoom(rooms.length), id, name: "", occupancyCapacity: 1 };
    writeRooms([...rooms, blank]);
    setOpen(id);
  };

  return (
    <StepColumn>
      <div className="pr9-top mb-3 flex items-center justify-between gap-2">
        <StepHeading title={`${rooms.length} ${rooms.length === 1 ? noun : `${noun}s`}`} />
        <PortalPrimaryIconAction label={wholePlace ? "Add bedroom" : "Add room"} onClick={addRoom} data-attr="listing-v2-add-room-icon" />
      </div>

      {rooms.map((room, i) => {
        const isOpen = open === room.id;
        const label = roomLabel(room, i);
        const canRemove = rooms.length > 1 && isRoomSlotRemovable(room);
        return (
          <RecordCard
            key={room.id}
            propertyEditor
            name={room.name}
            nameLabel={`Name for room ${i + 1}`}
            namePlaceholder={`${wholePlace ? "Bedroom" : "Room"} ${i + 1}`}
            onName={(v) => writeRoom(room.id, { name: v })}
            onDuplicate={() => {
              if (rooms.length >= MAX_LISTING_ROOMS) {
                ui?.showToast("Maximum 20 rooms.");
                return;
              }
              const idx = rooms.findIndex((r) => r.id === room.id);
              const copy = duplicateRoomEntry(room);
              writeRooms([...rooms.slice(0, idx + 1), copy, ...rooms.slice(idx + 1)]);
              setOpen(copy.id);
            }}
            facts={factsFor(room, i)}
            headerEnd={
              <div className="pr9-acts flex shrink-0 items-center gap-0.5">
                <PortalRowMenu
                  label={label}
                  dataAttr="listing-v2-room-menu"
                  triggerClassName="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-foreground/[0.06]" iconClassName="h-5 w-5"
                  items={[
                    { id: "edit", label: "Edit", dataAttr: "listing-v2-room-edit", onSelect: () => toggle(room.id) },
                    {
                      id: "duplicate",
                      label: "Duplicate",
                      dataAttr: "listing-v2-room-duplicate",
                      onSelect: () => {
                        if (rooms.length >= MAX_LISTING_ROOMS) {
                          ui?.showToast("Maximum 20 rooms.");
                          return;
                        }
                        const idx = rooms.findIndex((r) => r.id === room.id);
                        const copy = duplicateRoomEntry(room);
                        writeRooms([...rooms.slice(0, idx + 1), copy, ...rooms.slice(idx + 1)]);
                        setOpen(copy.id);
                      },
                    },
                    {
                      id: "delete",
                      label: "Delete",
                      danger: true,
                      dataAttr: "listing-v2-room-delete",
                      onSelect: () => {
                        if (!canRemove) {
                          ui?.showToast(
                            rooms.length <= 1
                              ? "Keep at least one room."
                              : "Clear this room's details before deleting it.",
                          );
                          return;
                        }
                        writeRooms(rooms.filter((r) => r.id !== room.id));
                        if (open === room.id) setOpen(null);
                      },
                    },
                  ]}
                />
              </div>
            }
            open={isOpen}
            onToggle={() => toggle(room.id)}
            toggleLabel={label}
            dataAttr="listing-v2-room-card"
          >
            <div data-attr="listing-v2-room-editor">
              <ListingRoomEditorBody
                sub={sub}
                room={room}
                propertyId={propertyId}
                who={label}
                wholePlace={wholePlace}
                onPatchBathrooms={(bathrooms) => patch({ bathrooms })}
                onGoToBathrooms={onGoToBathrooms}
                onRoom={(p) => writeRoom(room.id, p)}
                onLeasesOffered={(picked) => {
                  const { listing, offeredLeaseTerms } = roomLeasesOfferedPatch(sub, picked);
                  const nextRooms = rooms.map((r) => (r.id === room.id ? { ...r, offeredLeaseTerms } : r));
                  patch(listing ? { ...listing, rooms: nextRooms } : { rooms: nextRooms });
                }}
                storiesId={sub.listingStoriesId}
                sameAsOptions={sameAsOptions(room)}
                sameAsValue={sameAsValue(room)}
                onSameAs={(id) => applySameAs(room, id)}
              />
            </div>
          </RecordCard>
        );
      })}
    </StepColumn>
  );
}


/* ─────────────────────────── step 3 · spaces ─────────────────────────── */

/* ── bathrooms ── */

/** Full, three-quarter (shower, no tub), half (toilet and sink), quarter (toilet only). */
const BATHROOM_TYPE_OPTIONS: readonly { value: BathroomType; label: string }[] = [
  { value: "full", label: "Full bath" },
  { value: "shower", label: "Three-quarter bath" },
  { value: "half", label: "Half bath" },
  { value: "quarter", label: "Quarter bath" },
];

const BATHROOM_HELP = {
  type: "Full = tub and shower. Three-quarter = shower, no tub. Half = toilet and sink. Quarter = toilet only.",
} as const;

/**
 * A bathroom is its own card end to end, the same as a room: no Default
 * bathroom card, no per-field follow/reset. "Same as Bathroom X" copies
 * another bathroom's description onto this one once (`copyBathroomDescriptionFrom`);
 * its derived value is whichever other bathroom still matches
 * (`bathroomDescriptionMatches`). Who uses it is untouched by the copy.
 */
export function ListingBathroomEditorBody({
  sub,
  bath,
  who,
  rooms,
  wholePlace,
  storiesId,
  sameAsOptions,
  sameAsValue,
  onSameAs,
  onChange,
  onPatchSubmission,
  onOpenRoom,
}: {
  sub: ManagerListingSubmissionV1;
  bath: ManagerBathroomSubmission;
  who: string;
  rooms: readonly ManagerRoomSubmission[];
  wholePlace: boolean;
  storiesId: string | undefined;
  sameAsOptions: readonly { value: string; label: string }[];
  sameAsValue: string;
  onSameAs: (bathId: string) => void;
  onChange: (patch: Partial<ManagerBathroomSubmission>) => void;
  onPatchSubmission: (next: ManagerListingSubmissionV1) => void;
  onOpenRoom?: (roomId: string) => void;
}) {
  const floors = floorLevelSelectOptions(storiesId, bath.location ?? "").map((l) => ({ value: l, label: l }));
  // A card the bathroom count made carries no floor, so the control shows the
  // listing's ground floor as its default. Display only: nothing is written
  // until the manager picks, which is what keeps an untouched card removable
  // when the count comes back down.
  const floorShown = (bath.location ?? "").trim() || floors[0]?.value || "";
  return (
    <>
      <FactRow first label="Same as">
        <RowSelectCell ariaLabel={`Same as for ${who}`} value={sameAsValue} options={sameAsOptions} placeholder="Set for this bathroom" onChange={onSameAs} />
      </FactRow>
      <BathroomEditorMirrorFields sub={sub} bath={bath} who={who} onSubmission={onPatchSubmission} />
      {!wholePlace && (bath.assignedRoomIds?.length ?? 0) > 0 ? (
        <FactRow label="Used by">
          <span className="flex flex-wrap justify-end gap-2 text-[13.5px]">
            {(bath.assignedRoomIds ?? []).map((roomId) => {
              const idx = rooms.findIndex((r) => r.id === roomId);
              const label = rooms[idx]?.name.trim() || (idx >= 0 ? `Room ${idx + 1}` : "Room");
              return onOpenRoom ? (
                <button
                  key={roomId}
                  type="button"
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                  onClick={() => onOpenRoom(roomId)}
                >
                  {label}
                </button>
              ) : (
                <span key={roomId}>{label}</span>
              );
            })}
          </span>
        </FactRow>
      ) : null}
      <FactRow label="Floor">
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={floorShown} options={floors} placeholder="Floor…" onChange={(v) => onChange({ location: v })} />
      </FactRow>
      <FactRow label={<span className="inline-flex items-center gap-1.5">Layout <ColumnHelp title="Layout" text={BATHROOM_HELP.type} /></span>}>
        <RowSelectCell
          ariaLabel={`Layout of ${who}`}
          value={bathroomTypeOf(bath)}
          options={BATHROOM_TYPE_OPTIONS}
          onChange={(v) => onChange(writeBathroomType(bath, v as BathroomType))}
        />
      </FactRow>
      <FactRow label="Finishes">
        <AmenityPick label={`Finishes for ${who}`} presets={BATHROOM_EXTRA_AMENITY_PRESETS} value={bath.amenitiesText ?? ""} onChange={(next) => onChange({ amenitiesText: next })} />
      </FactRow>
      <MoreRows dataAttr="listing-v2-bath-more">
        <CardFields>
          <Field label="Description">
            <Textarea rows={2} value={bath.detail ?? ""} placeholder="What a renter should know about this bathroom" onChange={(e) => onChange({ detail: e.target.value })} />
          </Field>
        </CardFields>
        <div className="px-3.5 py-2">
          <ListingMediaRow
            photos={<PhotoStrip label="bathroom" urls={bath.photoDataUrls ?? []} onChange={(next) => onChange({ photoDataUrls: next })} />}
            video={<VideoSlot label="bathroom" url={bath.videoDataUrl} onChange={(next) => onChange({ videoDataUrl: next })} />}
          />
        </div>
      </MoreRows>
    </>
  );
}

function StepBathrooms({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [open, setOpen] = useState<string | null>(null);
  const ui = useOptionalAppUi();
  const baths = sub.bathrooms ?? [];
  const rooms = sub.rooms ?? [];
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const groundFloor = floorLevelSelectOptions(sub.listingStoriesId, "")[0] ?? "";

  const writeBath = (id: string, next: ManagerBathroomSubmission) => patch({ bathrooms: baths.map((b) => (b.id === id ? next : b)) });
  const patchBath = (bath: ManagerBathroomSubmission, p: Partial<ManagerBathroomSubmission>) => writeBath(bath.id, { ...bath, ...p });
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
  const bathLabel = (bath: ManagerBathroomSubmission, i: number) => bath.name.trim() || `Bathroom ${i + 1}`;
  /** "—" plus every other bathroom's name, in card order. */
  const sameAsOptions = (bath: ManagerBathroomSubmission) => [
    { value: "", label: "Set for this bathroom" },
    ...baths.filter((b) => b.id !== bath.id).map((b) => ({ value: b.id, label: `Same as ${bathLabel(b, baths.indexOf(b))}` })),
  ];
  /**
   * The first other bathroom this bathroom's description still matches, or ""
   * — derived every render, never stored. A card that describes nothing yet
   * reads "—", for the same reason rooms do.
   */
  const sameAsValue = (bath: ManagerBathroomSubmission) =>
    bathroomSetupIsBlank(bath) ? "" : baths.find((b) => b.id !== bath.id && bathroomSetupMatches(b, bath))?.id ?? "";
  const applySameAs = (bath: ManagerBathroomSubmission, otherId: string) => {
    if (!otherId) return;
    const source = baths.find((b) => b.id === otherId);
    if (!source) return;
    writeBath(bath.id, copyBathroomSetupFrom(source, bath));
  };

  const typeLabel = (bath: ManagerBathroomSubmission) => BATHROOM_TYPE_OPTIONS.find((o) => o.value === bathroomTypeOf(bath))?.label ?? "";
  const whoUsesFact = (bath: ManagerBathroomSubmission) => {
    if (wholePlace) return "";
    const assigned = bath.assignedRoomIds ?? [];
    if (bath.allResidents || (assigned.length > 0 && assigned.length === rooms.length)) return "Every room";
    if (assigned.length === 0) return "No rooms yet";
    if (assigned.length === 1) {
      const roomId = assigned[0]!;
      const idx = rooms.findIndex((r) => r.id === roomId);
      const name = rooms[idx]?.name.trim() || (idx >= 0 ? `Room ${idx + 1}` : "Room");
      const kind = bath.accessKindByRoomId?.[roomId];
      if (kind === "ensuite") return `Private to ${name}`;
      if (kind === "hall") return `Private to ${name}`;
      return `Shared · ${name}`;
    }
    return `Shared by ${assigned.length} rooms`;
  };
  const factsFor = (bath: ManagerBathroomSubmission) => {
    const floorShown = bath.location || groundFloor || "Floor not set";
    const type = typeLabel(bath);
    const who = whoUsesFact(bath);
    return (
      <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
        <span>{floorShown}</span>
        {type ? <span>{type}</span> : null}
        {who ? <span>{who}</span> : null}
      </span>
    );
  };

  const addBathroom = () => {
    if (baths.length >= MAX_LISTING_BATHROOMS) {
      ui?.showToast("Maximum 12 bathrooms.");
      return;
    }
    const id = `bath-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const blank = writeBathroomType({ ...emptyBathroom(baths.length), id, name: "" }, "full");
    patch({ bathrooms: [...baths, blank] });
    setOpen(id);
  };

  return (
    <StepColumn>
      <div className="pr9-top mb-3 flex items-center justify-between gap-2">
        <StepHeading title={`${baths.length} ${baths.length === 1 ? "bathroom" : "bathrooms"}`} />
        <PortalPrimaryIconAction label="Add bathroom" onClick={addBathroom} data-attr="listing-v2-add-bath-icon" />
      </div>

      {baths.map((bath, i) => {
        const isOpen = open === bath.id;
        const label = bathLabel(bath, i);
        const canRemove = baths.length > 1 && isBathroomSlotRemovable(bath);
        return (
          <RecordCard
            key={bath.id}
            propertyEditor
            name={bath.name}
            nameLabel={`Name for bathroom ${i + 1}`}
            namePlaceholder={`Bathroom ${i + 1}`}
            onName={(v) => writeBath(bath.id, { ...bath, name: v })}
            onDuplicate={() => {
              if (baths.length >= MAX_LISTING_BATHROOMS) {
                ui?.showToast("Maximum 12 bathrooms.");
                return;
              }
              const idx = baths.findIndex((b) => b.id === bath.id);
              const copy = duplicateBathroomEntry(bath);
              patch({ bathrooms: [...baths.slice(0, idx + 1), copy, ...baths.slice(idx + 1)] });
              setOpen(copy.id);
            }}
            facts={factsFor(bath)}
            headerEnd={
              <div className="pr9-acts flex shrink-0 items-center gap-0.5">
                <PortalRowMenu
                  label={label}
                  dataAttr="listing-v2-bath-menu"
                  triggerClassName="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-foreground/[0.06]" iconClassName="h-5 w-5"
                  items={[
                    { id: "edit", label: "Edit", dataAttr: "listing-v2-bath-edit", onSelect: () => toggle(bath.id) },
                    {
                      id: "duplicate",
                      label: "Duplicate",
                      dataAttr: "listing-v2-bath-duplicate",
                      onSelect: () => {
                        if (baths.length >= MAX_LISTING_BATHROOMS) {
                          ui?.showToast("Maximum 12 bathrooms.");
                          return;
                        }
                        const idx = baths.findIndex((b) => b.id === bath.id);
                        const copy = duplicateBathroomEntry(bath);
                        patch({ bathrooms: [...baths.slice(0, idx + 1), copy, ...baths.slice(idx + 1)] });
                        setOpen(copy.id);
                      },
                    },
                    {
                      id: "delete",
                      label: "Delete",
                      danger: true,
                      dataAttr: "listing-v2-bath-delete",
                      onSelect: () => {
                        if (!canRemove) {
                          ui?.showToast(
                            baths.length <= 1
                              ? "Keep at least one bathroom."
                              : "Take this bathroom off its rooms and clear its details before deleting it.",
                          );
                          return;
                        }
                        patch({ bathrooms: baths.filter((b) => b.id !== bath.id) });
                        if (open === bath.id) setOpen(null);
                      },
                    },
                  ]}
                />
              </div>
            }
            open={isOpen}
            onToggle={() => toggle(bath.id)}
            toggleLabel={label}
            dataAttr="listing-v2-bath-card"
          >
            <div data-attr="listing-v2-bath-editor">
              <ListingBathroomEditorBody
                sub={sub}
                bath={bath}
                who={label}
                rooms={rooms}
                wholePlace={wholePlace}
                storiesId={sub.listingStoriesId}
                sameAsOptions={sameAsOptions(bath)}
                sameAsValue={sameAsValue(bath)}
                onSameAs={(id) => applySameAs(bath, id)}
                onChange={(p) => patchBath(bath, p)}
                onPatchSubmission={(next) => patch({ bathrooms: next.bathrooms, rooms: next.rooms })}
              />
            </div>
          </RecordCard>
        );
      })}
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
export function ListingSharedSpaceEditorBody({
  space,
  who,
  rooms,
  wholePlace,
  storiesId,
  onChange,
  sameAsOptions,
  sameAsValue,
  onSameAs,
}: {
  space: ManagerSharedSpaceSubmission;
  who: string;
  rooms: readonly ManagerRoomSubmission[];
  wholePlace: boolean;
  storiesId: string | undefined;
  onChange: (patch: Partial<ManagerSharedSpaceSubmission>) => void;
  sameAsOptions?: readonly { value: string; label: string }[];
  sameAsValue?: string;
  onSameAs?: (spaceId: string) => void;
}) {
  const kinds = SHARED_SPACE_KIND_OPTIONS.map((o) => ({ value: o.id, label: o.label }));
  const roomLabel = (r: ManagerRoomSubmission, i: number) => r.name.trim() || `Room ${i + 1}`;
  const roomIds = rooms.map((room) => room.id);
  const accessEveryone = sharedSpaceIsEveryone(space.roomAccessIds, roomIds);
  const [roomPickerOpen, setRoomPickerOpen] = useState(() => !accessEveryone);
  const whoUsesMode = roomPickerOpen ? "pick" : "all";
  return (
    <>
      {sameAsOptions && sameAsOptions.length > 1 ? (
        <FactRow first label="Same as">
          <RowSelectCell
            ariaLabel={`Same as for ${who}`}
            value={sameAsValue ?? ""}
            options={sameAsOptions}
            placeholder="Set for this space"
            onChange={(id) => onSameAs?.(id)}
          />
        </FactRow>
      ) : (
        <FactRow first label="Type">
          <RowSelectCell ariaLabel={`Type of ${who}`} value={space.spaceKind ?? ""} options={kinds} placeholder="Type…" onChange={(v) => onChange({ spaceKind: v as ManagerSharedSpaceSubmission["spaceKind"] })} />
        </FactRow>
      )}
      {sameAsOptions && sameAsOptions.length > 1 ? (
        <FactRow label="Type">
          <RowSelectCell ariaLabel={`Type of ${who}`} value={space.spaceKind ?? ""} options={kinds} placeholder="Type…" onChange={(v) => onChange({ spaceKind: v as ManagerSharedSpaceSubmission["spaceKind"] })} />
        </FactRow>
      ) : null}
      <FactRow label="Floor">
        <RowSelectCell ariaLabel={`Floor for ${who}`} value={space.location ?? ""} options={floorLevelSelectOptions(storiesId, space.location).map((l) => ({ value: l, label: l }))} placeholder="Floor…" onChange={(v) => onChange({ location: v })} />
      </FactRow>
      {wholePlace || rooms.length === 0 ? null : (
        <>
          <FactRow label={<span className="inline-flex items-center gap-1.5">Who uses it <ColumnHelp title="Who uses it" text={SPACE_HELP.who} /></span>}>
            <RowSelectCell
              ariaLabel={`Who uses ${who}`}
              value={whoUsesMode}
              options={[
                { value: "all", label: "All rooms" },
                { value: "pick", label: "Select rooms" },
              ]}
              onChange={(mode) => {
                if (mode === "all") {
                  setRoomPickerOpen(false);
                  onChange({ roomAccessIds: encodeSharedSpaceEveryone() });
                  return;
                }
                setRoomPickerOpen(true);
                if (sharedSpaceIsEveryone(space.roomAccessIds, roomIds)) {
                  onChange({ roomAccessIds: [...roomIds] });
                }
              }}
            />
          </FactRow>
          {roomPickerOpen ? (
            <FactRow label="Rooms">
              <CheckboxMultiSelect
                hideLabel
                label={`Rooms for ${who}`}
                dataAttr="listing-v2-space-who"
                variant="cell"
                className="min-w-[150px] max-w-[240px]"
                options={sharedSpaceAccessOptions(rooms.map((room, i) => ({ id: room.id, name: roomLabel(room, i) })))}
                selected={sharedSpaceAccessMenuSelected(space.roomAccessIds, roomIds)}
                selectionTriggerLabel={sharedSpaceAccessTriggerLabel(space.roomAccessIds, roomIds)}
                emptyLabel="Pick rooms"
                onChange={(next) => {
                  const nextIds = encodeSharedSpaceAccessPick({
                    nextSelected: next,
                    roomIds,
                    previousAccessIds: space.roomAccessIds,
                  });
                  if (sharedSpaceIsEveryone(nextIds, roomIds)) {
                    setRoomPickerOpen(false);
                  }
                  onChange({ roomAccessIds: nextIds });
                }}
              />
            </FactRow>
          ) : null}
        </>
      )}
      <FactRow label="Description">
        <Textarea className="max-w-[280px]" rows={2} value={space.detail ?? ""} onChange={(e) => onChange({ detail: e.target.value })} placeholder="Sunny room off the kitchen, seats six" />
      </FactRow>
      <div className="px-3.5 py-2">
        <ListingMediaRow
          photos={<PhotoStrip label="shared space" urls={space.photoDataUrls ?? []} onChange={(next) => onChange({ photoDataUrls: next })} />}
          video={<VideoSlot label="shared space" url={space.videoDataUrl} onChange={(next) => onChange({ videoDataUrl: next })} />}
        />
      </div>
      <MoreRows dataAttr="listing-v2-space-more">
        <FactRow label="What is in it">
          <AmenityPick label={`What is in ${who}`} presets={sharedSpaceAmenityPresetsForKind(space.spaceKind)} value={space.amenitiesText ?? ""} onChange={(next) => onChange({ amenitiesText: next })} />
        </FactRow>
        <FactRow label={space.spaceKind === "outdoor" ? "Lot size" : "Size"}>
          <SizeInput who={who} value={space.sizeSqft ?? 0} inherited={false} onCommit={(n) => onChange({ sizeSqft: n ?? undefined })} />
        </FactRow>
      </MoreRows>
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
  const groundFloor = floorLevelSelectOptions(sub.listingStoriesId, "")[0] ?? "";

  const writeSpace = (id: string, next: ManagerSharedSpaceSubmission) => patch({ sharedSpaces: spaces.map((sp) => (sp.id === id ? next : sp)) });
  const patchSpace = (space: ManagerSharedSpaceSubmission, p: Partial<ManagerSharedSpaceSubmission>) => writeSpace(space.id, { ...space, ...p });
  const toggle = (id: string) => setOpen((prev) => (prev === id ? null : id));
  const spaceLabel = (space: ManagerSharedSpaceSubmission, _i: number) => sharedSpaceTitle(space);
  const sameAsOptions = (space: ManagerSharedSpaceSubmission) => [
    { value: "", label: "Set for this space" },
    ...spaces.filter((s) => s.id !== space.id).map((s) => ({ value: s.id, label: `Same as ${spaceLabel(s, spaces.indexOf(s))}` })),
  ];
  const sameAsValue = (space: ManagerSharedSpaceSubmission) =>
    sharedSpaceSetupIsBlank(space) ? "" : spaces.find((s) => s.id !== space.id && sharedSpaceSetupMatches(s, space))?.id ?? "";
  const applySameAs = (space: ManagerSharedSpaceSubmission, otherId: string) => {
    if (!otherId) return;
    const source = spaces.find((s) => s.id === otherId);
    if (!source) return;
    writeSpace(space.id, copySharedSpaceSetupFrom(source, space));
  };
  const factsFor = (space: ManagerSharedSpaceSubmission) => {
    // The type is a fact only when it says something the title does not: "Other" never does.
    const kindLabel = space.spaceKind && space.spaceKind !== "other" ? SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === space.spaceKind)?.label : undefined;
    const type = kindLabel && kindLabel.toLowerCase() !== sharedSpaceTitle(space).toLowerCase() ? kindLabel : undefined;
    const floorShown = space.location || groundFloor || "Floor not set";
    const who = wholePlace
      ? ""
      : sharedSpaceAccessTriggerLabel(space.roomAccessIds, rooms.map((r) => r.id));
    return (
      <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
        {type ? <span>{type}</span> : null}
        <span>{floorShown}</span>
        {who ? <span>{who}</span> : null}
      </span>
    );
  };

  const addSpace = (kind?: ManagerSharedSpaceSubmission["spaceKind"]) => {
    const id = `space-${crypto.randomUUID()}`;
    const blank: ManagerSharedSpaceSubmission = {
      id,
      // A type other than Other names the space; Other leaves the name for the manager (the card reads "Shared space").
      name: kind && kind !== "other" ? (SHARED_SPACE_KIND_OPTIONS.find((o) => o.id === kind)?.label ?? "") : "",
      spaceKind: kind,
      location: groundFloor,
      detail: "",
      amenitiesText: "",
      photoDataUrls: [],
      videoDataUrl: null,
      roomAccessIds: encodeSharedSpaceEveryone(),
    };
    patch({ sharedSpaces: [...spaces, blank] });
    setOpen(id);
  };

  return (
    <StepColumn>
      <div className="pr9-top mb-3 flex items-center justify-between gap-2">
        <StepHeading title={`${spaces.length} shared ${spaces.length === 1 ? "space" : "spaces"}`} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PortalPrimaryIconAction label="Add shared space" data-attr="listing-v2-add-space-icon" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SHARED_SPACE_KIND_OPTIONS.map((opt) => (
              <DropdownMenuItem key={opt.id} onClick={() => addSpace(opt.id)}>
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {spaces.map((space, i) => {
        const isOpen = open === space.id;
        const label = spaceLabel(space, i);
        return (
          <RecordCard
            key={space.id}
            propertyEditor
            name={cleanSharedSpaceName(space.name)}
            nameLabel={`Name for shared space ${i + 1}`}
            namePlaceholder={label}
            onName={(v) => writeSpace(space.id, { ...space, name: v })}
            facts={factsFor(space)}
            headerEnd={
              <div className="pr9-acts flex shrink-0 items-center gap-0.5">
                <PortalRowMenu
                  label={label}
                  dataAttr="listing-v2-space-menu"
                  triggerClassName="grid h-11 w-11 place-items-center rounded-md text-muted hover:bg-foreground/[0.06]" iconClassName="h-5 w-5"
                  items={[
                    { id: "edit", label: "Edit", dataAttr: "listing-v2-space-edit", onSelect: () => toggle(space.id) },
                    {
                      id: "duplicate",
                      label: "Duplicate",
                      dataAttr: "listing-v2-space-duplicate",
                      onSelect: () => {
                        const idx = spaces.findIndex((s) => s.id === space.id);
                        const copy = duplicateSharedSpaceEntry(space);
                        patch({ sharedSpaces: [...spaces.slice(0, idx + 1), copy, ...spaces.slice(idx + 1)] });
                        setOpen(copy.id);
                      },
                    },
                    {
                      id: "delete",
                      label: "Delete",
                      danger: true,
                      dataAttr: "listing-v2-space-delete",
                      onSelect: () => {
                        patch({ sharedSpaces: spaces.filter((s) => s.id !== space.id) });
                        if (open === space.id) setOpen(null);
                      },
                    },
                  ]}
                />
              </div>
            }
            open={isOpen}
            onToggle={() => toggle(space.id)}
            toggleLabel={label}
            dataAttr="listing-v2-space-card"
          >
            <div data-attr="listing-v2-space-editor">
              <ListingSharedSpaceEditorBody
                key={space.id}
                space={space}
                who={label}
                rooms={rooms}
                wholePlace={wholePlace}
                storiesId={sub.listingStoriesId}
                onChange={(p) => patchSpace(space, p)}
                sameAsOptions={sameAsOptions(space)}
                sameAsValue={sameAsValue(space)}
                onSameAs={(id) => applySameAs(space, id)}
              />
            </div>
          </RecordCard>
        );
      })}
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
  return (
    <>
      <HouseStripePaymentsGroup sub={sub} patch={patch} />
      <HouseRentDueAndLateFeesGroup sub={sub} patch={patch} />
    </>
  );
}

const RENT_DUE_OPTIONS = [
  { value: "first_of_month", label: "1st of the month" },
  { value: "last_of_month", label: "Last day of the month" },
] as const;

const LATE_FEE_GRACE_OPTIONS = Array.from({ length: 31 }, (_, days) => ({
  value: String(days),
  label: days === 1 ? "1 day" : `${days} days`,
}));

/**
 * Rent due day and automatic late fees — the same `ManagerListingSubmissionV1`
 * fields the Pricing gear's pop-up used to edit (the gear is gone). A change
 * stamps the field as this property's own (`paymentSettingsScope`), exactly as
 * that pop-up did; the stamp is what the property record's Pricing tab reads to
 * name a row's scope and to offer the way back to the workspace default.
 */
function HouseRentDueAndLateFeesGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const own = (field: PaymentSettingsField, next: Partial<ManagerListingSubmissionV1>) =>
    patch(markPaymentFieldOwn({ ...sub, ...next }, field));
  const lateFeesOn = sub.lateFeeEnabled !== false;
  return (
    <>
      <FactRow label="Rent due">
        <RowSelectCell
          ariaLabel="Rent due"
          value={sub.rentDueDayMode ?? "first_of_month"}
          options={RENT_DUE_OPTIONS}
          dataAttr="listing-v2-rent-due-day"
          onChange={(v) => own("rentDueDayMode", { rentDueDayMode: v === "last_of_month" ? "last_of_month" : "first_of_month" })}
        />
      </FactRow>
      <div className="border-t border-border px-3.5 py-1">
        <CheckboxOption
          label="Automatic late fees"
          checked={lateFeesOn}
          onChange={(next) => own("lateFeeEnabled", { lateFeeEnabled: next })}
        />
      </div>
      {lateFeesOn ? (
        <>
          <FactRow sub label="Late fee amount">
            <MoneyInput
              label="Late fee amount"
              value={(sub.lateFeeAmount ?? "50").replace(/^\$/, "").trim()}
              placeholder="50"
              dataAttr="listing-v2-late-fee-amount"
              onChange={(raw) => own("lateFeeAmount", { lateFeeAmount: sanitizeMoneyInput(raw) })}
            />
          </FactRow>
          <FactRow sub label="Grace days">
            <RowSelectCell
              ariaLabel="Grace days"
              value={String(sub.lateFeeGraceDays ?? 5)}
              options={LATE_FEE_GRACE_OPTIONS}
              dataAttr="listing-v2-late-fee-grace-days"
              onChange={(v) => own("lateFeeGraceDays", { lateFeeGraceDays: Math.max(0, Math.min(30, Number(v) || 0)) })}
            />
          </FactRow>
        </>
      ) : null}
    </>
  );
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
                patch(
                  markPaymentFieldOwn(
                    {
                      ...sub,
                      serviceFeePayer: v as ManagerListingSubmissionV1["serviceFeePayer"],
                      serviceFeeWaiverCode: undefined,
                      paymentSettingsScope: {
                        ...(sub.paymentSettingsScope ?? {}),
                        serviceFeeWaiverCode: undefined,
                      },
                    },
                    "serviceFeePayer",
                  ),
                )
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
                  onChange={(e) =>
                    patch(
                      markPaymentFieldOwn(
                        { ...sub, serviceFeeWaiverCode: normalizeListingPaymentWaiverCode(e.target.value) || undefined },
                        "serviceFeeWaiverCode",
                      ),
                    )
                  }
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
/** Property Payments tab and unit tests — pricing left the listing wizard rail (studio redesign 0929). */
export function ListingPricingWorkspace({
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
            <LeaseTermsField sub={sub} onPatch={patch} />
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
  const withPhotos = rooms.filter((r) => (r.photoDataUrls ?? []).length > 0);
  return [
    { id: "address", label: "Address confirmed", state: sub.address.trim() ? "done" : "todo" },
    {
      id: "rooms",
      label: rooms.length === 0 ? "Add at least one room" : `${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}`,
      state: rooms.length > 0 ? "done" : "todo",
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
    ...(sub.serviceFeePayer === "proplane" && !isProcessingCoverageCodeShape(sub.serviceFeeWaiverCode)
      ? [{
          id: "processing",
          label: "Add a promo code so PropLane can cover processing",
          state: "warn" as const,
        }]
      : []),
  ];
}

/** Which step closes a given readiness gap. */
const READINESS_STEP: Record<string, (typeof LISTING_V2_STEPS)[number]["id"]> = {
  address: "basics",
  description: "basics",
  rooms: "rooms",
  photos: "rooms",
};


/** Everything Zillow's Rental Network feed needs that this listing does not have yet. */
function zillowSyndicationGapStep(sub: ManagerListingSubmissionV1): (typeof LISTING_V2_STEPS)[number]["id"] | null {
  if (!listingSyndicationHasStreetAddress(sub.address)) return "basics";
  if (listingSyndicationPhotoUrls(sub).length === 0) return "rooms";
  return null;
}

function ZillowSyndicationRow({
  sub,
  patch,
  onJump,
  contact,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  onJump: (stepId: (typeof LISTING_V2_STEPS)[number]["id"]) => void;
  contact?: ListingContactDoors;
}) {
  const zillow = sub.syndication?.zillow;
  const gapStep = zillowSyndicationGapStep(sub);
  const title = sub.tagline?.trim() || sub.address?.trim() || "Listing";

  const setEnabled = (next: boolean) => {
    patch({
      syndication: {
        ...sub.syndication,
        zillow: next
          ? { enabled: true, sentAt: new Date().toISOString(), status: "sent" }
          : { ...zillow, enabled: false },
      },
    });
    track("listing_syndication_toggle", { network: "zillow", enabled: next });
  };

  const resend = () => {
    if (!zillow?.enabled) return;
    patch({
      syndication: {
        ...sub.syndication,
        zillow: { ...zillow, enabled: true, sentAt: new Date().toISOString(), status: "sent" },
      },
    });
    track("listing_syndication_resend", { network: "zillow" });
  };

  return (
    <SectionGroup title="Listing sites">
      <ZillowRentalNetworkRow
        propertyTitle={title}
        sub={sub}
        listingStatus="draft"
        workPhone={contact?.phone}
        workEmail={contact?.email}
        onToggle={setEnabled}
        onResend={resend}
        onStop={() => setEnabled(false)}
        onEdit={gapStep ? () => onJump(gapStep) : undefined}
        dataAttrPrefix="listing-v2-review-zillow"
      />
    </SectionGroup>
  );
}

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

/** Review lists the four leasing steps like the others, with an Edit door each. None is required. */
const REVIEW_LEASING_ROWS: ReadonlyArray<{ id: ListingDetailStepId; label: string }> = [
  { id: "application", label: "Application" },
  { id: "lease", label: "Lease" },
  { id: "movein", label: "Move-in" },
  { id: "pricing", label: "Pricing" },
];

function StepReview({
  sub,
  patch,
  onJump,
  contact,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** Take the manager to the step that closes a gap, rather than describing it. */
  onJump: (stepId: (typeof LISTING_V2_STEPS)[number]["id"]) => void;
  contact?: ListingContactDoors;
}) {
  const checks = listingReadiness(sub);
  const detailSummaries = listingDetailSummaries(sub);
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
      <div className="mt-6 max-w-[620px]" data-attr="listing-v2-review-leasing">
        <b className="text-[13px] font-bold text-foreground">Leasing</b>
        <ul className="mt-2 overflow-hidden rounded-2xl border border-border bg-card">
          {REVIEW_LEASING_ROWS.map((row, index) => (
            <li
              key={row.id}
              className={`flex min-h-[52px] items-center gap-2.5 px-3.5 py-2 text-[13px] ${index === 0 ? "" : "border-t border-border"}`}
              data-attr={`listing-v2-review-leasing-${row.id}`}
            >
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">{row.label}</span>
              <span className="shrink-0 text-muted">{detailSummaries[row.id]}</span>
              <button
                type="button"
                onClick={() => onJump(row.id)}
                data-attr={`listing-v2-review-edit-${row.id}`}
                aria-label={`Edit ${row.label}`}
                className="shrink-0 rounded-full border border-border bg-card px-3 py-1 text-[12.5px] font-bold text-foreground hover:bg-accent/40"
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-6 max-w-[620px]">
        <ZillowSyndicationRow sub={sub} patch={patch} onJump={onJump} contact={contact} />
      </div>
    </StepColumn>
  );
}

/* ─────────────────────────── orchestrator ─────────────────────────── */

const hasPositiveMoney = (value: string | number | undefined | null): boolean => {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(/[,$\s]/g, ""));
  return Number.isFinite(amount) && amount > 0;
};

/**
 * Publish asks whether the manager has an offering a renter can actually take.
 * Pricing is term-scoped: a short-stay rate cannot make a long-term-only
 * listing publishable, and a price stored on a disabled term is not an offer.
 */
function hasOfferedListingRent(submission: ManagerListingSubmissionV1): boolean {
  const offeredTerms = listingPricingLeaseTabs(submission).map(listingPricingTabToLeaseTerm);
  const rooms = submission.rooms ?? [];
  const defaults = houseDefaultsForSubmission(submission);

  return offeredTerms.some((term) => {
    if (isEntireHomeListing(submission)) return entireHomeMonthlyRentAmount(submission) > 0;

    if (isStayLeaseTerm(term)) {
      return rooms.some(
        (room) =>
          roomHasStayOffer(room) ||
          (roomInheritsDefault(room, defaults, "shortTermRent") && hasPositiveMoney(defaults.shortTermRent)) ||
          (roomInheritsDefault(room, defaults, "weeklyRentPrice") && hasPositiveMoney(defaults.weeklyRentPrice)),
      );
    }

    return rooms.some((room) => {
      const termDefault = submission.houseTermPricing?.[term]?.monthlyRent;
      return (
        hasPositiveMoney(room.termPricing?.[term]?.monthlyRent) ||
        (hasPositiveMoney(termDefault) && roomFollowsTermDefault(room, term, "monthlyRent", submission.houseTermPricing)) ||
        hasPositiveMoney(room.monthlyRent) ||
        (roomInheritsDefault(room, defaults, "monthlyRent") && hasPositiveMoney(defaults.monthlyRent)) ||
        (room.rentBasis === "daily" && hasPositiveMoney(room.dailyRentPrice)) ||
        (room.rentBasis === "weekly" && hasPositiveMoney(room.weeklyRentPrice))
      );
    });
  });
}

export function ListingEditorV2({
  submission,
  propertyId = null,
  onChange,
  onClose,
  onPublish,
  onStepChange,
  title,
  busy = false,
  actionError,
  isEdit = false,
  saveState,
  leadingStep,
  headerCenter,
  basicsLead,
  initialStep,
  contact,
  workspacePricingDefaults,
  onOpenPricing,
  managerUserId = null,
  showToast,
  ensureSaved,
  onOpenSettings,
  headerUpload,
  onDiscardDraft,
}: {
  submission: ManagerListingSubmissionV1;
  /**
   * The pop-up's ONE "Start from a file" card, drawn at the top of the first step (Upload file, Take photo,
   * Scan). Picking a file jumps to Basics first, where that step's strip shows the reading or the
   * "Replace what you typed?" confirm, then hands the file to `onPick`. Absent on an edit.
   */
  headerUpload?: Pick<WorkspaceHeaderUploadProps, "accept" | "onPick" | "disabled" | "extraItems" | "chips">;
  /**
   * Footer Delete on a NEW property: the host forgets the draft (after the confirm drawn here) and closes.
   * Without it, or on an edit, the footer has no Delete.
   */
  onDiscardDraft?: () => void | Promise<unknown>;
  /**
   * What the Application, Lease, Move-in and Pricing steps need to open the property's own
   * editors ("Edit in full"). `ensureSaved` saves the wizard and resolves the record id, so a
   * brand-new draft is saved on demand; `onOpenSettings` saves, leaves and opens Settings.
   */
  managerUserId?: string | null;
  showToast?: (message: string) => void;
  ensureSaved?: () => Promise<string | null>;
  onOpenSettings?: (href: string) => void;
  workspacePricingDefaults?: WorkspacePricingDefaults;
  /**
   * Rent is not a wizard field: it is set on the property's Pricing tab. When the
   * host can take the manager there (it saves first), a Publish refused for a
   * missing rent offers that door instead of sending them to a step that has no
   * rent to type. Without it the refusal keeps its old Rooms jump.
   */
  onOpenPricing?: () => void | Promise<void>;
  /** The listing's record id when it already has one — booked rows on the Rooms step need it. Null for a brand-new listing. */
  propertyId?: string | null;
  onChange: (next: ManagerListingSubmissionV1) => void;
  /** Explicitly save the current step without closing the editor. */
  onSave?: (stepIndex: number) => unknown;
  /** @deprecated Compatibility for callers that have not moved to `onSave`. */
  onSaveExit?: (stepIndex: number) => unknown;
  /** Receives the step the manager left on, so a flush can keep the resume point. */
  onClose: (stepIndex: number) => void;
  /** Keep the parent's autosave resume point in sync while they stay in the editor. */
  onStepChange?: (stepIndex: number) => void;
  onPublish: () => void | Promise<boolean>;
  title: string;
  busy?: boolean;
  actionError?: string | null;
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
  /** Open on this listing step — Import jumps to Rooms / Review without walking Basics. */
  initialStep?: ListingV2StepId;
  /** The doors a renter reaches the manager through, shown on Review. */
  contact?: ListingContactDoors;
}) {
  const [publishError, setPublishError] = useState<string | null>(null);
  /** Where the refusal is fixed, when that is not a step of this wizard. */
  const [publishFix, setPublishFix] = useState<"pricing" | null>(null);
  useEffect(() => {
    setPublishError(null);
    setPublishFix(null);
  }, [submission]);

  const confirmAction = useConfirm();
  /** Steps the manager pressed Next on — the progress bar turns one red when it still had something missing. */
  const [attemptedSteps, setAttemptedSteps] = useState<ReadonlySet<number>>(new Set());
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
  const [previewRoomId, setPreviewRoomId] = useState<string | null>(null);
  /** The id a first save minted, for a draft that had none when the editor opened. */
  const [savedRecordId, setSavedRecordId] = useState<string | null>(null);
  const appUi = useOptionalAppUi();
  const recordId = propertyId?.trim() || savedRecordId;
  const detailDoors: ListingDetailDoors = {
    recordId,
    mode: isEdit ? "listing" : "draft",
    managerUserId,
    ensureSaved: ensureSaved
      ? async () => {
          const id = await ensureSaved();
          if (id) setSavedRecordId(id);
          return id;
        }
      : undefined,
    showToast: showToast ?? ((message: string) => appUi?.showToast(message)),
    onOpenSettings,
    workspacePricingDefaults,
  };
  // Bathrooms and Floors on Basics follow the lists (like Bedrooms follows Rooms): the screen
  // shows what the lists add up to, and the stored counters are rewritten from them when the
  // manager edits (never merely on open).
  const patch: Patch = (next) => onChange(syncListingBasicsFromLists({ ...submission, ...next }));
  const last = LISTING_V2_STEPS.length - 1;
  const stepId = LISTING_V2_STEPS[step]!.id;

  const goTo = (index: number) => {
    const target = LISTING_V2_STEPS[Math.max(0, Math.min(last, index))]!;
    setStep(LISTING_V2_STEPS.indexOf(target));
    setVisited((prev) => (prev.has(target.id) ? prev : new Set(prev).add(target.id)));
  };

  const publishBlocker = () => {
    const focus = (stepId: ListingV2StepId, selector: string, message: string, fix: "pricing" | null = null) => ({ stepId, selector, message, fix });
    if (!submission.address.trim()) return focus("basics", 'input[autocomplete="street-address"]', "Add a street address before publishing.");
    if (!submission.city.trim()) return focus("basics", '[data-wizard-field="city"]', "Add a city before publishing.");
    if (!validateStateAbbrev(submission.state).ok) return focus("basics", '[data-wizard-field="state"]', "Add a valid two-letter state before publishing.");
    if (!isValidZipInput(submission.zip)) return focus("basics", '[data-wizard-field="zip"]', "Add a valid ZIP before publishing.");
    if (!submission.listingPlaceCategoryId) return focus("basics", '[data-attr="listing-v2-rent-model-shared"]', "Choose how you rent this home before publishing.");
    const pricingBlock = listingV2PublishPricingBlocker(submission, workspacePricingDefaults ?? {});
    if (pricingBlock) {
      // A missing rent is satisfied on Pricing, never on Rooms; a missing lease type is Rooms' "Leases offered".
      const priceFix = pricingBlock !== PUBLISH_BLOCKER_RENT || !onOpenPricing ? null : "pricing";
      return focus("rooms", '[data-attr="listing-v2-rooms"]', pricingBlock, priceFix);
    }
    if (submission.serviceFeePayer === "proplane" && submission.serviceFeeWaiverCode && !isProcessingCoverageCodeShape(submission.serviceFeeWaiverCode)) {
      return focus("basics", '[data-attr="listing-v2-service-fee-code"]', "Enter a valid promo code before publishing.");
    }
    return null;
  };

  const publishFromCurrentStep = async (): Promise<boolean> => {
    const blocker = publishBlocker();
    if (blocker) {
      setPublishError(blocker.message);
      setPublishFix(blocker.fix);
      if (blocker.fix === "pricing") return false;
      goTo(LISTING_V2_STEPS.findIndex((candidate) => candidate.id === blocker.stepId));
      requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(blocker.selector)?.focus()));
      return false;
    }
    setPublishError(null);
    setPublishFix(null);
    return (await onPublish()) !== false;
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
            onGoToBathrooms={() => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === "bathrooms"))}
            onOpenRoomChange={setPreviewRoomId}
          />
        );
      case "bathrooms":
        return <StepBathrooms sub={submission} patch={patch} />;
      case "spaces":
        return <StepSharedSpaces sub={submission} patch={patch} />;
      case "application":
        return <StepApplication sub={submission} onChange={onChange} doors={detailDoors} />;
      case "lease":
        return <StepLease sub={submission} onChange={onChange} doors={detailDoors} />;
      case "movein":
        return <StepMoveIn sub={submission} onChange={onChange} doors={detailDoors} />;
      case "pricing":
        return <StepPricing sub={submission} onChange={onChange} doors={detailDoors} />;
      default:
        return (
          <StepReview
            sub={submission}
            patch={patch}
            onJump={(id) => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === id))}
            contact={contact}
          />
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, submission, defaults, isEdit, basicsLead, contact, recordId, managerUserId, ensureSaved, onOpenSettings, workspacePricingDefaults]);

  /**
   * The right-hand panel for this step.
   *
   * Every step has one. A step that had nothing worth showing would be a sign
   * the step itself is wrong, not a reason for an empty column.
   */
  const sidePanel = useMemo(() => {
    const preview = <ListingPreviewPanel sub={submission} highlightRoomId={stepId === "rooms" ? previewRoomId : null} />;
    if (stepId === "application" || stepId === "lease" || stepId === "movein" || stepId === "pricing") {
      return (
        <>
          <ListingDetailSummaryPanel sub={submission} current={stepId} />
          {preview}
        </>
      );
    }
    return preview;
  }, [stepId, submission, previewRoomId]);

  const onNext = () => {
    setAttemptedSteps((prev) => new Set(prev).add(step + railOffset));
    if (nextStep != null) goTo(nextStep);
  };
  const deleteDraft = () => {
    if (busy || !onDiscardDraft) return;
    void confirmAction({
      title: "Delete this property?",
      description: "The draft and everything typed so far is deleted. This can't be undone.",
      confirmLabel: "Delete",
      note: null,
      tone: "danger",
      guard: "tap",
      dataAttr: "listing-v2-delete-confirm",
    }).then((ok) => {
      if (ok) void onDiscardDraft();
    });
  };

  return (
    <WorkspaceHeaderUploadPresent.Provider value={Boolean(headerUpload) && !isEdit}>
    <ListingWorkspace
      title={title}
      closeDisabled={busy}
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
      headerAside={
        <>
          <ModalAssistantStrip contextHint={assistantContext} storageScopeKey="listing-wizard-v2" />
        </>
      }
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
      previewInEye
      footer={
        <>
          {publishError || actionError ? (
            <p role="alert" className="basis-full text-[13px] font-semibold text-destructive" data-testid="listing-v2-persistence-error">
              {publishError ?? actionError}
              {publishError && publishFix === "pricing" && onOpenPricing ? (
                <>
                  {" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onOpenPricing()}
                    data-attr="listing-v2-open-pricing"
                    className="font-bold text-primary underline underline-offset-2 disabled:opacity-45"
                  >
                    Set rent in Pricing
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
          <WizardFooterActions
            hasPrev={prevStep != null || Boolean(leadingStep)}
            hasNext={nextStep != null}
            lastLabel={isEdit ? "Save" : "Create property"}
            busy={busy}
            dataAttrPrefix="listing-v2"
            nextDataAttr="listing-v2-next"
            finishDataAttr="listing-v2-publish"
            nextAriaLabel={nextStep != null ? `Next: ${LISTING_V2_STEPS[nextStep]!.label}` : undefined}
            onBack={() => {
              if (prevStep != null) goTo(prevStep);
              else leadingStep?.onOpen();
            }}
            onNext={onNext}
            onFinish={() => void publishFromCurrentStep()}
            onDelete={onDiscardDraft && !isEdit ? deleteDraft : undefined}
            deleteDataAttr="listing-v2-delete"
          />
        </>
      }
    >
      <WizardStepProgress steps={railSteps} current={step + railOffset} attempted={attemptedSteps} />
      {headerUpload && !isEdit && step === 0 ? (
        <WorkspaceFileCard
          accept={headerUpload.accept}
          chips={headerUpload.chips}
          disabled={busy || headerUpload.disabled}
          dataAttr="listing-v2-header-upload"
          inputDataAttr="import-upload-file-input"
          extraItems={headerUpload.extraItems}
          onPick={(file) => {
            goTo(0);
            headerUpload.onPick(file);
          }}
        />
      ) : null}
      {body}
    </ListingWorkspace>
    </WorkspaceHeaderUploadPresent.Provider>
  );
}
