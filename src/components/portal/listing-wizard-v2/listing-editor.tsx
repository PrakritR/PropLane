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

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Input, Select, Textarea } from "@/components/ui/input";
import { InlineCheckboxGroup } from "@/components/ui/inline-checkbox-group";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { uploadListingImageFiles } from "@/lib/listing-media-client";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { buildListingModalAssistantContext } from "@/lib/listing-assistant-context";
import { DoorOpen, Bath, LayoutGrid } from "lucide-react";
import {
  BATHROOM_EXTRA_AMENITY_PRESETS,
  HOUSE_WIDE_AMENITY_PRESETS,
  LISTING_PROPERTY_TYPE_OPTIONS,
  LISTING_STORIES_OPTIONS,
  LISTING_TOTAL_BATH_OPTIONS,
  ROOM_AMENITY_PRESETS,
  SHARED_SPACE_KIND_OPTIONS,
  floorLevelSelectOptions,
  sharedSpaceAmenityPresetsForKind,
  listingAmenityLinesFromValue,
} from "@/data/manager-listing-presets";
import {
  emptyCustomFeeRow,
  emptyQuickFactRow,
  formatLeaseTermsBodyFromAllowed,
  resolveAllowedLeaseTerms,
  syncAirbnbLeaseTermInAllowed,
  syncShortTermLeaseTermInAllowed,
  type ManagerListingSubmissionV1,
  type ManagerBathroomRoomAccessKind,
  type ManagerBathroomSubmission,
  type ManagerCustomFeeRow,
  type ManagerRoomSubmission,
  type ManagerSharedSpaceSubmission,
  LONG_TERM_LENGTH_CHOICES,
  normalizeLongTermLengths,
} from "@/lib/manager-listing-submission";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LONG_TERM_LEASE_TERM,
  LEASE_TERM_CHOICES,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { LONG_TERM_UTILITIES_PAYMENT_OPTIONS } from "@/lib/listing-utilities-payment";
import {
  derivedRoomCharges,
  suggestionPlaceholder,
} from "@/lib/listing-room-derived-pricing";
import { applyListingBedroomSlots } from "@/lib/manager-listing-submission";
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
  roomOverriddenDefaults,
  roomsFollowingDefaults,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  AddRowButton,
  BulkButton,
  CheckboxOption,
  Field,
  FieldRow,
  AdvancedGroup,
  AdvancedPanel,
  Row,
  RowBulkBar,
  RowCell,
  RowList,
  RowSelectCell,
  rowTemplate,
  SideBelow,
  StepColumn,
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

/** How a room reaches its bathroom. Mirrors ManagerBathroomRoomAccessKind. */
const BATHROOM_ACCESS_OPTIONS = [
  { value: "ensuite", label: "En-suite" },
  { value: "shared", label: "Shared" },
  { value: "hall", label: "Down the hall" },
] as const;

type Patch = (next: Partial<ManagerListingSubmissionV1>) => void;

/**
 * Lets a step tell the footer that a detail pane is open, so the footer's Back
 * button returns to the list instead of leaving the step entirely.
 *
 * A manager who opens Room 3, looks at it, and presses the only Back button on
 * screen means "back to the rooms" — the wizard's own Back had been taking them
 * to Home, losing the place they were in.
 */
const DetailBackContext = createContext<(close: (() => void) | null) => void>(() => {});

function useDetailBack(open: boolean, close: () => void) {
  const register = useContext(DetailBackContext);
  const closeRef = useRef(close);
  // Written in an effect, not during render: a ref read or written while
  // rendering is not safe under concurrent rendering.
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    register(() => closeRef.current());
    return () => register(null);
  }, [open, register]);
}

/* ─────────────────────── shared little helpers ─────────────────────── */

function money(value: string | undefined): string {
  return (value ?? "").replace(/^\$/, "");
}

/**
 * A money field's value, where zero shows as EMPTY against a "0" placeholder.
 *
 * A charge a manager has not filled in yet reads as blank; "0" typed into the
 * box by the form itself looks like a decision they made. The stored value is
 * untouched — this only decides what the box displays.
 */
function moneyBlankIfZero(value: string | undefined): string {
  const text = money(value).trim();
  return text === "" || Number(text.replace(/[^0-9.]/g, "")) === 0 ? "" : text;
}

/**
 * Amenities as one searchable multi-select rather than forty chips.
 *
 * The chip wall needed a "+ 33 more" to fit, so most of the list was invisible
 * and there was no way to look for one by name. The stored shape is unchanged —
 * newline-separated labels — and any CUSTOM line a manager typed elsewhere is
 * preserved untouched, because this control can only ever add or remove the
 * presets it knows about.
 */
function AmenityChips({
  presets,
  value,
  onChange,
  label = "Amenities",
}: {
  presets: readonly { id: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  label?: string;
}) {
  const lines = listingAmenityLinesFromValue(value);
  const labels = presets.map((p) => p.label);
  const selected = lines.filter((l) => labels.includes(l));
  const custom = lines.filter((l) => !labels.includes(l));
  // The approved design shows every amenity as a visible checkbox, with one
  // "Other" field for anything the catalogue lacks. Stored shape is unchanged:
  // newline-separated labels, presets in catalogue order, custom lines after.
  return (
    <div className="space-y-2">
      <InlineCheckboxGroup
        hideLabel
        label={label}
        columns={3}
        options={presets.map((p) => ({ value: p.label, label: p.label }))}
        selected={selected}
        dataAttr="amenity"
        onChange={(next) => {
          const picked = new Set(next);
          onChange([...labels.filter((l) => picked.has(l)), ...custom].join("\n"));
        }}
      />
      <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
        Other (one per line)
        <textarea
          className="mt-1 min-h-[44px] w-full rounded-xl border border-border bg-card px-3 py-2 text-sm font-normal normal-case tracking-normal text-foreground"
          value={custom.join("\n")}
          placeholder="Anything not listed above"
          data-attr="amenity-other"
          onChange={(e) => {
            const extra = e.target.value.split("\n").map((l) => l.trim()).filter((l) => l && !labels.includes(l));
            onChange([...labels.filter((l) => selected.includes(l)), ...extra].join("\n"));
          }}
        />
      </label>
    </div>
  );
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
}: {
  urls: string[];
  onChange: (next: string[]) => void;
  max?: number;
  label: string;
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
              className="h-16 w-20 rounded-lg border border-border object-cover"
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
      <p className="mt-1.5 text-[12px] text-muted">
        {urls.length} of {max} added.
      </p>
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
}: {
  url: string | null | undefined;
  onChange: (next: string | null) => void;
  label: string;
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
            <video src={url} className="h-16 w-20 rounded-lg border border-border object-cover" />
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
      <p className="mt-1.5 text-[12px] text-muted">One short clip, around 14 MB.</p>
    </div>
  );
}

/* ─────────────────────────── step 1 · basics ─────────────────────────── */

function StepBasics({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const roomCount = sub.rooms?.length || sub.listingBedroomSlots || 1;
  return (
    <StepColumn>
      <StepHeading
        title="The home itself"
        subtitle="Where it is, what it is, and how it reads to a renter."
      />

      {/*
       * How you rent it comes FIRST because it changes every screen after it —
       * whether rent is per room or set once, and whether the Rooms step is
       * about bedrooms or about one household.
       */}
      <Field label="How you rent it" required hint="Decides whether rent is set per room or once for the whole place.">
        <Select
          value={rentByRoom ? "shared_home" : "entire_home"}
          data-attr="listing-v2-rent-model"
          onChange={(e) => {
            const id = e.target.value === "entire_home" ? "entire_home" : "shared_home";
            patch({ listingPlaceCategoryId: id, rentalModelStamp: id });
          }}
        >
          <option value="shared_home">By the room</option>
          <option value="entire_home">The whole place</option>
        </Select>
      </Field>

      <Field label="Street address" required hint="Start typing and pick the match to refill city, state and ZIP.">
        <ListingAddressAutocomplete
          value={sub.address}
          onChange={(next) => patch({ address: next })}
          onSelect={(suggestion) =>
            patch({
              address: suggestion.address || suggestion.label,
              city: suggestion.city || sub.city,
              state: suggestion.state || sub.state,
              zip: suggestion.zip || sub.zip,
              neighborhood: suggestion.neighborhood || sub.neighborhood,
            })
          }
        />
      </Field>
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
        <Field label="Neighborhood" optional>
          <Input value={sub.neighborhood} onChange={(e) => patch({ neighborhood: e.target.value })} />
        </Field>
      </FieldRow>
      <Field label="Property name" optional hint="What you call this home internally. The headline is what renters see.">
        <Input
          value={sub.buildingName}
          placeholder={sub.address || "Magnolia House"}
          onChange={(e) => patch({ buildingName: e.target.value })}
        />
      </Field>

      <FieldRow cols={4}>
        <Field label="Property type" required>
          <Select
            value={sub.listingPropertyTypeId ?? ""}
            onChange={(e) => patch({ listingPropertyTypeId: e.target.value })}
          >
            <option value="">Select…</option>
            {LISTING_PROPERTY_TYPE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Floors" required>
          <Select value={sub.listingStoriesId ?? ""} onChange={(e) => patch({ listingStoriesId: e.target.value })}>
            <option value="">Select…</option>
            {LISTING_STORIES_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bathrooms" required hint="Including half baths.">
          <Select
            value={sub.listingTotalBathroomsId ?? ""}
            onChange={(e) => patch({ listingTotalBathroomsId: e.target.value })}
          >
            <option value="">Select…</option>
            {LISTING_TOTAL_BATH_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={rentByRoom ? "Bedrooms to rent" : "Bedrooms"} required hint="One row per room next.">
          <Select
            value={String(roomCount)}
            onChange={(e) => {
              const next = Number(e.target.value) || 1;
              const applied = applyListingBedroomSlots({ ...sub, listingBedroomSlots: next }, next);
              // A refusal means the count could not be honoured; keep the rooms
              // the manager has rather than writing a number they do not match.
              patch(applied.ok ? { ...applied.sub, listingBedroomSlots: next } : { listingBedroomSlots: next });
            }}
          >
            {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
      </FieldRow>

      {/*
       * The headline and description come straight after the address, not at
       * the bottom under a fold. They are what a renter actually reads, and
       * they used to sit below a "listing name" field that asked the same
       * question in duller words.
       */}
      <Field label="Headline" optional hint="The title renters see. Leave blank to use the address.">
        <Input
          value={sub.tagline}
          onChange={(e) => patch({ tagline: e.target.value })}
          placeholder="Spacious 3-bedroom house near UW"
        />
      </Field>
      <Field label="Description" optional>
        <Textarea
          rows={4}
          value={sub.houseOverview}
          onChange={(e) => patch({ houseOverview: e.target.value })}
          placeholder="Describe the home and who it suits…"
        />
      </Field>

      <p className="mb-3 mt-6 text-[13px] font-bold text-foreground">Media</p>
      <FieldRow cols={2}>
        <Field label="Photos of the whole house" optional hint="Up to 12. Rooms and bathrooms have their own.">
          <PhotoStrip
            label="house"
            max={12}
            urls={sub.housePhotoDataUrls ?? []}
            onChange={(next) => patch({ housePhotoDataUrls: next })}
          />
        </Field>
        <Field label="Video of the whole house" optional>
          <VideoSlot label="house" url={sub.houseVideoDataUrl} onChange={(next) => patch({ houseVideoDataUrl: next })} />
        </Field>
      </FieldRow>

      <p className="mb-3 mt-6 text-[13px] font-bold text-foreground">Amenities</p>
      <Field label="What the whole house has" hint="Rooms have their own list; this is what everyone shares.">
        <AmenityChips
          presets={HOUSE_WIDE_AMENITY_PRESETS}
          value={sub.amenitiesText}
          onChange={(next) => patch({ amenitiesText: next })}
        />
      </Field>
      <Field label="Pets" hint="The first thing a renter with a dog looks for.">
        <Select
          value={sub.petFriendly ? "yes" : "no"}
          onChange={(e) => patch({ petFriendly: e.target.value === "yes" })}
        >
          <option value="no">No pets</option>
          <option value="yes">Pets allowed, subject to approval</option>
        </Select>
      </Field>

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

/** What a furnished room usually comes with. Stored as the free-text `furnishing` line. */
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
 * Furnishing: a yes/no, and then what is included.
 *
 * The record keeps one free-text line, which is what the listing prints, so
 * this control writes the chosen items back into that same line and leaves any
 * wording the manager typed themselves alone. Unfurnished is the default, and
 * clearing the box empties the line rather than leaving a list nobody will get.
 */
function FurnishingField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const text = (value ?? "").trim();
  const furnished = text.length > 0;
  const parts = text
    .split(/[,\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const known = FURNISHING_ITEMS.filter((i) => parts.some((p) => p.toLowerCase() === i.toLowerCase()));
  const custom = parts.filter((p) => !FURNISHING_ITEMS.some((i) => i.toLowerCase() === p.toLowerCase()));
  return (
    /*
     * The tick and the list sit on one line: the list only exists because the
     * box is ticked, and stacking them left the box looking like a heading
     * above an unrelated field.
     */
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex shrink-0 cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          checked={furnished}
          data-attr="listing-v2-room-furnished"
          onChange={(e) => onChange(e.target.checked ? [...FURNISHING_ITEMS.slice(0, 3)].join(", ") : "")}
          className="h-4 w-4 shrink-0 rounded border-border"
        />
        <span className="text-[13px] font-semibold text-foreground">Furnished</span>
      </label>
      <div className="min-w-[200px] flex-1">
        {furnished ? (
          <CheckboxMultiSelect
            hideLabel
            label="What is included"
            options={FURNISHING_ITEMS.map((i) => ({ value: i, label: i }))}
            selected={[...known]}
            emptyLabel="Choose what is included…"
            onChange={(next) => onChange([...FURNISHING_ITEMS.filter((i) => next.includes(i)), ...custom].join(", "))}
          />
        ) : (
          <span className="text-[12px] text-muted">Unfurnished unless you tick the box.</span>
        )}
      </div>
    </div>
  );
}

/**
 * The charges a manager adds themselves, for ONE lease type.
 *
 * A charge names the types it is billed on, so the same table appears inside
 * each card holding only that card's rows. A charge written before the field
 * existed names nothing, which means every type — so a listing already saved
 * keeps billing exactly what it billed.
 *
 * Rows have column headings rather than a "Charge 1" label on every field: it
 * is a table, and numbering each one read as if the order mattered.
 */
function LeaseTypeCharges({
  leaseType,
  sub,
  patch,
}: {
  leaseType: string;
  sub: ManagerListingSubmissionV1;
  patch: Patch;
}) {
  const all = sub.customFees ?? [];
  const appliesHere = (fee: ManagerCustomFeeRow) => !fee.leaseTypes?.length || fee.leaseTypes.includes(leaseType);
  const rows = all.filter(appliesHere);
  const write = (id: string, patchRow: Partial<ManagerCustomFeeRow>) =>
    patch({ customFees: all.map((f) => (f.id === id ? { ...f, ...patchRow } : f)) });
  return (
    <div className="mt-4">
      <p className="mb-2 text-[12.5px] font-bold text-foreground">Other charges on this lease</p>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-[1fr_130px_140px_36px] items-center gap-2 border-b border-border bg-accent/25 px-3 py-2">
          <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-muted">Charge</span>
          <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-muted">Amount</span>
          <span className="text-[10.5px] font-extrabold uppercase tracking-wide text-muted">How often</span>
          <span />
        </div>
        <div className="grid grid-cols-[1fr_130px_140px_36px] items-center gap-2 border-b border-border px-3 py-2">
          <button
            type="button"
            data-attr={`listing-v2-add-charge-${leaseType}`}
            onClick={() =>
              patch({ customFees: [...all, { ...emptyCustomFeeRow(), leaseTypes: [leaseType] }] })
            }
            className="justify-self-start text-[12.5px] font-bold text-primary"
          >
            + Add a charge
          </button>
          <span />
          <span />
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-muted">Nothing extra on this lease type.</p>
        ) : null}
        {rows.map((fee) => (
          <div
            key={fee.id}
            className="grid grid-cols-[1fr_130px_140px_36px] items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
          >
            <Input
              aria-label="Charge name"
              value={fee.label}
              placeholder="Parking space"
              onChange={(e) => write(fee.id, { label: e.target.value })}
            />
            <Input
              aria-label="Charge amount"
              value={moneyBlankIfZero(fee.amount)}
              placeholder="0"
              onChange={(e) => write(fee.id, { amount: e.target.value })}
            />
            <Select
              aria-label="How often the charge is billed"
              value={fee.frequency ?? "monthly"}
              onChange={(e) => write(fee.id, { frequency: e.target.value as ManagerCustomFeeRow["frequency"] })}
            >
              <option value="monthly">Monthly</option>
              <option value="one-time">One-time</option>
            </Select>
            <button
              type="button"
              aria-label={`Remove ${fee.label || "charge"}`}
              onClick={() => patch({ customFees: all.filter((f) => f.id !== fee.id) })}
              className="justify-self-center text-[13px] text-muted hover:text-foreground"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Utilities and the application fee, asked inside each lease type's card. */
function LeaseTypeSharedFields({
  room,
  set,
  defaults,
  sub,
  patch,
  byNight = false,
}: {
  room: ManagerRoomSubmission;
  set: (patch: Partial<ManagerRoomSubmission>) => void;
  defaults: ListingHouseDefaults;
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  /** A short stay is counted in nights, so its utilities are quoted per day. */
  byNight?: boolean;
}) {
  return (
    <FieldRow cols={3}>
      {/*
       * How utilities are handled is asked BEFORE the amount, because it
       * decides what the amount means: a figure billed to the resident, or an
       * estimate shown to them, or nothing at all if it is folded into rent.
       */}
      <Field label="How utilities are handled">
        <Select
          value={room.utilitiesPaymentModel ?? ""}
          onChange={(e) => set({ utilitiesPaymentModel: e.target.value as ManagerRoomSubmission["utilitiesPaymentModel"] })}
        >
          <option value="">Select…</option>
          {LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {byNight ? (
        <Field label="Utilities / day" optional hint="A stay under a month is counted in nights.">
          <Input
            value={room.dailyUtilitiesRate ? String(room.dailyUtilitiesRate) : ""}
            inputMode="numeric"
            placeholder="5"
            onChange={(e) => set({ dailyUtilitiesRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
          />
        </Field>
      ) : (
        <Field label="Utilities / month" optional>
          <Input
            value={moneyBlankIfZero(room.utilitiesEstimate)}
            placeholder={defaults.utilitiesEstimate || "80"}
            onChange={(e) => set({ utilitiesEstimate: e.target.value })}
          />
        </Field>
      )}
      <Field label="Application fee">
        <Input value={moneyBlankIfZero(sub.applicationFee)} onChange={(e) => patch({ applicationFee: e.target.value })} />
      </Field>
    </FieldRow>
  );
}

function RoomDetail({
  room,
  sub,
  patch,
  defaults,
  onChange,
  onBack,
}: {
  room: ManagerRoomSubmission;
  sub: ManagerListingSubmissionV1;
  /** Writes to the LISTING — the lease types a room is let on live there. */
  patch: Patch;
  defaults: ListingHouseDefaults;
  onChange: (next: ManagerRoomSubmission) => void;
  onBack: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>("room");
  const toggleGroup = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  const set = (patch: Partial<ManagerRoomSubmission>) => onChange({ ...room, ...patch });
  const inheritsRent = roomInheritsDefault(room, defaults, "monthlyRent");
  const effectiveRent = room.monthlyRent > 0 ? room.monthlyRent : defaults.monthlyRent;
  const suggested = derivedRoomCharges(effectiveRent);
  const rates = roomRateVisibility(sub);

  return (
    <StepColumn>
      <p className="mb-2 text-[12px] font-bold text-muted">Room</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {room.name.trim() || "Room"}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        The room itself, how it is let, what it costs, and moving in.
      </p>

      <AdvancedPanel
        summary="The room · Leasing · Pricing · Move-in"
        open
        onToggle={() => undefined}
        dataAttr="listing-v2-room-advanced"
      >
        <AdvancedGroup
          title="The room"
          description="Beds · size · furnishing · amenities · photos and video · description"
          open={openGroup === "room"}
          onToggle={() => toggleGroup("room")}
          dataAttr="listing-v2-room-basics"
        >
          <FieldRow cols={2}>
            <Field label="Beds in the room" optional hint="What is physically in there. Shown on the listing.">
              <Select
                value={room.bedCount ? String(room.bedCount) : ""}
                onChange={(e) => set({ bedCount: Number(e.target.value) || undefined })}
              >
                <option value="">Not stated</option>
                {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Residents allowed"
              hint="How many people may hold a lease here at once. This is the figure occupancy is enforced against."
            >
              <Select
                value={String(room.occupancyCapacity ?? 1)}
                onChange={(e) => set({ occupancyCapacity: Number(e.target.value) || 1 })}
              >
                {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Size" optional>
              <Input
                value={room.sizeSqft ? String(room.sizeSqft) : ""}
                inputMode="numeric"
                placeholder="sq ft"
                onChange={(e) => set({ sizeSqft: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
              />
            </Field>
          </FieldRow>
          <Field group label="Furnishing">
            <FurnishingField value={room.furnishing ?? ""} onChange={(next) => set({ furnishing: next })} />
          </Field>
          <Field label="Room amenities">
            <AmenityChips
              presets={ROOM_AMENITY_PRESETS}
              value={room.roomAmenitiesText ?? ""}
              onChange={(next) => set({ roomAmenitiesText: next })}
            />
          </Field>
          <FieldRow cols={2}>
            <Field label="Photos of this room" optional>
              <PhotoStrip label="room" urls={room.photoDataUrls ?? []} onChange={(next) => set({ photoDataUrls: next })} />
            </Field>
            <Field label="Video of this room" optional>
              <VideoSlot label="room" url={room.videoDataUrl} onChange={(next) => set({ videoDataUrl: next })} />
            </Field>
          </FieldRow>
          <Field label="Room description" optional hint="Shown on the public listing under this room.">
            <Textarea
              rows={3}
              value={room.detail ?? ""}
              onChange={(e) => set({ detail: e.target.value })}
              placeholder="Corner room, two windows facing the garden…"
            />
          </Field>
        </AdvancedGroup>

        <AdvancedGroup
          title="Leasing"
          description="Which lease types this room is let on — and therefore which prices it needs"
          open={openGroup === "lease"}
          onToggle={() => toggleGroup("lease")}
          dataAttr="listing-v2-room-lease"
        >
          <Field
            label="Lease types offered"
            hint="Set for the whole listing — the application flow reads this list, so a room cannot offer a type the listing does not. Pricing below follows what you pick."
          >
            <LeaseTypesField sub={sub} patch={patch} />
          </Field>
        </AdvancedGroup>

        <AdvancedGroup
          title="Pricing"
          description="Rent and rates · deposit · move-in fee · utilities · prorated rent · flexible or fixed · extra charges"
          open={openGroup === "payments"}
          onToggle={() => toggleGroup("payments")}
          dataAttr="listing-v2-room-payments"
        >
          {/*
           * Pricing follows the lease types on offer: a card per type, each
           * holding the prices that type actually needs. A room let long-term
           * has no nightly rate to fill in, and a nightly stay has no partial
           * month to split — showing both to everyone is what made this screen
           * a wall of fields nobody could read.
           */}
          <Field
            label="Fixed or flexible"
            hint="Flexible advertises the same price and tells a renter it can be discussed — the assistant may negotiate."
          >
            <Select
              value={room.pricingMode ?? "fixed"}
              onChange={(e) => set({ pricingMode: e.target.value as ManagerRoomSubmission["pricingMode"] })}
            >
              <option value="fixed">Fixed — this is the price</option>
              <option value="flexible">Flexible — open to an offer</option>
            </Select>
          </Field>


          {!rates.monthly && !rates.shortTerm && !rates.airbnb ? (
            <p className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-[12.5px] leading-relaxed text-muted">
              No lease types are offered yet, so there is nothing to price. Choose them under
              <span className="font-bold text-foreground"> Leasing</span> above and the matching prices appear here.
            </p>
          ) : null}

          {/*
           * A card per lease type on offer, in the order a manager thinks of
           * them. The three monthly terms share ONE monthly rent — that is how
           * the record works — so the first card on screen carries it and the
           * others say plainly that they use it, with only the surcharge that
           * makes them different. Two rent boxes would be two numbers that
           * could disagree, and only one of them is ever billed.
           */}
          {rates.longTerm ? (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-[13px] font-bold text-foreground">Long-term</p>
              <p className="mb-3 mt-0.5 text-[12px] text-muted">
                A month or more from the 1st. The monthly figure here is the one every monthly term uses.
              </p>
              <FieldRow cols={3}>
                <Field
                  label="Rent / month"
                  hint={inheritsRent && defaults.monthlyRent > 0 ? `Following the top row: $${defaults.monthlyRent}.` : undefined}
                >
                  <Input
                    value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                    inputMode="numeric"
                    placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
                    onChange={(e) => set({ monthlyRent: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                  />
                </Field>
                <Field
                  label="Security deposit"
                  optional
                  hint={suggested ? `Suggested ${suggested.securityDeposit} — check your local cap.` : undefined}
                >
                  <Input
                    value={money(room.securityDeposit)}
                    placeholder={defaults.securityDeposit || suggestionPlaceholder(suggested?.securityDeposit)}
                    onChange={(e) => set({ securityDeposit: e.target.value })}
                  />
                </Field>
                <Field label="Move-in fee" optional>
                  <Input
                    value={money(room.moveInFee)}
                    placeholder={defaults.moveInFee || suggestionPlaceholder(suggested?.moveInFee)}
                    onChange={(e) => set({ moveInFee: e.target.value })}
                  />
                </Field>
              </FieldRow>
              <LeaseTypeSharedFields room={room} set={set} defaults={defaults} sub={sub} patch={patch} />
              <LeaseTypeCharges leaseType={LONG_TERM_LEASE_TERM} sub={sub} patch={patch} />
            </div>
          ) : null}

          {rates.custom ? (
            <div className="mt-3 rounded-xl border border-border bg-card p-4">
              <p className="text-[13px] font-bold text-foreground">Custom</p>
              <p className="mb-3 mt-0.5 text-[12px] text-muted">
                A month or more starting on some other day, so it is the monthly rent plus a partial first month.
              </p>
              {!rates.longTerm ? (
                <FieldRow cols={3}>
                  <Field label="Rent / month">
                    <Input
                      value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                      inputMode="numeric"
                      placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
                      onChange={(e) => set({ monthlyRent: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                    />
                  </Field>
                  <Field label="Security deposit" optional>
                    <Input
                      value={money(room.securityDeposit)}
                      placeholder={defaults.securityDeposit || suggestionPlaceholder(suggested?.securityDeposit)}
                      onChange={(e) => set({ securityDeposit: e.target.value })}
                    />
                  </Field>
                  <Field label="Move-in fee" optional>
                    <Input
                      value={money(room.moveInFee)}
                      placeholder={defaults.moveInFee || suggestionPlaceholder(suggested?.moveInFee)}
                      onChange={(e) => set({ moveInFee: e.target.value })}
                    />
                  </Field>
                </FieldRow>
              ) : null}
              <FieldRow cols={3}>
                <Field
                  label="Custom-term surcharge / month"
                  optional
                  hint="Set for the whole listing. Extra rent on a term that does not start on the 1st."
                >
                  <Input
                    value={money(sub.customLeaseSurcharge)}
                    onChange={(e) => patch({ customLeaseSurcharge: e.target.value })}
                  />
                </Field>
                <Field label="Prorate the partial month">
                  <Select
                    value={room.prorateMethod ?? "auto"}
                    onChange={(e) => set({ prorateMethod: e.target.value as ManagerRoomSubmission["prorateMethod"] })}
                  >
                    <option value="auto">Work it out automatically</option>
                    <option value="daily_rate">Set a per-day rate</option>
                  </Select>
                </Field>
                <Field label="Prorated rent / day" optional>
                  <Input
                    value={room.dailyRentRate ? String(room.dailyRentRate) : ""}
                    inputMode="numeric"
                    placeholder={suggestionPlaceholder(suggested?.dailyRent)}
                    onChange={(e) => set({ dailyRentRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
                  />
                </Field>
              </FieldRow>
              <LeaseTypeSharedFields room={room} set={set} defaults={defaults} sub={sub} patch={patch} />
              <LeaseTypeCharges leaseType={CUSTOM_LEASE_TERM} sub={sub} patch={patch} />
            </div>
          ) : null}

          {rates.monthToMonth ? (
            <div className="mt-3 rounded-xl border border-border bg-card p-4">
              <p className="text-[13px] font-bold text-foreground">Month to month</p>
              <p className="mb-3 mt-0.5 text-[12px] text-muted">
                Rolls on until either side ends it. Priced off the same monthly rent, plus a surcharge if you charge one.
              </p>
              {!rates.longTerm && !rates.custom ? (
                <FieldRow cols={3}>
                  <Field label="Rent / month">
                    <Input
                      value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                      inputMode="numeric"
                      placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
                      onChange={(e) => set({ monthlyRent: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
                    />
                  </Field>
                  <Field label="Security deposit" optional>
                    <Input
                      value={money(room.securityDeposit)}
                      placeholder={defaults.securityDeposit || suggestionPlaceholder(suggested?.securityDeposit)}
                      onChange={(e) => set({ securityDeposit: e.target.value })}
                    />
                  </Field>
                  <Field label="Move-in fee" optional>
                    <Input
                      value={money(room.moveInFee)}
                      placeholder={defaults.moveInFee || suggestionPlaceholder(suggested?.moveInFee)}
                      onChange={(e) => set({ moveInFee: e.target.value })}
                    />
                  </Field>
                </FieldRow>
              ) : null}
              <Field
                label="Month-to-month surcharge / month"
                optional
                hint="Set for the whole listing. Extra rent for the flexibility of no fixed end date."
              >
                <Input
                  value={money(sub.monthToMonthSurcharge)}
                  onChange={(e) => patch({ monthToMonthSurcharge: e.target.value })}
                />
              </Field>
              <LeaseTypeSharedFields room={room} set={set} defaults={defaults} sub={sub} patch={patch} />
              <LeaseTypeCharges leaseType="Month-to-Month" sub={sub} patch={patch} />
            </div>
          ) : null}

          {rates.shortTerm ? (
            <div className="mt-3 rounded-xl border border-border bg-card p-4">
              <p className="text-[13px] font-bold text-foreground">Short-term</p>
              <p className="mb-3 mt-0.5 text-[12px] text-muted">Under a month, so it is priced by the week or night.</p>
              <FieldRow cols={2}>
                <Field label="Rent / week" optional hint={suggested ? `Suggested ${suggested.weeklyRent}.` : undefined}>
                  <Input
                    value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""}
                    placeholder={suggestionPlaceholder(suggested?.weeklyRent)}
                    inputMode="numeric"
                    onChange={(e) => set({ weeklyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
                  />
                </Field>
                <Field label="Rent / night" optional hint={suggested ? `Suggested ${suggested.dailyRent}.` : undefined}>
                  <Input
                    value={money(room.shortTermRent)}
                    placeholder={suggestionPlaceholder(suggested?.dailyRent)}
                    onChange={(e) => set({ shortTermRent: e.target.value })}
                  />
                </Field>
              </FieldRow>
              <FieldRow cols={2}>
                <Field label="Deposit" optional>
                  <Input value={money(room.shortTermDeposit)} onChange={(e) => set({ shortTermDeposit: e.target.value })} />
                </Field>
                <Field label="Move-in fee" optional>
                  <Input
                    value={money(room.shortTermMoveInFee)}
                    onChange={(e) => set({ shortTermMoveInFee: e.target.value })}
                  />
                </Field>
              </FieldRow>
              <LeaseTypeSharedFields room={room} set={set} defaults={defaults} sub={sub} patch={patch} byNight />
              <LeaseTypeCharges leaseType={SHORT_TERM_LEASE_TERM} sub={sub} patch={patch} />
            </div>
          ) : null}

          {rates.airbnb ? (
            <div className="mt-3 rounded-xl border border-dashed border-border bg-card p-4">
              <p className="text-[13px] font-bold text-foreground">Airbnb</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                Nothing to price. An Airbnb stay is booked and paid for on Airbnb, so PropLane raises no rent charge —
                it is here only so the resident is tracked through your listing like any other.
              </p>
            </div>
          ) : null}

        </AdvancedGroup>

        <AdvancedGroup
          title="Move-in"
          description="When it is free · instructions · entry photos · arrival clip · move-in and move-out checklists"
          open={openGroup === "movein"}
          onToggle={() => toggleGroup("movein")}
          dataAttr="listing-v2-room-movein"
        >
          <Field label="Available from" optional hint="Leave blank if it is free now.">
            <Input
              value={room.moveInAvailableDate ?? ""}
              placeholder="1 Oct 2026"
              onChange={(e) => set({ moveInAvailableDate: e.target.value })}
            />
          </Field>
          <Field label="Move-in instructions" optional>
            <Textarea
              rows={3}
              value={room.moveInInstructions ?? ""}
              onChange={(e) => set({ moveInInstructions: e.target.value })}
              placeholder="Door code, key box, which entrance to use…"
            />
          </Field>
          <FieldRow cols={2}>
            <Field label="Entry photos" optional hint="The key box, the bins, which door.">
              <PhotoStrip
                label="entry"
                urls={room.moveInPhotoDataUrls ?? []}
                onChange={(next) => set({ moveInPhotoDataUrls: next })}
              />
            </Field>
            <Field label="Arrival clip" optional>
              <VideoSlot label="arrival" url={room.moveInVideoDataUrl} onChange={(next) => set({ moveInVideoDataUrl: next })} />
            </Field>
          </FieldRow>
          <Field group label="Checklists">
            <CheckboxOption
              label="Move-in checklist required"
              description="Completed and photographed before the resident takes the room."
              checked={room.moveInInspectionRequired === true}
              onChange={(next) => set({ moveInInspectionRequired: next })}
            />
            <CheckboxOption
              label="Move-out checklist required"
              description="Completed before the deposit is settled."
              checked={room.moveOutInspectionRequired === true}
              onChange={(next) => set({ moveOutInspectionRequired: next })}
            />
          </Field>
        </AdvancedGroup>
      </AdvancedPanel>

      <button
        type="button"
        onClick={onBack}
        data-attr="listing-v2-room-back"
        className="mt-5 min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
      >
        Back to rooms
      </button>
    </StepColumn>
  );
}

/**
 * The "most rooms are…" row's Details, in the same sectioned panel a room gets.
 *
 * It was a flat card of six fields while a room had five named sections, so the
 * two screens that answer the same questions looked like different features.
 * Only the sections a DEFAULT can carry are here: a default has no photos, no
 * availability and no description, because those are what makes one room
 * different from the next.
 */
function DefaultsDetail({
  sub,
  patch,
  defaults,
  editDefault,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  defaults: ListingHouseDefaults;
  editDefault: (field: keyof ListingHouseDefaults, value: ListingHouseDefaults[keyof ListingHouseDefaults]) => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>("room");
  const toggle = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  const rates = roomRateVisibility(sub);
  return (
    <AdvancedPanel
      summary="The room · Leasing · Pricing · Move-in"
      open
      onToggle={() => undefined}
      dataAttr="listing-v2-defaults-advanced"
    >
      <AdvancedGroup
        title="The room"
        description="What most rooms come with"
        open={openGroup === "room"}
        onToggle={() => toggle("room")}
        dataAttr="listing-v2-defaults-basics"
      >
        <FieldRow cols={2}>
          <Field label="Residents allowed in most rooms" hint="What occupancy is enforced against.">
            <Select
              value={String(defaults.occupancyCapacity)}
              onChange={(e) => editDefault("occupancyCapacity", Number(e.target.value) || 1)}
            >
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
          <Field group label="Furnishing">
            <FurnishingField value={defaults.furnishing} onChange={(next) => editDefault("furnishing", next)} />
          </Field>
        </FieldRow>
        <FieldRow cols={2}>
          <Field label="Size" optional hint="Square feet, when most rooms are near enough alike.">
            <Input
              value={defaults.sizeSqft > 0 ? String(defaults.sizeSqft) : ""}
              inputMode="numeric"
              placeholder="sq ft"
              onChange={(e) => editDefault("sizeSqft", Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
            />
          </Field>
          <Field label="Amenities in most rooms" optional>
            <AmenityChips
              presets={ROOM_AMENITY_PRESETS}
              value={defaults.roomAmenitiesText}
              onChange={(next) => editDefault("roomAmenitiesText", next)}
            />
          </Field>
        </FieldRow>
      </AdvancedGroup>

      <AdvancedGroup
        title="Leasing"
        description="Which lease types this listing is let on — and therefore which prices a room needs"
        open={openGroup === "leasing"}
        onToggle={() => toggle("leasing")}
        dataAttr="listing-v2-defaults-leasing"
      >
        <Field label="Lease types offered" hint="Set for the whole listing. Pricing follows what you pick.">
          <LeaseTypesField sub={sub} patch={patch} />
        </Field>
      </AdvancedGroup>

      <AdvancedGroup
        title="Pricing"
        description="Fixed or flexible · a rate per lease type · deposit · move-in fee · utilities · prorating"
        open={openGroup === "payments"}
        onToggle={() => toggle("payments")}
        dataAttr="listing-v2-defaults-payments"
      >
        {/*
         * The same cards a room gets, so the top row can answer every pricing
         * question rather than a subset — a manager who sets short-stay rates
         * for one room expects to set them for most rooms in one place.
         */}
        <FieldRow cols={2}>
          <Field label="Fixed or flexible" hint="Flexible shows the same price and invites an offer.">
            <Select
              value={defaults.pricingMode}
              onChange={(e) => editDefault("pricingMode", e.target.value as ListingHouseDefaults["pricingMode"])}
            >
              <option value="">Leave to each room</option>
              <option value="fixed">Fixed</option>
              <option value="flexible">Flexible</option>
            </Select>
          </Field>
          <Field label="How utilities are handled">
            <Select
              value={defaults.utilitiesPaymentModel}
              onChange={(e) => editDefault("utilitiesPaymentModel", e.target.value as ListingHouseDefaults["utilitiesPaymentModel"])}
            >
              <option value="">Select…</option>
              {LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>

        {rates.monthly ? (
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-[13px] font-bold text-foreground">
              {[rates.longTerm ? "Long-term" : null, rates.custom ? "custom" : null, rates.monthToMonth ? "month-to-month" : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mb-3 mt-0.5 text-[12px] text-muted">One monthly figure covers all of these.</p>
            <FieldRow cols={3}>
              <Field label="Rent / month" optional>
                <Input
                  value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""}
                  inputMode="numeric"
                  placeholder="1,050"
                  onChange={(e) => editDefault("monthlyRent", Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                />
              </Field>
              <Field label="Deposit" optional>
                <Input
                  value={defaults.securityDeposit}
                  placeholder="500"
                  onChange={(e) => editDefault("securityDeposit", e.target.value)}
                />
              </Field>
              <Field label="Move-in fee" optional>
                <Input
                  value={defaults.moveInFee}
                  placeholder="0"
                  onChange={(e) => editDefault("moveInFee", e.target.value)}
                />
              </Field>
            </FieldRow>
            <FieldRow cols={3}>
              <Field label="Utilities / month" optional>
                <Input
                  value={defaults.utilitiesEstimate}
                  placeholder="80"
                  onChange={(e) => editDefault("utilitiesEstimate", e.target.value)}
                />
              </Field>
              {rates.prorate ? (
                <>
                  <Field label="Prorate a partial month">
                    <Select
                      value={defaults.prorateMethod}
                      onChange={(e) => editDefault("prorateMethod", e.target.value as ListingHouseDefaults["prorateMethod"])}
                    >
                      <option value="">Leave to each room</option>
                      <option value="auto">Work it out automatically</option>
                      <option value="daily_rate">Set a per-day rate</option>
                    </Select>
                  </Field>
                  <Field label="Prorated rent / day" optional>
                    <Input
                      value={defaults.dailyRentRate > 0 ? String(defaults.dailyRentRate) : ""}
                      inputMode="numeric"
                      onChange={(e) => editDefault("dailyRentRate", Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                    />
                  </Field>
                </>
              ) : null}
            </FieldRow>
          </div>
        ) : null}

        {rates.shortTerm ? (
          <div className="mt-3 rounded-xl border border-border bg-card p-4">
            <p className="text-[13px] font-bold text-foreground">Short-term</p>
            <p className="mb-3 mt-0.5 text-[12px] text-muted">Under a month, so it is priced by the week or night.</p>
            <FieldRow cols={2}>
              <Field label="Rent / week" optional>
                <Input
                  value={defaults.weeklyRentPrice > 0 ? String(defaults.weeklyRentPrice) : ""}
                  inputMode="numeric"
                  onChange={(e) => editDefault("weeklyRentPrice", Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
                />
              </Field>
              <Field label="Rent / night" optional>
                <Input
                  value={defaults.shortTermRent}
                  onChange={(e) => editDefault("shortTermRent", e.target.value)}
                />
              </Field>
            </FieldRow>
            <FieldRow cols={2}>
              <Field label="Deposit" optional>
                <Input
                  value={defaults.shortTermDeposit}
                  onChange={(e) => editDefault("shortTermDeposit", e.target.value)}
                />
              </Field>
              <Field label="Move-in fee" optional>
                <Input
                  value={defaults.shortTermMoveInFee}
                  onChange={(e) => editDefault("shortTermMoveInFee", e.target.value)}
                />
              </Field>
            </FieldRow>
          </div>
        ) : null}

        {!rates.monthly && !rates.shortTerm && !rates.airbnb ? (
          <p className="rounded-xl border border-dashed border-border bg-card px-4 py-3 text-[12.5px] leading-relaxed text-muted">
            No lease types are offered yet, so there is nothing to price. Choose them under
            <span className="font-bold text-foreground"> Leasing</span> above.
          </p>
        ) : null}
      </AdvancedGroup>

      <AdvancedGroup
        title="Move-in"
        description="Checklists most rooms require"
        open={openGroup === "movein"}
        onToggle={() => toggle("movein")}
        dataAttr="listing-v2-defaults-movein"
      >
        <Field group label="Checklists for most rooms">
          <CheckboxOption
            label="Move-in checklist required"
            checked={defaults.moveInInspectionRequired}
            onChange={(next) => editDefault("moveInInspectionRequired", next)}
          />
          <CheckboxOption
            label="Move-out checklist required"
            checked={defaults.moveOutInspectionRequired}
            onChange={(next) => editDefault("moveOutInspectionRequired", next)}
          />
        </Field>
      </AdvancedGroup>
    </AdvancedPanel>
  );
}

function StepRooms({
  sub,
  patch,
  defaults,
  setDefaults,
}: {
  sub: ManagerListingSubmissionV1;
  patch: Patch;
  defaults: ListingHouseDefaults;
  setDefaults: (next: ListingHouseDefaults) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [openDefaults, setOpenDefaults] = useState(false);
  /**
   * Rooms the manager has edited by hand in this session.
   *
   * Value comparison alone is not enough to answer "has this room been
   * edited". While the house default for a field is still unset, EVERY room
   * reads as following it — a room cannot diverge from a blank — so a room
   * given its own rent before the top row had one was still swept up the first
   * time that top row was filled in. This set remembers the act, not the value.
   */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const markTouched = (id: string) => setTouched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  const [copyTargets, setCopyTargets] = useState<Set<string>>(new Set());
  const rooms = sub.rooms ?? [];
  const openRoom = rooms.find((r) => r.id === openRoomId) ?? null;
  useDetailBack(Boolean(openRoom), () => setOpenRoomId(null));

  function writeRooms(next: ManagerRoomSubmission[]) {
    patch({ rooms: next });
  }

  /**
   * Rooms that have never been edited — the only ones the "most rooms are…"
   * row is allowed to change.
   *
   * The rule is per ROOM, not per field: once a manager has touched a room at
   * all, that room stops following the defaults for everything, including the
   * fields they left alone. A manager who set Room 3's rent by hand does not
   * expect its beds to move underneath them later, and the old per-field rule
   * did exactly that. "Copy to all rooms" is the way to overwrite an edited
   * room, and it is a deliberate click rather than a side effect of typing.
   */
  const untouchedRoomIds = (against: ListingHouseDefaults) =>
    roomsFollowingDefaults(rooms, against).filter((id) => !touched.has(id));

  function editDefault(field: keyof ListingHouseDefaults, value: ListingHouseDefaults[keyof ListingHouseDefaults]) {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    // Inheritance is judged against the PREVIOUS default — see
    // applyHouseDefaultsToRooms. Judging against the new one freezes every room.
    writeRooms(
      applyHouseDefaultsToRooms(rooms, next, {
        onlyFields: [field],
        previousDefaults: previous,
        roomIds: untouchedRoomIds(previous),
      }),
    );
  }


  if (openRoom) {
    return (
      <RoomDetail
        room={openRoom}
        sub={sub}
        patch={patch}
        defaults={defaults}
        onBack={() => setOpenRoomId(null)}
        onChange={(next) => {
          markTouched(next.id);
          writeRooms(rooms.map((r) => (r.id === next.id ? next : r)));
        }}
      />
    );
  }

  const columns = [
    { key: "name", label: "Room" },
    { key: "floor", label: "Floor" },
    { key: "access", label: "Bathroom" },
    { key: "rent", label: "Rent" },
    { key: "beds", label: "Beds" },
    { key: "details", label: "" },
  ];
  const floorOptions = floorLevelSelectOptions(sub.listingStoriesId, "").map((l) => ({ value: l, label: l }));
  const baths = sub.bathrooms ?? [];

  /**
   * Which bathroom a room uses is stored on the BATHROOM (`assignedRoomIds`),
   * because one bathroom serves many rooms. The row shows it from the room's
   * side, so writing it means moving the room's id between bathrooms rather
   * than setting a field on the room.
   */
  /**
   * Attach a room to a bathroom if it is not on one yet, so an access kind has
   * somewhere to live. The manager is no longer asked WHICH bathroom — what a
   * renter needs to know is whether it is en-suite, shared, or down the hall —
   * so the first bathroom carries the mapping, and which physical bathroom
   * serves which room stays adjustable on the Bathrooms step.
   */
  const withRoomAttached = (roomId: string): ManagerBathroomSubmission[] => {
    if (baths.length === 0) return baths;
    if (baths.some((b) => (b.assignedRoomIds ?? []).includes(roomId))) return baths;
    return baths.map((b, idx) =>
      idx === 0 ? { ...b, assignedRoomIds: [...(b.assignedRoomIds ?? []), roomId] } : b,
    );
  };
  const accessForRoom = (roomId: string): string => {
    const bath = baths.find((b) => (b.assignedRoomIds ?? []).includes(roomId));
    return bath?.accessKindByRoomId?.[roomId] ?? "";
  };
  const setAccessForRoom = (roomId: string, kind: string) => {
    // Only a value the model actually defines reaches storage; anything else
    // clears the field rather than writing a string the readers do not know.
    const next = BATHROOM_ACCESS_OPTIONS.some((o) => o.value === kind)
      ? (kind as ManagerBathroomRoomAccessKind)
      : undefined;
    const attached = withRoomAttached(roomId);
    patch({
      bathrooms: attached.map((b) =>
        (b.assignedRoomIds ?? []).includes(roomId)
          ? { ...b, accessKindByRoomId: { ...(b.accessKindByRoomId ?? {}), [roomId]: next } }
          : b,
      ),
    });
  };
  /**
   * The same access on every room that has not been edited — the "most rooms
   * are…" version. An edited room keeps whatever its manager chose.
   */
  const setAccessForAllRooms = (kind: string) => {
    const next = BATHROOM_ACCESS_OPTIONS.some((o) => o.value === kind)
      ? (kind as ManagerBathroomRoomAccessKind)
      : undefined;
    if (baths.length === 0) return;
    const ids = untouchedRoomIds(defaults);
    if (ids.length === 0) return;
    patch({
      bathrooms: baths.map((b, idx) => {
        const assigned =
          idx === 0 ? Array.from(new Set([...(b.assignedRoomIds ?? []), ...ids])) : b.assignedRoomIds ?? [];
        const kinds = { ...(b.accessKindByRoomId ?? {}) };
        for (const id of assigned) if (ids.includes(id)) kinds[id] = next;
        return { ...b, assignedRoomIds: assigned, accessKindByRoomId: kinds };
      }),
    });
  };

  return (
    <StepColumn wide>
      <StepHeading
        title={`Your ${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}`}
        subtitle="Set what is true for most rooms once. Change only the rooms that differ."
      />

      {/*
       * The house defaults are the FIRST ROW of the same table, not a separate
       * card above it. They answer the same questions in the same columns, so
       * two differently-shaped panels asking "rent?" twice was the confusing
       * part. Its checkbox selects every room; its Details opens the settings
       * that apply to most rooms.
       */}
      <RowList columns={columns}>
        <div
          className="grid items-center gap-2 border-b-2 border-primary/25 bg-primary/[0.05] px-3 py-2"
          style={{ gridTemplateColumns: rowTemplate(columns.length) }}
        >
          {/*
           * No checkbox here. This row is not a room, so selecting it selected
           * every room and then offered to duplicate or delete them — an
           * alarming thing to find under a row that only sets defaults.
           */}
          <span aria-hidden className="h-10 w-6" />
          <span className="px-1 text-[13px] font-bold text-foreground">Most rooms are…</span>
          <RowSelectCell
            ariaLabel="Floor for most rooms"
            value={defaults.floor}
            options={floorOptions}
            placeholder="Floor…"
            onChange={(v) => editDefault("floor", v)}
          />
          <select
            value={rooms.length > 0 ? accessForRoom(rooms[0]!.id) : ""}
            onChange={(e) => setAccessForAllRooms(e.target.value)}
            disabled={baths.length === 0}
            aria-label="Bathroom access for most rooms"
            className="min-h-[38px] w-full rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] text-foreground outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="">{baths.length === 0 ? "Add a bathroom" : "Select…"}</option>
            {BATHROOM_ACCESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <RowCell
            ariaLabel="Rent for most rooms"
            inputMode="numeric"
            value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""}
            placeholder="1,050"
            onChange={(v) => editDefault("monthlyRent", Number(v.replace(/[^0-9.]/g, "")) || 0)}
          />
          <RowSelectCell
            ariaLabel="Beds in most rooms"
            value={String(defaults.occupancyCapacity)}
            options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => editDefault("occupancyCapacity", Number(v) || 1)}
          />
          <button
            type="button"
            onClick={() => setOpenDefaults((v) => !v)}
            data-attr="listing-v2-more-defaults"
            aria-expanded={openDefaults}
            className="justify-self-start rounded-full border border-primary/30 bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:bg-accent/40"
          >
            Details
          </button>
          <span />
        </div>

        {/*
         * Directly under the row it belongs to, and above the rooms it
         * governs. Below the table it read as a panel about the whole step
         * rather than about the "most rooms are…" row.
         */}
        {openDefaults ? (
          <div className="border-b border-border bg-primary/[0.03] px-3 py-3">
            <DefaultsDetail sub={sub} patch={patch} defaults={defaults} editDefault={editDefault} />
          </div>
        ) : null}

        {rooms.map((room, i) => {
          const overrides = roomOverriddenDefaults(room, defaults);
          const rentInherited = roomInheritsDefault(room, defaults, "monthlyRent");
          const bedsInherited = roomInheritsDefault(room, defaults, "occupancyCapacity");
          return (
            <Row
              key={room.id}
              columnCount={columns.length}
              selected={selected.has(room.id)}
              onSelectChange={(on) =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(room.id);
                  else next.delete(room.id);
                  return next;
                })
              }
              removeLabel={`Remove ${room.name || `room ${i + 1}`}`}
              onRemove={rooms.length > 1 ? () => writeRooms(rooms.filter((r) => r.id !== room.id)) : undefined}
            >
              <RowCell
                ariaLabel={`Name for room ${i + 1}`}
                value={room.name}
                placeholder={`Room ${i + 1}`}
                onChange={(v) => {
                  markTouched(room.id);
                  writeRooms(rooms.map((r) => (r.id === room.id ? { ...r, name: v } : r)));
                }}
              />
              <RowSelectCell
                ariaLabel={`Floor for ${room.name || `room ${i + 1}`}`}
                value={room.floor}
                options={floorOptions}
                placeholder="Floor…"
                onChange={(v) => {
                  markTouched(room.id);
                  writeRooms(rooms.map((r) => (r.id === room.id ? { ...r, floor: v } : r)));
                }}
              />
              <RowSelectCell
                ariaLabel={`Bathroom access for ${room.name || `room ${i + 1}`}`}
                value={accessForRoom(room.id)}
                options={BATHROOM_ACCESS_OPTIONS}
                placeholder="Shared"
                onChange={(v) => {
                  markTouched(room.id);
                  setAccessForRoom(room.id, v);
                }}
              />
              <RowCell
                ariaLabel={`Rent for ${room.name || `room ${i + 1}`}`}
                inputMode="numeric"
                inherited={rentInherited}
                value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
                onChange={(v) => {
                  markTouched(room.id);
                  writeRooms(
                    rooms.map((r) =>
                      r.id === room.id ? { ...r, monthlyRent: Number(v.replace(/[^0-9.]/g, "")) || 0 } : r,
                    ),
                  );
                }}
              />
              <RowCell
                ariaLabel={`Beds in ${room.name || `room ${i + 1}`}`}
                inputMode="numeric"
                inherited={bedsInherited}
                value={room.occupancyCapacity ? String(room.occupancyCapacity) : ""}
                placeholder={String(defaults.occupancyCapacity)}
                onChange={(v) => {
                  markTouched(room.id);
                  writeRooms(
                    rooms.map((r) =>
                      r.id === room.id ? { ...r, occupancyCapacity: Number(v.replace(/[^0-9]/g, "")) || 1 } : r,
                    ),
                  );
                }}
              />
              <button
                type="button"
                onClick={() => setOpenRoomId(room.id)}
                data-attr="listing-v2-room-details"
                className="justify-self-start rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:bg-accent/40"
              >
                Details
                {overrides.length > 0 ? (
                  <span className="ml-1.5 text-[10px] font-extrabold uppercase tracking-wide text-amber-700">
                    {overrides.length} custom
                  </span>
                ) : null}
              </button>
            </Row>
          );
        })}
      </RowList>


      <div className="flex flex-wrap items-center gap-3">
        <RowBulkBar count={selected.size}>
          {selected.size === 1 ? (
            <BulkButton tone="primary" onClick={() => setCopyOpen((v) => !v)}>Copy to another room</BulkButton>
          ) : null}
          <BulkButton
            onClick={() => {
              const copies = rooms
                .filter((r) => selected.has(r.id))
                .map((r, i) => ({ ...r, id: `${r.id}-copy-${i}-${Date.now()}`, name: `${r.name} (copy)` }));
              writeRooms([...rooms, ...copies]);
              setSelected(new Set());
            }}
          >
            Duplicate
          </BulkButton>
          <BulkButton
            tone="danger"
            onClick={() => {
              writeRooms(rooms.filter((r) => !selected.has(r.id)));
              setSelected(new Set());
            }}
          >
            Remove
          </BulkButton>
        </RowBulkBar>

      </div>

      {copyOpen && selected.size === 1 ? (
        <div className="mt-3 rounded-xl border border-border bg-card p-4">
          <p className="text-[13px] font-bold text-foreground">Copy this room to…</p>
          <p className="mb-3 mt-0.5 text-[12px] leading-relaxed text-muted">
            Copies everything except the room&apos;s name, its photos and its video. Those stay unique to each room.
          </p>
          <CheckboxMultiSelect
            hideLabel
            label="Rooms to copy to"
            options={rooms
              .filter((r) => !selected.has(r.id))
              .map((r, i) => ({ value: r.id, label: r.name.trim() || `Room ${i + 1}` }))}
            selected={[...copyTargets]}
            emptyLabel="Choose rooms…"
            onChange={(next) => setCopyTargets(new Set(next))}
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={copyTargets.size === 0}
              data-attr="listing-v2-copy-apply"
              onClick={() => {
                const source = rooms.find((r) => selected.has(r.id));
                if (!source) return;
                writeRooms(
                  rooms.map((r) => {
                    if (!copyTargets.has(r.id)) return r;
                    // Everything the source says about the room EXCEPT the three
                    // things that identify it. Copying a name would give two
                    // rooms the same label; copying media would show a renter
                    // one room's photos on another.
                    return {
                      ...source,
                      id: r.id,
                      name: r.name,
                      photoDataUrls: r.photoDataUrls,
                      videoDataUrl: r.videoDataUrl,
                    };
                  }),
                );
                setCopyOpen(false);
                setCopyTargets(new Set());
                setSelected(new Set());
              }}
              className="min-h-[38px] rounded-full bg-primary px-5 text-[13px] font-bold text-white disabled:opacity-50"
            >
              Copy to {copyTargets.size || "…"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCopyOpen(false);
                setCopyTargets(new Set());
              }}
              className="min-h-[38px] rounded-full px-4 text-[13px] font-bold text-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <AddRowButton
        label="Add room"
        icon={DoorOpen}
        dataAttr="listing-v2-add-room"
        onClick={() => {
          const base = rooms[0];
          const id = `room-${Date.now()}`;
          const blank = base
            ? { ...base, id, name: "", photoDataUrls: [], videoDataUrl: null }
            : ({ id, name: "" } as ManagerRoomSubmission);
          writeRooms([...rooms, applyHouseDefaultsToRooms([blank], defaults)[0]!]);
        }}
      />
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Dashed grey means the room is following the top row. Edit a room and it stops following, so changing the top
        row will not touch it again.
      </p>
    </StepColumn>
  );
}

/* ─────────────────────────── step 3 · spaces ─────────────────────────── */

function BathroomDetail({
  bath,
  index,
  rooms,
  onChange,
  onBack,
}: {
  bath: ManagerBathroomSubmission;
  index: number;
  /** So the manager can say which rooms use this bathroom, and how they reach it. */
  rooms: readonly ManagerRoomSubmission[];
  onChange: (next: ManagerBathroomSubmission) => void;
  onBack: () => void;
}) {
  const set = (patch: Partial<ManagerBathroomSubmission>) => onChange({ ...bath, ...patch });
  return (
    <StepColumn>
      <p className="mb-2 text-[12px] font-bold text-muted">Bathroom</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {bath.name.trim() || `Bathroom ${index + 1}`}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        Everything about this bathroom on one screen, the same as a room.
      </p>
      <FieldRow cols={2}>
        <Field label="Name" optional>
          <Input
            value={bath.name}
            placeholder={`Bathroom ${index + 1}`}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Fixtures">
          <CheckboxMultiSelect
            hideLabel
            label="Fixtures"
          options={[
            { value: "shower", label: "Shower" },
            { value: "bathtub", label: "Bathtub" },
            { value: "toilet", label: "Toilet" },
            { value: "sink", label: "Sink" },
            { value: "mirror", label: "Mirror" },
          ]}
          selected={[
            ...(bath.shower ? ["shower"] : []),
            ...(bath.bathtub ? ["bathtub"] : []),
            ...(bath.toilet ? ["toilet"] : []),
            ...(bath.sink ? ["sink"] : []),
            ...(bath.mirror ? ["mirror"] : []),
          ]}
          emptyLabel="Choose fixtures…"
            onChange={(next) =>
              set({
                shower: next.includes("shower"),
                bathtub: next.includes("bathtub"),
                toilet: next.includes("toilet"),
                sink: next.includes("sink"),
                mirror: next.includes("mirror"),
              })
            }
          />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Used by">
        <CheckboxMultiSelect
          hideLabel
          label="Used by"
          options={[
            { value: "__all", label: "Every room" },
            ...rooms.map((r, i) => ({ value: r.id, label: r.name.trim() || `Room ${i + 1}` })),
          ]}
          selected={[...(bath.allResidents ? ["__all"] : []), ...(bath.assignedRoomIds ?? [])]}
          emptyLabel="Choose rooms…"
          onChange={(next) => {
            const all = next.includes("__all");
            set({
              allResidents: all,
              // "Every room" is its own answer; the per-room list is what a
              // manager edits when only some rooms use this bathroom.
              assignedRoomIds: all ? rooms.map((r) => r.id) : next.filter((v) => v !== "__all"),
            });
          }}
        />
        </Field>
        <Field label="Finishes and extras" optional>
          <AmenityChips
            presets={BATHROOM_EXTRA_AMENITY_PRESETS}
            value={bath.amenitiesText ?? ""}
            onChange={(next) => set({ amenitiesText: next })}
          />
        </Field>
      </FieldRow>
      {(bath.assignedRoomIds ?? []).length > 0 ? (
        <Field group label="How each room reaches it">
          {(bath.assignedRoomIds ?? []).map((id) => {
            const room = rooms.find((r) => r.id === id);
            const label = room?.name.trim() || `Room ${rooms.findIndex((r) => r.id === id) + 1}`;
            return (
              <div key={id} className="mb-2 flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-[13px] font-semibold text-foreground">{label}</span>
                <Select
                  aria-label={`How ${label} reaches ${bath.name || `bathroom ${index + 1}`}`}
                  value={bath.accessKindByRoomId?.[id] ?? ""}
                  onChange={(e) => {
                    const kind = BATHROOM_ACCESS_OPTIONS.some((o) => o.value === e.target.value)
                      ? (e.target.value as ManagerBathroomRoomAccessKind)
                      : undefined;
                    set({ accessKindByRoomId: { ...(bath.accessKindByRoomId ?? {}), [id]: kind } });
                  }}
                >
                  <option value="">Select…</option>
                  {BATHROOM_ACCESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </div>
            );
          })}
        </Field>
      ) : null}
      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Media</p>
      <FieldRow cols={2}>
        <Field label="Photos of this bathroom" optional>
          <PhotoStrip
            label="bathroom"
            urls={bath.photoDataUrls ?? []}
            onChange={(next) => set({ photoDataUrls: next })}
          />
        </Field>
        <Field label="Video of this bathroom" optional>
          <VideoSlot label="bathroom" url={bath.videoDataUrl} onChange={(next) => set({ videoDataUrl: next })} />
        </Field>
      </FieldRow>
      <button
        type="button"
        onClick={onBack}
        data-attr="listing-v2-bath-back"
        className="mt-5 min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
      >
        Back to bathrooms
      </button>
    </StepColumn>
  );
}

/** What "most bathrooms are" — the same idea as the rooms table's top row. */
type BathroomDefaults = { location: string; type: "full" | "shower" | "half" | ""; amenitiesText: string };

/** A bathroom's type, read back from the fixtures that define it. */
function bathroomTypeOf(bath: ManagerBathroomSubmission): "full" | "shower" | "half" {
  return bath.bathtub ? "full" : bath.shower ? "shower" : "half";
}

function writeBathroomType(bath: ManagerBathroomSubmission, type: "full" | "shower" | "half"): ManagerBathroomSubmission {
  return { ...bath, toilet: true, sink: true, shower: type !== "half", bathtub: type === "full" };
}

function StepBathrooms({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openBathId, setOpenBathId] = useState<string | null>(null);
  const [openDefaults, setOpenDefaults] = useState(false);
  const [defaults, setDefaults] = useState<BathroomDefaults>({ location: "", type: "", amenitiesText: "" });
  /*
   * Which bathrooms the manager has edited by hand. Exactly the rule the rooms
   * table follows: once a bathroom is touched it stops following the top row,
   * including for the fields left alone, so a floor set on one bathroom is
   * never moved by a later change to what most bathrooms are.
   */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const markTouched = (id: string) => setTouched((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  const baths = sub.bathrooms ?? [];

  function editBathDefault<K extends keyof BathroomDefaults>(field: K, value: BathroomDefaults[K]) {
    setDefaults((prev) => ({ ...prev, [field]: value }));
    patch({
      bathrooms: baths.map((b) => {
        if (touched.has(b.id)) return b;
        if (field === "location") return { ...b, location: value as string };
        if (field === "type" && value) return writeBathroomType(b, value as "full" | "shower" | "half");
        if (field === "amenitiesText") return { ...b, amenitiesText: value as string };
        return b;
      }),
    });
  }
  const openBath = baths.find((b) => b.id === openBathId) ?? null;
  useDetailBack(Boolean(openBath), () => setOpenBathId(null));
  if (openBath) {
    return (
      <BathroomDetail
        bath={openBath}
        index={baths.indexOf(openBath)}
        rooms={sub.rooms ?? []}
        onBack={() => setOpenBathId(null)}
        onChange={(next) => {
          markTouched(next.id);
          patch({ bathrooms: baths.map((b) => (b.id === next.id ? next : b)) });
        }}
      />
    );
  }
  const floors = floorLevelSelectOptions(sub.listingStoriesId, "").map((l) => ({ value: l, label: l }));
  const cols = [
    { key: "name", label: "Bathroom" },
    { key: "floor", label: "Floor" },
    { key: "type", label: "Type" },
    { key: "details", label: "" },
  ];
  return (
    <StepColumn wide>
      <StepHeading
        title={`Your ${baths.length} ${baths.length === 1 ? "bathroom" : "bathrooms"}`}
        subtitle="Set what is true for most bathrooms once. Change only the ones that differ."
      />
      <RowList columns={cols}>
        {/*
         * The top row is the same shape as the rooms table's: it answers the
         * same questions in the same columns, and its Details holds what a
         * default can carry — a bathroom's photos and the rooms it serves are
         * what make one different from the next, so they stay on the bathroom.
         */}
        <div
          className="grid items-center gap-2 border-b-2 border-primary/25 bg-primary/[0.05] px-3 py-2"
          style={{ gridTemplateColumns: rowTemplate(cols.length) }}
        >
          <span aria-hidden className="h-10 w-6" />
          <span className="px-1 text-[13px] font-bold text-foreground">Most bathrooms are…</span>
          <RowSelectCell
            ariaLabel="Floor for most bathrooms"
            value={defaults.location}
            options={floors}
            placeholder="Floor…"
            onChange={(v) => editBathDefault("location", v)}
          />
          <RowSelectCell
            ariaLabel="Type of most bathrooms"
            value={defaults.type}
            options={[
              { value: "full", label: "Full bath" },
              { value: "shower", label: "Shower only" },
              { value: "half", label: "Half bath" },
            ]}
            placeholder="Type…"
            onChange={(v) => editBathDefault("type", v as BathroomDefaults["type"])}
          />
          <button
            type="button"
            onClick={() => setOpenDefaults((v) => !v)}
            data-attr="listing-v2-more-bath-defaults"
            aria-expanded={openDefaults}
            className="justify-self-start rounded-full border border-primary/30 bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:bg-accent/40"
          >
            Details
          </button>
          <span />
        </div>

        {openDefaults ? (
          <div className="border-b border-border bg-primary/[0.03] px-3 py-3">
            <Field label="Finishes most bathrooms have" optional>
              <AmenityChips
                presets={BATHROOM_EXTRA_AMENITY_PRESETS}
                value={defaults.amenitiesText}
                onChange={(next) => editBathDefault("amenitiesText", next)}
              />
            </Field>
          </div>
        ) : null}

        {baths.map((bath, i) => (
          <Row
            key={bath.id}
            columnCount={cols.length}
            selected={selected.has(bath.id)}
            onSelectChange={(on) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (on) next.add(bath.id);
                else next.delete(bath.id);
                return next;
              })
            }
            removeLabel={`Remove ${bath.name || `bathroom ${i + 1}`}`}
            onRemove={() => patch({ bathrooms: baths.filter((b) => b.id !== bath.id) })}
          >
            <RowCell
              ariaLabel={`Name for bathroom ${i + 1}`}
              value={bath.name}
              placeholder={`Bathroom ${i + 1}`}
              onChange={(v) => {
                markTouched(bath.id);
                patch({ bathrooms: baths.map((b) => (b.id === bath.id ? { ...b, name: v } : b)) });
              }}
            />
            <RowSelectCell
              ariaLabel={`Floor for bathroom ${i + 1}`}
              value={bath.location ?? ""}
              options={floors}
              placeholder="Floor…"
              onChange={(v) => {
                markTouched(bath.id);
                patch({ bathrooms: baths.map((b) => (b.id === bath.id ? { ...b, location: v } : b)) });
              }}
            />
            <RowSelectCell
              ariaLabel={`Type of bathroom ${i + 1}`}
              value={bathroomTypeOf(bath)}
              options={[
                { value: "full", label: "Full bath" },
                { value: "shower", label: "Shower only" },
                { value: "half", label: "Half bath" },
              ]}
              onChange={(v) => {
                markTouched(bath.id);
                patch({
                  bathrooms: baths.map((b) =>
                    b.id === bath.id ? writeBathroomType(b, v as "full" | "shower" | "half") : b,
                  ),
                });
              }}
            />
            <button
              type="button"
              onClick={() => setOpenBathId(bath.id)}
              data-attr="listing-v2-bath-details"
              className="justify-self-start rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:bg-accent/40"
            >
              Details
              {(bath.photoDataUrls ?? []).length > 0 ? (
                <span className="ml-1.5 text-[10px] font-extrabold uppercase tracking-wide text-emerald-700">
                  {(bath.photoDataUrls ?? []).length} photo{(bath.photoDataUrls ?? []).length === 1 ? "" : "s"}
                </span>
              ) : null}
            </button>
          </Row>
        ))}
      </RowList>
      <AddRowButton
        label="Add bathroom"
        icon={Bath}
        dataAttr="listing-v2-add-bath"
        onClick={() => {
          const base = baths[0];
          const id = `bath-${Date.now()}`;
          patch({
            bathrooms: [
              ...baths,
              base ? { ...base, id, name: "", photoDataUrls: [], videoDataUrl: null } : ({ id, name: "" } as never),
            ],
          });
        }}
      />
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Which rooms use which bathroom is set on the Rooms step, so you only say it once.
      </p>
    </StepColumn>
  );
}

function SharedSpaceDetail({
  space,
  index,
  rooms,
  storiesId,
  onChange,
  onBack,
}: {
  space: ManagerSharedSpaceSubmission;
  index: number;
  /** Which rooms may use this space — a locked study is not shared by everyone. */
  rooms: readonly ManagerRoomSubmission[];
  storiesId: string | undefined;
  onChange: (next: ManagerSharedSpaceSubmission) => void;
  onBack: () => void;
}) {
  const set = (patch: Partial<ManagerSharedSpaceSubmission>) => onChange({ ...space, ...patch });
  return (
    <StepColumn>
      <p className="mb-2 text-[12px] font-bold text-muted">Shared space</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {space.name.trim() || `Shared space ${index + 1}`}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        What is in it, and how it looks.
      </p>
      <Field label="Name" optional>
        <Input value={space.name} placeholder="Kitchen" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Type" optional hint="Decides which amenities are offered below.">
        <Select
          value={space.spaceKind ?? ""}
          onChange={(e) => set({ spaceKind: e.target.value as ManagerSharedSpaceSubmission["spaceKind"] })}
        >
          <option value="">Select…</option>
          {SHARED_SPACE_KIND_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Floor" optional>
        <Select value={space.location ?? ""} onChange={(e) => set({ location: e.target.value })}>
          <option value="">Select…</option>
          {floorLevelSelectOptions(storiesId, space.location).map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Which rooms may use it" hint="Leave every room ticked unless this space is only for some of them.">
        <CheckboxMultiSelect
          hideLabel
          label="Which rooms may use it"
          options={rooms.map((r, i) => ({ value: r.id, label: r.name.trim() || `Room ${i + 1}` }))}
          selected={space.roomAccessIds ?? rooms.map((r) => r.id)}
          emptyLabel="Choose rooms…"
          onChange={(next) => set({ roomAccessIds: next })}
        />
      </Field>
      <Field label="Description" optional hint="What a renter reads under this space.">
        <Textarea
          rows={2}
          value={space.detail ?? ""}
          onChange={(e) => set({ detail: e.target.value })}
          placeholder="Sunny room off the kitchen, seats six…"
        />
      </Field>
      <Field label="What is in it" optional>
        <AmenityChips
          presets={sharedSpaceAmenityPresetsForKind(space.spaceKind)}
          value={space.amenitiesText ?? ""}
          onChange={(next) => set({ amenitiesText: next })}
        />
      </Field>
      <Field label="Photos" optional>
        <PhotoStrip
          label="shared space"
          urls={space.photoDataUrls ?? []}
          onChange={(next) => set({ photoDataUrls: next })}
        />
      </Field>
      <Field label="Video" optional>
        <VideoSlot label="shared space" url={space.videoDataUrl} onChange={(next) => set({ videoDataUrl: next })} />
      </Field>
      <button
        type="button"
        onClick={onBack}
        className="mt-5 min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
      >
        Back to shared spaces
      </button>
    </StepColumn>
  );
}

function StepSharedSpaces({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [openSpaceId, setOpenSpaceId] = useState<string | null>(null);
  const spaces = sub.sharedSpaces ?? [];
  const openSpace = spaces.find((sp) => sp.id === openSpaceId) ?? null;
  useDetailBack(Boolean(openSpace), () => setOpenSpaceId(null));
  if (openSpace) {
    return (
      <SharedSpaceDetail
        space={openSpace}
        index={spaces.indexOf(openSpace)}
        rooms={sub.rooms ?? []}
        storiesId={sub.listingStoriesId}
        onBack={() => setOpenSpaceId(null)}
        onChange={(next) => patch({ sharedSpaces: spaces.map((sp) => (sp.id === next.id ? next : sp)) })}
      />
    );
  }
  const floors = floorLevelSelectOptions(sub.listingStoriesId, "").map((l) => ({ value: l, label: l }));
  const cols = [
    { key: "name", label: "Shared space" },
    { key: "floor", label: "Floor" },
    { key: "details", label: "" },
  ];
  return (
    <StepColumn wide>
      <StepHeading
        title="Kitchen, laundry and the rest"
        subtitle="Everything every resident can use. Open one to add photos and amenities."
      />
      <RowList columns={cols}>
        {spaces.map((space, i) => (
          <Row
            key={space.id}
            columnCount={cols.length}
            selected={false}
            onSelectChange={() => {}}
            removeLabel={`Remove ${space.name || `shared space ${i + 1}`}`}
            onRemove={() => patch({ sharedSpaces: spaces.filter((sp) => sp.id !== space.id) })}
          >
            <RowCell
              ariaLabel={`Name for shared space ${i + 1}`}
              value={space.name}
              placeholder="Kitchen"
              onChange={(v) => patch({ sharedSpaces: spaces.map((sp) => (sp.id === space.id ? { ...sp, name: v } : sp)) })}
            />
            <RowSelectCell
              ariaLabel={`Floor for shared space ${i + 1}`}
              value={space.location ?? ""}
              options={floors}
              placeholder="Floor…"
              onChange={(v) =>
                patch({ sharedSpaces: spaces.map((sp) => (sp.id === space.id ? { ...sp, location: v } : sp)) })
              }
            />
            <button
              type="button"
              onClick={() => setOpenSpaceId(space.id)}
              data-attr="listing-v2-space-details"
              className="justify-self-start rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-bold text-primary hover:bg-accent/40"
            >
              Details
            </button>
          </Row>
        ))}
      </RowList>
      <AddRowButton
        label="Add shared space"
        icon={LayoutGrid}
        dataAttr="listing-v2-add-space"
        onClick={() => {
          const base = spaces[0];
          const id = `space-${Date.now()}`;
          patch({
            sharedSpaces: [
              ...spaces,
              base ? { ...base, id, name: "", photoDataUrls: [], videoDataUrl: null } : ({ id, name: "" } as never),
            ],
          });
        }}
      />
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        Shared spaces are available to every room unless you say otherwise when you open one.
      </p>
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
  return (
    <InlineCheckboxGroup
      label="Long-term lengths offered"
      columns={2}
      dataAttr="long-term-length"
      options={LONG_TERM_LENGTH_CHOICES.map((months) => ({
        value: String(months),
        label: `${months} months`,
        hint: months === 12 ? "One year, then the rollover rule applies." : undefined,
      }))}
      selected={lengths.map(String)}
      onChange={(next) => patch({ longTermLengthsOffered: normalizeLongTermLengths(next.map(Number)) })}
    />
  );
}

function LeaseTypesField({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const allowed = resolveAllowedLeaseTerms(sub);
  const named = LEASE_TERM_CHOICES.filter((t) => t !== CUSTOM_LEASE_TERM);
  const selected = [
    ...named.filter((t) => allowed.includes(t)),
    ...(sub.shortTermRentalsAllowed ? [SHORT_TERM_LEASE_TERM] : []),
    ...(sub.airbnbRentalsAllowed ? [AIRBNB_LEASE_TERM] : []),
    ...(allowed.includes(CUSTOM_LEASE_TERM) ? [CUSTOM_LEASE_TERM] : []),
  ];
  return (
    <InlineCheckboxGroup
      label={`Lease options offered · ${selected.length} selected`}
      columns={2}
      dataAttr="lease-type"
      options={[
        {
          value: SHORT_TERM_LEASE_TERM,
          label: "Short-term",
          hint: "Anything under a month.",
        },
        {
          value: LONG_TERM_LEASE_TERM,
          label: "Long-term",
          hint: "A month or more, starting on the 1st. The move-in and move-out dates are the term.",
        },
        {
          value: CUSTOM_LEASE_TERM,
          label: "Custom",
          hint: "A month or more, but starting on some other day of the month.",
        },
        { value: "Month-to-Month", label: "Month to month", hint: "Rolls on until either side ends it." },
        {
          value: AIRBNB_LEASE_TERM,
          label: "Airbnb",
          hint: "Booked off PropLane. No rent charges are raised here.",
        },
      ]}
      selected={selected}
      onChange={(next) => {
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
  return (
    <>
      <Field label="Lease template" optional hint="Your own document. Leave blank to use PropLane's lease.">
        <Input
          value={sub.leaseTemplateDocName ?? ""}
          placeholder="magnolia-lease-2026.pdf"
          onChange={(e) => patch({ leaseTemplateDocName: e.target.value })}
        />
      </Field>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Charges the lease names</p>
      <FieldRow cols={2}>
        <Field label="Break-lease fee" optional>
          <Input value={money(sub.longTermBreakLeaseFee)} onChange={(e) => patch({ longTermBreakLeaseFee: e.target.value })} />
        </Field>
        <Field label="Holdover / day" optional>
          <Input value={money(sub.longTermHoldoverDailyRate)} onChange={(e) => patch({ longTermHoldoverDailyRate: e.target.value })} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Returned payment fee" optional>
          <Input value={money(sub.longTermReturnedPaymentFee)} onChange={(e) => patch({ longTermReturnedPaymentFee: e.target.value })} />
        </Field>
        <Field label="Trash violation fee" optional>
          <Input value={money(sub.longTermTrashViolationFee)} onChange={(e) => patch({ longTermTrashViolationFee: e.target.value })} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Deposit labor rate / hour" optional>
          <Input value={money(sub.longTermDepositLaborRate)} onChange={(e) => patch({ longTermDepositLaborRate: e.target.value })} />
        </Field>
        <Field label="Deposit reissue fee" optional>
          <Input value={money(sub.longTermDepositReissueFee)} onChange={(e) => patch({ longTermDepositReissueFee: e.target.value })} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Lease-up fee %" optional>
          <Input
            value={sub.longTermLeaseUpFeePercent ? String(sub.longTermLeaseUpFeePercent) : ""}
            inputMode="numeric"
            onChange={(e) => patch({ longTermLeaseUpFeePercent: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
          />
        </Field>
        <Field label="Guest cap" optional hint="Nights a guest may stay.">
          <Input
            value={sub.longTermGuestCap ? String(sub.longTermGuestCap) : ""}
            inputMode="numeric"
            onChange={(e) => patch({ longTermGuestCap: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>
      </FieldRow>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Rules the lease states</p>
      <FieldRow cols={2}>
        <Field label="Quiet hours" optional>
          <Input value={sub.longTermQuietHours ?? ""} placeholder="10pm – 8am" onChange={(e) => patch({ longTermQuietHours: e.target.value })} />
        </Field>
        <Field label="Dispute venue" optional>
          <Input value={sub.longTermDisputeVenue ?? ""} placeholder="King County, WA" onChange={(e) => patch({ longTermDisputeVenue: e.target.value })} />
        </Field>
      </FieldRow>
      <Field group label="At the end of the term">
        <CheckboxOption
          label="Rolls to month-to-month"
          description="Otherwise the lease simply ends on its last day."
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
          <Field label="What a short stay requires" optional>
            <Textarea
              rows={2}
              value={sub.shortTermRequirements ?? ""}
              onChange={(e) => patch({ shortTermRequirements: e.target.value })}
              placeholder="Minimum nights, ID, no parties…"
            />
          </Field>
          <FieldRow cols={3}>
            <Field label="Holding deposit" optional>
              <Input value={money(sub.shortTermHoldingDeposit)} onChange={(e) => patch({ shortTermHoldingDeposit: e.target.value })} />
            </Field>
            <Field label="Application fee" optional>
              <Input value={money(sub.shortTermApplicationFee)} onChange={(e) => patch({ shortTermApplicationFee: e.target.value })} />
            </Field>
            <Field label="Month-to-month surcharge" optional>
              <Input value={money(sub.shortTermMonthToMonthSurcharge)} onChange={(e) => patch({ shortTermMonthToMonthSurcharge: e.target.value })} />
            </Field>
          </FieldRow>
          <FieldRow cols={3}>
            <Field label="Rent / night" optional>
              <Input value={money(sub.shortTermDailyCost)} onChange={(e) => patch({ shortTermDailyCost: e.target.value })} />
            </Field>
            <Field label="Deposit" optional>
              <Input value={money(sub.shortTermDeposit)} onChange={(e) => patch({ shortTermDeposit: e.target.value })} />
            </Field>
            <Field label="Move-in fee" optional>
              <Input value={money(sub.shortTermMoveInFee)} onChange={(e) => patch({ shortTermMoveInFee: e.target.value })} />
            </Field>
          </FieldRow>
          <FieldRow cols={3}>
            <Field label="Parking / month" optional>
              <Input value={money(sub.shortTermParkingMonthly)} onChange={(e) => patch({ shortTermParkingMonthly: e.target.value })} />
            </Field>
            <Field label="HOA / month" optional>
              <Input value={money(sub.shortTermHoaMonthly)} onChange={(e) => patch({ shortTermHoaMonthly: e.target.value })} />
            </Field>
            <Field label="Other monthly fees" optional>
              <Input value={money(sub.shortTermOtherMonthlyFees)} onChange={(e) => patch({ shortTermOtherMonthlyFees: e.target.value })} />
            </Field>
          </FieldRow>
        </>
      ) : (
        <p className="mt-5 rounded-xl border border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">
          Short-stay charges appear here once <span className="font-bold text-foreground">Short-term stay</span> is one
          of the types you offer.
        </p>
      )}
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
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  const payer = sub.serviceFeePayer ?? "resident";
  return (
    <>
      <Field
        label="Who pays the card processing fee"
        hint="The only money question that is not part of a lease type."
      >
        {/*
         * No promo-code field: PropLane coverage comes only from the staff-owned
         * account override (`resolveServiceFeePayerFor`); a typed code is never
         * stored (`serviceFeeWaiverCode` is stripped on save).
         */}
        <Select
          value={payer}
          onChange={(e) => patch({ serviceFeePayer: e.target.value as ManagerListingSubmissionV1["serviceFeePayer"], serviceFeeWaiverCode: undefined })}
        >
          <option value="resident">The resident pays it</option>
          <option value="manager">I pay it</option>
          <option value="proplane">PropLane absorbs it</option>
        </Select>
      </Field>

      {wholePlace ? (
        <>
          {/*
           * A home let as one household has no room to carry its rent, so this
           * is the only place it can be asked. Without it a manager on "the
           * whole place" cannot price their listing at all.
           */}
          <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Rent for the whole place</p>
          <FieldRow cols={2}>
            <Field label="Rent / month" required>
              <Input
                value={sub.entireHomeMonthlyRent ? String(sub.entireHomeMonthlyRent) : ""}
                inputMode="numeric"
                placeholder="3,200"
                onChange={(e) => patch({ entireHomeMonthlyRent: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
            <Field label="Utilities / month" optional>
              <Input
                value={money(sub.entireHomeUtilitiesEstimate)}
                placeholder="180"
                onChange={(e) => patch({ entireHomeUtilitiesEstimate: e.target.value })}
              />
            </Field>
          </FieldRow>
          <FieldRow cols={3}>
            <Field label="Prorate a partial month">
              <Select
                value={sub.entireHomeProrateMethod ?? "auto"}
                onChange={(e) => patch({ entireHomeProrateMethod: e.target.value as ManagerListingSubmissionV1["entireHomeProrateMethod"] })}
              >
                <option value="auto">Work it out automatically</option>
                <option value="daily_rate">Set a per-day rate</option>
              </Select>
            </Field>
            <Field label="Prorated rent / day" optional>
              <Input
                value={sub.entireHomeDailyRentRate ? String(sub.entireHomeDailyRentRate) : ""}
                inputMode="numeric"
                onChange={(e) => patch({ entireHomeDailyRentRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
            <Field label="Prorated utilities / day" optional>
              <Input
                value={sub.entireHomeDailyUtilitiesRate ? String(sub.entireHomeDailyUtilitiesRate) : ""}
                inputMode="numeric"
                onChange={(e) => patch({ entireHomeDailyUtilitiesRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
          </FieldRow>
          <Field label="How utilities are handled">
            <Select
              value={sub.entireHomeUtilitiesPaymentModel ?? ""}
              onChange={(e) =>
                patch({ entireHomeUtilitiesPaymentModel: e.target.value as ManagerListingSubmissionV1["entireHomeUtilitiesPaymentModel"] })
              }
            >
              <option value="">Select…</option>
              {LONG_TERM_UTILITIES_PAYMENT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </>
      ) : (
        <p className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">
          Every charge a resident pays — rent, deposit, move-in fee, application fee, utilities and your own charges —
          is set on the <span className="font-bold text-foreground">Rooms</span> step, inside the lease type it belongs
          to, so no figure is asked for twice.
        </p>
      )}

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">How rent reaches you</p>
      <Field label="Accepted for rent" hint="Card or bank on PropLane is on unless you turn it off.">
        <CheckboxMultiSelect
          hideLabel
          label="Accepted for rent"
          options={[
            { value: "axis", label: "Card or bank on PropLane" },
            { value: "zelle", label: "Zelle" },
            { value: "venmo", label: "Venmo" },
            { value: "ach", label: "ACH link" },
          ]}
          selected={[
            // `undefined` means on for PropLane's own rail — only an explicit
            // false turns it off, so a listing saved before this existed keeps
            // accepting card payments.
            ...(sub.axisPaymentsEnabled !== false ? ["axis"] : []),
            ...(sub.zellePaymentsEnabled ? ["zelle"] : []),
            ...(sub.venmoPaymentsEnabled ? ["venmo"] : []),
            ...(sub.achPaymentLinkEnabled ? ["ach"] : []),
          ]}
          emptyLabel="No rent method chosen"
          onChange={(next) =>
            patch({
              axisPaymentsEnabled: next.includes("axis"),
              zellePaymentsEnabled: next.includes("zelle"),
              venmoPaymentsEnabled: next.includes("venmo"),
              achPaymentLinkEnabled: next.includes("ach"),
            })
          }
        />
      </Field>
      {sub.zellePaymentsEnabled || sub.venmoPaymentsEnabled ? (
        <FieldRow cols={2}>
          {sub.zellePaymentsEnabled ? (
            <Field label="Zelle contact" hint="The email or phone a resident sends to.">
              <Input value={sub.zelleContact ?? ""} onChange={(e) => patch({ zelleContact: e.target.value })} />
            </Field>
          ) : null}
          {sub.venmoPaymentsEnabled ? (
            <Field label="Venmo contact">
              <Input value={sub.venmoContact ?? ""} placeholder="@handle" onChange={(e) => patch({ venmoContact: e.target.value })} />
            </Field>
          ) : null}
        </FieldRow>
      ) : null}
      {sub.achPaymentLinkEnabled ? (
        <Field label="ACH payment link">
          <Input value={sub.achPaymentLink ?? ""} placeholder="https://…" onChange={(e) => patch({ achPaymentLink: e.target.value })} />
        </Field>
      ) : null}

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">How the application fee is paid</p>
      <Field label="Accepted for the application fee" hint="Card is on unless you turn it off. The amount is set on the Rooms step.">
        <CheckboxMultiSelect
          hideLabel
          label="Accepted for the application fee"
          options={[
            { value: "card", label: "Card" },
            { value: "zelle", label: "Zelle" },
            { value: "venmo", label: "Venmo" },
            { value: "other", label: "Other" },
          ]}
          selected={[
            ...(sub.applicationFeeStripeEnabled !== false ? ["card"] : []),
            ...(sub.applicationFeeZelleEnabled ? ["zelle"] : []),
            ...(sub.applicationFeeVenmoEnabled ? ["venmo"] : []),
            ...(sub.applicationFeeOtherEnabled ? ["other"] : []),
          ]}
          emptyLabel="No method chosen"
          onChange={(next) =>
            patch({
              applicationFeeStripeEnabled: next.includes("card"),
              applicationFeeZelleEnabled: next.includes("zelle"),
              applicationFeeVenmoEnabled: next.includes("venmo"),
              applicationFeeOtherEnabled: next.includes("other"),
            })
          }
        />
      </Field>
      {sub.applicationFeeOtherEnabled ? (
        <Field label="How to pay it" hint="Shown to an applicant who picks “other”.">
          <Textarea
            rows={2}
            value={sub.applicationFeeOtherInstructions ?? ""}
            onChange={(e) => patch({ applicationFeeOtherInstructions: e.target.value })}
          />
        </Field>
      ) : null}
    </>
  );
}
function HouseMoveInGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <>
      <FieldRow cols={2}>
        <Field label="The home is available from" optional>
          <Input
            value={sub.houseMoveInAvailableDate ?? ""}
            placeholder="1 Oct 2026"
            onChange={(e) => patch({ houseMoveInAvailableDate: e.target.value })}
          />
        </Field>
        <Field label="Wifi network" optional>
          <Input value={sub.wifiNetworkName ?? ""} onChange={(e) => patch({ wifiNetworkName: e.target.value })} />
        </Field>
      </FieldRow>
      <Field label="Wifi password" optional hint="Shown to a resident only once their lease is signed.">
        <Input value={sub.wifiPassword ?? ""} onChange={(e) => patch({ wifiPassword: e.target.value })} />
      </Field>
      <FieldRow cols={2}>
        <Field label="Entry photos" optional hint="Key box, bins, parking.">
          <PhotoStrip
            label="entry"
            urls={sub.houseMoveInPhotoDataUrls ?? []}
            onChange={(next) => patch({ houseMoveInPhotoDataUrls: next })}
          />
        </Field>
        <Field label="Arrival clip" optional>
          <VideoSlot
            label="arrival"
            url={sub.houseMoveInVideoDataUrl}
            onChange={(next) => patch({ houseMoveInVideoDataUrl: next })}
          />
        </Field>
      </FieldRow>
      <Field label="Move-in instructions for the house" optional>
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
  return (
    <>
      <FieldRow cols={2}>
        <Field
          label="Application fee waive code"
          optional
          hint="Give this to an applicant and their application fee is waived."
        >
          <Input
            value={sub.applicationFeeWaiverCode ?? ""}
            placeholder="E.G. WELCOME50"
            onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Application fee" hint="Also on the Payments section.">
          <Input value={money(sub.applicationFee)} onChange={(e) => patch({ applicationFee: e.target.value })} />
        </Field>
      </FieldRow>
      <Field group label="Applying to several of your homes">
        <CheckboxOption
          label="One application may name several homes"
          checked={Boolean(sub.allowMultiplePropertyApplications)}
          onChange={(next) => patch({ allowMultiplePropertyApplications: next })}
        />
        <CheckboxOption
          label="Charge the fee only once"
          description="An applicant naming three homes pays once, not three times."
          checked={Boolean(sub.applicationFeeOnlyFirstApplication)}
          onChange={(next) => patch({ applicationFeeOnlyFirstApplication: next })}
        />
      </Field>
      <p className="mt-4 rounded-xl border border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">
        What an applicant is asked, your own questions and cosigner forms are edited in
        <span className="font-bold text-foreground"> Applications → Form</span>, so one set of questions serves every
        listing rather than drifting per home.
      </p>
    </>
  );
}

function HouseBuildingGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <>
      <FieldRow cols={2}>
        <Field label="Floor plan" optional>
          <PhotoStrip
            label="floor plan"
            max={1}
            urls={sub.propertyFloorPlanDataUrl ? [sub.propertyFloorPlanDataUrl] : []}
            onChange={(next) => patch({ propertyFloorPlanDataUrl: next[0] ?? null })}
          />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Year built" optional>
          <Input
            value={sub.yearBuilt ? String(sub.yearBuilt) : ""}
            inputMode="numeric"
            placeholder="1962"
            onChange={(e) => patch({ yearBuilt: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>
        <Field label="Layout note" optional hint="Anything the floor and bathroom counts do not capture.">
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
        optional
        hint="Titles you use elsewhere — a Facebook or Craigslist ad. The leasing assistant matches a prospect who quotes one."
      >
        <Textarea
          rows={2}
          value={sub.alsoListedAs}
          onChange={(e) => patch({ alsoListedAs: e.target.value })}
          placeholder="Cozy room near UW — $1050&#10;Magnolia house share"
        />
      </Field>
      <Field label="House rules" optional>
        <Textarea
          rows={3}
          value={sub.houseRulesText}
          onChange={(e) => patch({ houseRulesText: e.target.value })}
          placeholder="Quiet hours, guests, smoking…"
        />
      </Field>
      <Field label="General house info" optional hint="Anything a resident should know that is not a rule.">
        <Textarea
          rows={3}
          value={sub.generalHouseInfo ?? ""}
          onChange={(e) => patch({ generalHouseInfo: e.target.value })}
        />
      </Field>
      <Field label="Quick facts" optional hint="Rows in the listing sidebar. Leave empty and they are worked out for you.">
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
      <Field label="Certificate of occupancy date" optional>
        <Input
          value={sub.certificateOfOccupancyDate ?? ""}
          placeholder="2024-05-01"
          onChange={(e) => patch({ certificateOfOccupancyDate: e.target.value })}
        />
      </Field>
      <Field label="RRIO registration number" optional hint="Seattle rental registration.">
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
function StepPricing({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [leaseDocOpen, setLeaseDocOpen] = useState(false);
  return (
    <StepColumn wide>
      <StepHeading
        title="Rent, deposits and fees"
        subtitle="Every lease type you offer, what it collects before move-in, and how rent reaches you. What a resident pays is worked out beside you as you type."
      />
      <ListingPricingSections
        sub={sub}
        patch={patch}
        leaseTypesField={
          <div className="space-y-4">
            <LeaseTypesField sub={sub} patch={patch} />
            {resolveAllowedLeaseTerms(sub).includes(LONG_TERM_LEASE_TERM) ? (
              <div>
                <LongTermLengthsField sub={sub} patch={patch} />
                <p className="mt-1 text-xs text-muted">Leave all unchecked and the applicant&apos;s move-in and move-out dates set the length.</p>
              </div>
            ) : null}
          </div>
        }
        payments={<HousePaymentsGroup sub={sub} patch={patch} />}
        applications={<HouseApplicationsGroup sub={sub} patch={patch} />}
        leaseDocument={
          <AdvancedPanel
            summary="What the lease says — break-lease, holdover, quiet hours, venue"
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
function HouseKeepingGroups({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const toggleGroup = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  return (
    <div className="overflow-hidden rounded-2xl border border-border">
      <AdvancedGroup
        title="Move-in"
        description="When the home is available · wifi · entry photos and arrival clip · instructions"
        open={openGroup === "movein"}
        onToggle={() => toggleGroup("movein")}
        dataAttr="listing-v2-house-movein"
      >
        <HouseMoveInGroup sub={sub} patch={patch} />
      </AdvancedGroup>
      <AdvancedGroup
        title="The building"
        description="Listing name · year built · floor plan · utility metering · pest service · house rules · quick facts"
        open={openGroup === "building"}
        onToggle={() => toggleGroup("building")}
        dataAttr="listing-v2-house-building"
      >
        <HouseBuildingGroup sub={sub} patch={patch} />
      </AdvancedGroup>
      <AdvancedGroup
        title="Local compliance"
        description="Certificate of occupancy · RRIO registration"
        open={openGroup === "compliance"}
        onToggle={() => toggleGroup("compliance")}
        dataAttr="listing-v2-house-compliance"
      >
        <HouseComplianceGroup sub={sub} patch={patch} />
      </AdvancedGroup>
    </div>
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
};

function StepReview({
  sub,
  onJump,
}: {
  sub: ManagerListingSubmissionV1;
  /** Take the manager to the step that closes a gap, rather than describing it. */
  onJump: (stepId: (typeof LISTING_V2_STEPS)[number]["id"]) => void;
}) {
  const checks = listingReadiness(sub);
  const done = checks.filter((c) => c.state === "done").length;
  const pct = Math.round((done / checks.length) * 100);
  const open = checks.filter((c) => c.state !== "done");
  return (
    <StepColumn wide>
      <StepHeading
        title={open.length === 0 ? "Ready to publish" : `${open.length} ${open.length === 1 ? "thing needs" : "things need"} attention`}
        subtitle="Nothing here stops you publishing. Stronger listings fill it in."
      />
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
    </StepColumn>
  );
}

/* ─────────────────────────── orchestrator ─────────────────────────── */

export function ListingEditorV2({
  submission,
  onChange,
  onSaveExit,
  onClose,
  onPublish,
  title,
  busy = false,
  isEdit = false,
  saveState,
}: {
  submission: ManagerListingSubmissionV1;
  onChange: (next: ManagerListingSubmissionV1) => void;
  /** Receives the step the manager left on, so resuming lands where they were. */
  onSaveExit: (stepIndex: number) => void;
  onClose: () => void;
  onPublish: () => void;
  title: string;
  busy?: boolean;
  /** Editing a listing that is already public, rather than building a new one. */
  isEdit?: boolean;
  /** Autosave status, stated once in the header. */
  saveState?: ReactNode;
}) {
  const [step, setStep] = useState(0);
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(submission));
  /**
   * Steps the manager has actually opened.
   *
   * The rail marks a step done when it has been SEEN, not merely when it is
   * earlier in the list — on an edit a manager may only ever open Pricing, and
   * telling them Rooms is "done" because it is step 2 would be a lie.
   */
  const [visited, setVisited] = useState<Set<string>>(() => new Set([LISTING_V2_STEPS[0]!.id]));
  /** Which room and lease type the receipt is quoting. */
  const [quoteRoomId, setQuoteRoomId] = useState<string | null>(null);
  const [quoteTerm, setQuoteTerm] = useState<string | null>(null);
  // Set while a room, bathroom or shared space detail is open — see useDetailBack.
  const [closeDetail, setCloseDetail] = useState<{ run: () => void } | null>(null);
  const registerDetailBack = useMemo(
    () => (close: (() => void) | null) => setCloseDetail(close ? { run: close } : null),
    [],
  );
  const patch: Patch = (next) => onChange({ ...submission, ...next });
  const last = LISTING_V2_STEPS.length - 1;
  const stepId = LISTING_V2_STEPS[step]!.id;

  const goTo = (index: number) => {
    const target = LISTING_V2_STEPS[Math.max(0, Math.min(last, index))]!;
    setStep(LISTING_V2_STEPS.indexOf(target));
    setVisited((prev) => (prev.has(target.id) ? prev : new Set(prev).add(target.id)));
  };

  const rooms = submission.rooms ?? [];
  const leaseTerms = useMemo(() => listingLeaseTypeScopeOptions(submission), [submission]);
  const receiptTerm = quoteTerm && leaseTerms.includes(quoteTerm) ? quoteTerm : leaseTerms[0] ?? DEFAULT_QUOTE_TERM;
  const receiptRoomId = quoteRoomId && rooms.some((r) => r.id === quoteRoomId) ? quoteRoomId : rooms[0]?.id ?? null;
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

  /**
   * What the rail flags for attention.
   *
   * Drawn from the same `listingReadiness` the Review step reports, so the rail
   * and Review can never disagree about what is missing.
   */
  const attention = useMemo(() => {
    const checks = listingReadiness(submission);
    const unresolved = (id: string) => checks.find((c) => c.id === id && c.state !== "done");
    return {
      basics: [unresolved("address"), unresolved("description")].filter(Boolean).length,
      rooms: [unresolved("rooms"), unresolved("photos")].filter(Boolean).length,
      bathrooms: (submission.bathrooms ?? []).length === 0 ? 1 : 0,
      spaces: 0,
      pricing: [unresolved("terms"), unresolved("deposit")].filter(Boolean).length,
      review: 0,
    } as Record<string, number>;
  }, [submission]);

  const railSteps = LISTING_V2_STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    count:
      s.id === "rooms"
        ? rooms.length
        : s.id === "bathrooms"
          ? (submission.bathrooms ?? []).length
          : s.id === "spaces"
            ? (submission.sharedSpaces ?? []).length
            : s.id === "pricing"
              ? leaseTerms.length
              : undefined,
    attention: attention[s.id] ?? 0,
  }));

  const body = useMemo(() => {
    switch (stepId) {
      case "basics":
        return (
          <>
            <StepBasics sub={submission} patch={patch} />
            <div className="mt-8 max-w-[860px]">
              <AdvancedPanel
                summary="The building · Move-in · Local compliance"
                open={false}
                onToggle={() => undefined}
                dataAttr="listing-v2-house-keeping"
              >
                <HouseKeepingGroups sub={submission} patch={patch} />
              </AdvancedPanel>
            </div>
          </>
        );
      case "rooms":
        return <StepRooms sub={submission} patch={patch} defaults={defaults} setDefaults={setDefaults} />;
      case "bathrooms":
        return <StepBathrooms sub={submission} patch={patch} />;
      case "spaces":
        return <StepSharedSpaces sub={submission} patch={patch} />;
      case "pricing":
        return <StepPricing sub={submission} patch={patch} />;
      default:
        return <StepReview sub={submission} onJump={(id) => goTo(LISTING_V2_STEPS.findIndex((s) => s.id === id))} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, submission, defaults]);

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
      subtitle={
        isEdit
          ? `Editing the public listing for ${[submission.address, submission.city, submission.state].filter(Boolean).join(", ")}`
          : [submission.address, submission.city, submission.state].filter(Boolean).join(", ") || "New listing"
      }
      badge={
        isEdit ? (
          <span className="rounded-full bg-[var(--status-confirmed-bg)] px-2 py-0.5 text-[11.5px] font-bold text-[var(--status-confirmed-fg)]">
            Listed
          </span>
        ) : null
      }
      saveState={saveState}
      onClose={onClose}
      headerAside={<ModalAssistantStrip contextHint={assistantContext} storageScopeKey="listing-wizard-v2" />}
      rail={<StepRail steps={railSteps} current={step} onJump={goTo} visited={visited} />}
      sidePanel={sidePanel}
      footer={
        <>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={step === 0 && !closeDetail}
              onClick={() => {
                // A manager looking at Room 3 who presses the only Back on screen
                // means "back to the rooms", not "back to Basics".
                if (closeDetail) closeDetail.run();
                else goTo(step - 1);
              }}
              className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => onSaveExit(step)}
              disabled={busy}
              data-attr="listing-v2-save-exit"
              className="min-h-[44px] rounded-full px-4 text-[13.5px] font-bold text-muted hover:text-foreground disabled:opacity-60"
            >
              {isEdit ? "Save & close" : "Save & exit"}
            </button>
          </div>
          <span className="hidden text-[12.5px] text-muted sm:inline">
            Step {step + 1} of {LISTING_V2_STEPS.length}
          </span>
          {step === last ? (
            <div className="flex gap-2.5">
              {isEdit ? null : (
                <button
                  type="button"
                  onClick={() => onSaveExit(step)}
                  disabled={busy}
                  className="min-h-[44px] rounded-full border border-border bg-card px-5 text-[14px] font-bold text-foreground disabled:opacity-60"
                >
                  Keep as draft
                </button>
              )}
              <button
                type="button"
                onClick={onPublish}
                disabled={busy}
                data-attr="listing-v2-publish"
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy ? (isEdit ? "Saving…" : "Publishing…") : isEdit ? "Publish changes" : "Publish"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => goTo(step + 1)}
              data-attr="listing-v2-next"
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
            >
              Continue to {LISTING_V2_STEPS[step + 1]!.label}
            </button>
          )}
        </>
      }
    >
      <DetailBackContext.Provider value={registerDetailBack}>{body}</DetailBackContext.Provider>
      <SideBelow>{sidePanel}</SideBelow>
    </ListingWorkspace>
  );
}
