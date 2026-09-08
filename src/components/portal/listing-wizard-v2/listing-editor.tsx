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

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Input, Select, Textarea } from "@/components/ui/input";
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
  PAYMENT_AT_SIGNING_OPTIONS,
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
  type PaymentAtSigningOptionId,
} from "@/lib/manager-listing-submission";
import {
  AIRBNB_LEASE_TERM,
  CUSTOM_LEASE_TERM,
  LEASE_TERM_CHOICES,
  SHORT_TERM_LEASE_TERM,
} from "@/lib/rental-application/lease-terms";
import { LONG_TERM_UTILITIES_PAYMENT_OPTIONS } from "@/lib/listing-utilities-payment";
import {
  derivedRoomCharges,
  isUnsetCharge,
  suggestionPlaceholder,
} from "@/lib/listing-room-derived-pricing";
import { applyListingBedroomSlots } from "@/lib/manager-listing-submission";
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
  ChipRow,
  ChipToggle,
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
  StepColumn,
  StepHeading,
  WizardModal,
  WizardStepper,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";

/**
 * Five steps, not seven.
 *
 * Rent & fees and Photos were tabs full of things that belong to something
 * else: a room's deposit belongs with that room, a bathroom's photos belong
 * with that bathroom. What is genuinely house-wide — the lease lengths, the
 * application fee, the listing's own photos and description — now sits on Home
 * behind its own headings, so it is still one place, just not a place a manager
 * has to walk through to reach the rooms.
 */
export const LISTING_V2_STEPS = [
  { id: "basics", label: "Home" },
  { id: "rooms", label: "Rooms" },
  { id: "bathrooms", label: "Bathrooms" },
  { id: "spaces", label: "Shared spaces" },
  { id: "review", label: "Review" },
] as const;

const TOTAL_STEPS = LISTING_V2_STEPS.length;

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

function AmenityChips({
  presets,
  value,
  onChange,
  limit = 10,
}: {
  presets: readonly { id: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = listingAmenityLinesFromValue(value);
  const labels = presets.map((p) => p.label);
  const checked = new Set(lines.filter((l) => labels.includes(l)));
  const custom = lines.filter((l) => !labels.includes(l));
  const shown = showAll ? presets : presets.slice(0, limit);
  const write = (next: Set<string>) => onChange([...labels.filter((l) => next.has(l)), ...custom].join("\n"));
  return (
    <ChipRow>
      {shown.map((p) => (
        <ChipToggle
          key={p.id}
          label={p.label}
          on={checked.has(p.label)}
          onToggle={() => {
            const next = new Set(checked);
            if (next.has(p.label)) next.delete(p.label);
            else next.add(p.label);
            write(next);
          }}
        />
      ))}
      {presets.length > limit ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="rounded-full border border-dashed border-border px-3.5 py-1.5 text-[12px] font-semibold text-primary"
        >
          {showAll ? "Show fewer" : `+ ${presets.length - limit} more`}
        </button>
      ) : null}
    </ChipRow>
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
  const readFiles = (files: FileList | null) => {
    if (!files) return;
    const room = Math.max(0, max - urls.length);
    const picked = Array.from(files).slice(0, room);
    if (picked.length === 0) return;
    Promise.all(
      picked.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
      ),
    )
      .then((next) => onChange([...urls, ...next.filter(Boolean)]))
      .catch(() => {
        /* a file the browser could not read is simply not added */
      });
  };
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
            +
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              aria-label={`Add ${label} photos`}
              onChange={(e) => {
                readFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>
      <p className="mt-1.5 text-[12px] text-muted">
        {urls.length} of {max} added.
      </p>
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
      {url ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={url} className="h-16 w-24 rounded-lg border border-border object-cover" />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-bold text-red-700"
          >
            Remove video
          </button>
        </div>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-dashed border-border bg-accent/20 px-4 py-2 text-[12.5px] font-bold text-primary">
          Add video
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
      <p className="mt-1.5 text-[12px] text-muted">One short clip, around 14 MB.</p>
    </div>
  );
}

/* ─────────────────────────── step 1 · basics ─────────────────────────── */

function StepBasics({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const roomCount = sub.rooms?.length || sub.listingBedroomSlots || 1;
  const [openAdvanced, setOpenAdvanced] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const toggleGroup = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  return (
    <StepColumn>
      <StepHeading
        step={1}
        total={TOTAL_STEPS}
        name="Home"
        title="The home itself"
        subtitle="Where it is, what it is, and how it is laid out."
      />

      {/*
       * How you rent it comes FIRST because it changes every screen after it —
       * whether rent is per room or set once, and whether the Rooms step is
       * about bedrooms or about one household. Burying it under "More options"
       * put the most consequential answer in the least prominent place.
       */}
      <Field
        group
        label="How you rent it"
        required
        hint="Decides whether rent is set per room or once for the whole place."
      >
        <ChipRow>
          <ChipToggle
            label="By the room"
            on={rentByRoom}
            dataAttr="listing-v2-by-room"
            onToggle={() => patch({ listingPlaceCategoryId: "shared_home", rentalModelStamp: "shared_home" })}
          />
          <ChipToggle
            label="The whole place"
            on={!rentByRoom}
            dataAttr="listing-v2-whole-place"
            onToggle={() => patch({ listingPlaceCategoryId: "entire_home", rentalModelStamp: "entire_home" })}
          />
        </ChipRow>
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
      <FieldRow cols={3}>
        <Field label="City" required>
          <Input value={sub.city} onChange={(e) => patch({ city: e.target.value })} />
        </Field>
        <Field label="State" required>
          <Input value={sub.state} onChange={(e) => patch({ state: e.target.value })} />
        </Field>
        <Field label="ZIP" required>
          <Input value={sub.zip} onChange={(e) => patch({ zip: e.target.value })} />
        </Field>
      </FieldRow>

      <FieldRow cols={2}>
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
      </FieldRow>

      <FieldRow cols={2}>
        <Field label="Bathrooms" required hint="Total in the home, including half baths.">
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
        <Field
          label={rentByRoom ? "Bedrooms you are renting out" : "Bedrooms"}
          required
          hint="Creates a row per room on the next step."
        >
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

      <Field label="Layout note" optional hint="Anything the floor and bathroom counts do not capture.">
        <Input
          value={sub.homeStructureNote}
          onChange={(e) => patch({ homeStructureNote: e.target.value })}
          placeholder="3-story townhouse · 3.5 baths"
        />
      </Field>
      <FieldRow cols={2}>
        <Field label="Listing name" optional hint="The title renters see. Leave blank to use the address.">
          <Input
            value={sub.buildingName}
            onChange={(e) => patch({ buildingName: e.target.value })}
            placeholder={sub.address || "4709A 8th Ave NE"}
          />
        </Field>
        <Field label="Neighborhood" optional>
          <Input value={sub.neighborhood} onChange={(e) => patch({ neighborhood: e.target.value })} />
        </Field>
      </FieldRow>
      <Field group label="Pets">
        <ChipRow>
          <ChipToggle
            label={sub.petFriendly ? "Pets allowed, subject to approval" : "No pets"}
            on={Boolean(sub.petFriendly)}
            onToggle={() => patch({ petFriendly: !sub.petFriendly })}
            dataAttr="listing-v2-pets"
          />
        </ChipRow>
      </Field>

      {/*
       * Photos and the description are NOT behind Advanced. A listing with no
       * photo of the home is the single biggest reason an enquiry never
       * arrives, so the field a manager should not be able to miss is on the
       * page. Tagline and description sit together under one heading because
       * they are one piece of writing, not two settings.
       */}
      <p className="mb-3 mt-7 text-[13px] font-bold text-foreground">Photos and description</p>
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
      <div className="rounded-xl border border-border bg-card p-4">
        <Field label="Headline" optional hint="One line at the top of the listing.">
          <Input
            value={sub.tagline}
            onChange={(e) => patch({ tagline: e.target.value })}
            placeholder="Spacious 10-bedroom townhouse near UW"
          />
        </Field>
        <Field label="Description" optional>
          <Textarea
            rows={5}
            value={sub.houseOverview}
            onChange={(e) => patch({ houseOverview: e.target.value })}
            placeholder="Describe the home and who it suits…"
          />
        </Field>
        <Field label="Anything else worth saying" optional hint="Nicknames, landmarks, what makes it special.">
          <Textarea
            rows={2}
            value={sub.marketingNotes ?? ""}
            onChange={(e) => patch({ marketingNotes: e.target.value })}
          />
        </Field>
      </div>

      {/*
       * One Advanced panel, not two "More options" cards. Everything in it is
       * about the PROPERTY: if a value could differ between two rooms it lives
       * on the room, so a manager never has to wonder which of two screens owns
       * the deposit.
       */}
      <AdvancedPanel
        summary="Lease terms · Payments · Media · Move-in · Applications · The building · Compliance"
        open={openAdvanced}
        onToggle={() => setOpenAdvanced((v) => !v)}
        dataAttr="listing-v2-house-advanced"
      >
        <AdvancedGroup
          title="Lease terms"
          description="Types this home is let on · your own lease template · break-lease, holdover, deposit handling, quiet hours, guests, venue"
          open={openGroup === "lease"}
          onToggle={() => toggleGroup("lease")}
          dataAttr="listing-v2-house-lease"
        >
          <HouseLeaseTermsGroup sub={sub} patch={patch} />
        </AdvancedGroup>
        <AdvancedGroup
          title="Payments"
          description="Application fee and its waiver code · due at signing · rent day and late fees · card, Zelle, Venmo and ACH · extra charges"
          open={openGroup === "payments"}
          onToggle={() => toggleGroup("payments")}
          dataAttr="listing-v2-house-payments"
        >
          <HousePaymentsGroup sub={sub} patch={patch} />
        </AdvancedGroup>
        <AdvancedGroup
          title="Media"
          description="Floor plan for the property"
          open={openGroup === "media"}
          onToggle={() => toggleGroup("media")}
          dataAttr="listing-v2-house-media"
        >
          <HouseMediaGroup sub={sub} patch={patch} />
        </AdvancedGroup>
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
          title="Applications"
          description="Applying to several of your homes at once, and whether the fee is charged once"
          open={openGroup === "applications"}
          onToggle={() => toggleGroup("applications")}
          dataAttr="listing-v2-house-applications"
        >
          <HouseApplicationsGroup sub={sub} patch={patch} />
        </AdvancedGroup>
        <AdvancedGroup
          title="The building"
          description="Year built · utility metering · pest service · house rules · quick facts"
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
      </AdvancedPanel>
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
  return {
    nightly: Boolean(sub.shortTermRentalsAllowed) || Boolean(sub.airbnbRentalsAllowed),
    shortStayCharges: Boolean(sub.shortTermRentalsAllowed),
  };
}

function RoomDetail({
  room,
  sub,
  defaults,
  onChange,
  onBack,
}: {
  room: ManagerRoomSubmission;
  sub: ManagerListingSubmissionV1;
  defaults: ListingHouseDefaults;
  onChange: (next: ManagerRoomSubmission) => void;
  onBack: () => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>("room");
  const [weeklyOn, setWeeklyOn] = useState(() => Boolean(room.weeklyRentPrice));
  const toggleGroup = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  const set = (patch: Partial<ManagerRoomSubmission>) => onChange({ ...room, ...patch });
  const inheritsRent = roomInheritsDefault(room, defaults, "monthlyRent");
  const effectiveRent = room.monthlyRent > 0 ? room.monthlyRent : defaults.monthlyRent;
  const suggested = derivedRoomCharges(effectiveRent);
  const rates = roomRateVisibility(sub);

  const acceptSuggestions = () => {
    if (!suggested) return;
    set({
      securityDeposit: isUnsetCharge(room.securityDeposit) ? String(suggested.securityDeposit) : room.securityDeposit,
      moveInFee: isUnsetCharge(room.moveInFee) ? String(suggested.moveInFee) : room.moveInFee,
      dailyRentRate: room.dailyRentRate ?? suggested.dailyRent,
      // Neither weeklyRentPrice nor dailyRentPrice is filled here: a weekly rate
      // is a field the manager turns on, and a daily PRICE with a daily basis
      // changes how rent is billed.
    });
  };

  return (
    <StepColumn>
      <p className="mb-2 text-[12px] font-bold text-muted">Room</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {room.name.trim() || "Room"}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        Five sections. Open the one you need.
      </p>

      <AdvancedPanel
        summary="The room · Lease terms · Payments · Media · Move-in"
        open
        onToggle={() => undefined}
        dataAttr="listing-v2-room-advanced"
      >
        <AdvancedGroup
          title="The room"
          description="Beds · size · furnishing · what it comes with"
          open={openGroup === "room"}
          onToggle={() => toggleGroup("room")}
          dataAttr="listing-v2-room-basics"
        >
          <FieldRow cols={2}>
            <Field label="Beds" hint="How many people may live here.">
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
          <Field label="Furnishing" optional>
            <Input
              value={room.furnishing ?? ""}
              placeholder={defaults.furnishing || "Furnished — bed, desk, chair"}
              onChange={(e) => set({ furnishing: e.target.value })}
            />
          </Field>
          <Field label="Room amenities">
            <AmenityChips
              presets={ROOM_AMENITY_PRESETS}
              value={room.roomAmenitiesText ?? ""}
              onChange={(next) => set({ roomAmenitiesText: next })}
            />
          </Field>
        </AdvancedGroup>

        <AdvancedGroup
          title="Lease terms"
          description="How long this room is let for, and what an applicant gets by default"
          open={openGroup === "lease"}
          onToggle={() => toggleGroup("lease")}
          dataAttr="listing-v2-room-lease"
        >
          <p className="mb-4 text-[12px] leading-relaxed text-muted">
            This room is offered on the types the listing offers:{" "}
            <span className="font-bold text-foreground">{resolveAllowedLeaseTerms(sub).join(", ") || "none yet"}</span>.
            Change that under Home → Advanced → Lease terms.
          </p>
          <FieldRow cols={2}>
            <Field label="A short lease is up to" optional hint="Months. The surcharge below applies below this length.">
              <Input
                value={room.shortLeaseMaxMonths ? String(room.shortLeaseMaxMonths) : ""}
                inputMode="numeric"
                placeholder="5"
                onChange={(e) => set({ shortLeaseMaxMonths: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
              />
            </Field>
            <Field label="Short-lease surcharge / month" optional>
              <Input
                value={money(room.shortLeaseSurchargeMonthly)}
                onChange={(e) => set({ shortLeaseSurchargeMonthly: e.target.value })}
              />
            </Field>
          </FieldRow>
        </AdvancedGroup>

        <AdvancedGroup
          title="Payments"
          description="One rate per lease type · deposit · move-in fee · utilities · prorated rent"
          open={openGroup === "payments"}
          onToggle={() => toggleGroup("payments")}
          dataAttr="listing-v2-room-payments"
        >
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
          {suggested ? (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/[0.05] px-4 py-3">
              <p className="min-w-0 text-[12.5px] leading-relaxed text-muted">
                From ${effectiveRent}: deposit {suggested.securityDeposit} · move-in fee {suggested.moveInFee} ·
                prorated {suggested.dailyRent}/day.
              </p>
              <button
                type="button"
                onClick={acceptSuggestions}
                data-attr="listing-v2-accept-suggestions"
                className="shrink-0 rounded-full border border-primary/35 bg-primary/10 px-4 py-2 text-[12.5px] font-bold text-primary"
              >
                Fill them in
              </button>
            </div>
          ) : null}

          <p className="mb-3 text-[12.5px] font-bold text-foreground">Other rates</p>
          {weeklyOn ? (
            <Field label="Rent / week" optional hint={suggested ? `Suggested ${suggested.weeklyRent}.` : undefined}>
              <Input
                value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""}
                placeholder={suggestionPlaceholder(suggested?.weeklyRent)}
                inputMode="numeric"
                onChange={(e) => set({ weeklyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
          ) : (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border bg-card px-4 py-3">
              <p className="min-w-0 text-[12.5px] leading-relaxed text-muted">
                <span className="font-bold text-foreground">Rent / week</span> — off. A weekly figure only makes sense
                if you quote one{suggested ? `; it would be ${suggested.weeklyRent}` : ""}.
              </p>
              <button
                type="button"
                data-attr="listing-v2-room-weekly-on"
                onClick={() => setWeeklyOn(true)}
                className="shrink-0 rounded-full border border-border bg-card px-4 py-2 text-[12.5px] font-bold text-primary"
              >
                Turn on
              </button>
            </div>
          )}
          {rates.nightly ? (
            <Field
              label="Rent / night"
              optional
              hint="Offered because this listing allows short-term or Airbnb stays."
            >
              <Input
                value={room.dailyRentPrice ? String(room.dailyRentPrice) : ""}
                placeholder={suggestionPlaceholder(suggested?.dailyRent)}
                inputMode="numeric"
                onChange={(e) => set({ dailyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
          ) : (
            <p className="mb-4 rounded-xl border border-dashed border-border bg-card px-4 py-3 text-[12px] leading-relaxed text-muted">
              <span className="font-bold text-foreground">Rent / night</span> is not shown, because this listing is not
              let short-term. Add <span className="font-bold text-foreground">Short-term stay</span> under Home →
              Advanced → Lease terms and it appears here.
            </p>
          )}
          <Field label="Billed by" hint="How every rent charge is raised. No setup or suggestion changes this.">
            <Select
              value={room.rentBasis ?? "monthly"}
              onChange={(e) => set({ rentBasis: e.target.value as ManagerRoomSubmission["rentBasis"] })}
            >
              <option value="monthly">Month</option>
              <option value="weekly">Week</option>
              <option value="daily">Day</option>
            </Select>
          </Field>

          <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">This room&apos;s charges</p>
          <FieldRow cols={3}>
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
            <Field label="Utilities / month" optional>
              <Input
                value={money(room.utilitiesEstimate)}
                placeholder={defaults.utilitiesEstimate || "80"}
                onChange={(e) => set({ utilitiesEstimate: e.target.value })}
              />
            </Field>
          </FieldRow>
          <Field label="How utilities are handled" hint="Decides whether the amount above is billed or only an estimate.">
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

          <p className="mb-1 mt-5 text-[12.5px] font-bold text-foreground">Prorated rent</p>
          <p className="mb-3 text-[12px] leading-relaxed text-muted">
            Splits a partial first or last month only. This is not a headline price.
          </p>
          <FieldRow cols={3}>
            <Field label="How to split">
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
                onChange={(e) => set({ dailyRentRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
            <Field label="Prorated utilities / day" optional>
              <Input
                value={room.dailyUtilitiesRate ? String(room.dailyUtilitiesRate) : ""}
                inputMode="numeric"
                onChange={(e) => set({ dailyUtilitiesRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
          </FieldRow>

          {rates.shortStayCharges ? (
            <>
              <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Short stays</p>
              <FieldRow cols={2}>
                <Field label="Move-in fee" optional>
                  <Input value={money(room.shortTermMoveInFee)} onChange={(e) => set({ shortTermMoveInFee: e.target.value })} />
                </Field>
                <Field label="Deposit" optional>
                  <Input value={money(room.shortTermDeposit)} onChange={(e) => set({ shortTermDeposit: e.target.value })} />
                </Field>
              </FieldRow>
              <Field label="Rent / night for a short stay" optional>
                <Input value={money(room.shortTermRent)} onChange={(e) => set({ shortTermRent: e.target.value })} />
              </Field>
            </>
          ) : null}

          <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Advertised price</p>
          <FieldRow cols={3}>
            <Field label="Pricing" hint="Flexible advertises a range instead of one figure.">
              <Select
                value={room.pricingMode ?? "fixed"}
                onChange={(e) => set({ pricingMode: e.target.value as ManagerRoomSubmission["pricingMode"] })}
              >
                <option value="fixed">Fixed</option>
                <option value="flexible">Flexible</option>
              </Select>
            </Field>
            <Field label="Advertised min" optional>
              <Input
                value={room.flexibleRentMin ? String(room.flexibleRentMin) : ""}
                inputMode="numeric"
                onChange={(e) => set({ flexibleRentMin: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
            <Field label="Advertised max" optional>
              <Input
                value={room.flexibleRentMax ? String(room.flexibleRentMax) : ""}
                inputMode="numeric"
                onChange={(e) => set({ flexibleRentMax: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
              />
            </Field>
          </FieldRow>
        </AdvancedGroup>

        <AdvancedGroup
          title="Media"
          description="Photos · video · what a renter reads under this room"
          open={openGroup === "media"}
          onToggle={() => toggleGroup("media")}
          dataAttr="listing-v2-room-media"
        >
          <Field label="Photos of this room" optional>
            <PhotoStrip label="room" urls={room.photoDataUrls ?? []} onChange={(next) => set({ photoDataUrls: next })} />
          </Field>
          <Field label="Video of this room" optional>
            <VideoSlot label="room" url={room.videoDataUrl} onChange={(next) => set({ videoDataUrl: next })} />
          </Field>
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
          title="Move-in"
          description="When it is free · instructions · entry photos · arrival clip · inspections"
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
          <Field label="Entry photos" optional hint="The key box, the bins, which door — what a resident needs on arrival.">
            <PhotoStrip
              label="entry"
              urls={room.moveInPhotoDataUrls ?? []}
              onChange={(next) => set({ moveInPhotoDataUrls: next })}
            />
          </Field>
          <Field label="Arrival clip" optional>
            <VideoSlot label="arrival" url={room.moveInVideoDataUrl} onChange={(next) => set({ moveInVideoDataUrl: next })} />
          </Field>
          <Field group label="Inspections">
            <ChipRow>
              <ChipToggle
                label="On move-in"
                on={room.moveInInspectionRequired === true}
                onToggle={() => set({ moveInInspectionRequired: !room.moveInInspectionRequired })}
              />
              <ChipToggle
                label="On move-out"
                on={room.moveOutInspectionRequired === true}
                onToggle={() => set({ moveOutInspectionRequired: !room.moveOutInspectionRequired })}
              />
            </ChipRow>
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
  defaults,
  editDefault,
}: {
  defaults: ListingHouseDefaults;
  editDefault: (field: keyof ListingHouseDefaults, value: ListingHouseDefaults[keyof ListingHouseDefaults]) => void;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>("room");
  const toggle = (id: string) => setOpenGroup((prev) => (prev === id ? null : id));
  return (
    <AdvancedPanel
      summary="The room · Payments · Move-in"
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
          <Field label="Beds in most rooms">
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
          <Field label="Furnishing" optional>
            <Input
              value={defaults.furnishing}
              placeholder="Furnished — bed, desk, chair"
              onChange={(e) => editDefault("furnishing", e.target.value)}
            />
          </Field>
        </FieldRow>
        <Field label="Amenities in most rooms" optional>
          <AmenityChips
            presets={ROOM_AMENITY_PRESETS}
            value={defaults.roomAmenitiesText}
            onChange={(next) => editDefault("roomAmenitiesText", next)}
          />
        </Field>
      </AdvancedGroup>

      <AdvancedGroup
        title="Payments"
        description="Deposit · move-in fee · utilities and who pays them"
        open={openGroup === "payments"}
        onToggle={() => toggle("payments")}
        dataAttr="listing-v2-defaults-payments"
      >
        <FieldRow cols={2}>
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
        <FieldRow cols={2}>
          <Field label="Utilities / month" optional>
            <Input
              value={defaults.utilitiesEstimate}
              placeholder="80"
              onChange={(e) => editDefault("utilitiesEstimate", e.target.value)}
            />
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
      </AdvancedGroup>

      <AdvancedGroup
        title="Move-in"
        description="Inspections most rooms require"
        open={openGroup === "movein"}
        onToggle={() => toggle("movein")}
        dataAttr="listing-v2-defaults-movein"
      >
        <Field group label="Inspections for most rooms">
          <ChipRow>
            <ChipToggle
              label="On move-in"
              on={defaults.moveInInspectionRequired}
              onToggle={() => editDefault("moveInInspectionRequired", !defaults.moveInInspectionRequired)}
            />
            <ChipToggle
              label="On move-out"
              on={defaults.moveOutInspectionRequired}
              onToggle={() => editDefault("moveOutInspectionRequired", !defaults.moveOutInspectionRequired)}
            />
          </ChipRow>
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
        step={2}
        total={TOTAL_STEPS}
        name="Rooms"
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

      {openDefaults ? (
        <DefaultsDetail defaults={defaults} editDefault={editDefault} />      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <RowBulkBar count={selected.size}>
          {selected.size === 1 ? (
            <BulkButton tone="primary" onClick={() => setCopyOpen((v) => !v)}>Copy to another room</BulkButton>
          ) : null}
          {defaults.monthlyRent > 0 ? (
            <BulkButton
              onClick={() => {
                writeRooms(
                  applyHouseDefaultsToRooms(rooms, defaults, {
                    onlyFields: ["monthlyRent"],
                    roomIds: [...selected],
                  }),
                );
              }}
            >
              Set rent to ${defaults.monthlyRent}
            </BulkButton>
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
          <div className="flex flex-wrap gap-2">
            {rooms
              .filter((r) => !selected.has(r.id))
              .map((r, i) => (
                <ChipToggle
                  key={r.id}
                  label={r.name.trim() || `Room ${i + 1}`}
                  on={copyTargets.has(r.id)}
                  onToggle={() =>
                    setCopyTargets((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.id)) next.delete(r.id);
                      else next.add(r.id);
                      return next;
                    })
                  }
                />
              ))}
          </div>
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
  onChange,
  onBack,
}: {
  bath: ManagerBathroomSubmission;
  index: number;
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
      <Field label="Name" optional>
        <Input
          value={bath.name}
          placeholder={`Bathroom ${index + 1}`}
          onChange={(e) => set({ name: e.target.value })}
        />
      </Field>
      <Field group label="Fixtures">
        <ChipRow>
          <ChipToggle label="Shower" on={bath.shower} onToggle={() => set({ shower: !bath.shower })} />
          <ChipToggle label="Bathtub" on={bath.bathtub} onToggle={() => set({ bathtub: !bath.bathtub })} />
          <ChipToggle label="Toilet" on={bath.toilet} onToggle={() => set({ toilet: !bath.toilet })} />
          <ChipToggle label="Sink" on={bath.sink} onToggle={() => set({ sink: !bath.sink })} />
          <ChipToggle label="Mirror" on={bath.mirror} onToggle={() => set({ mirror: !bath.mirror })} />
        </ChipRow>
      </Field>
      <Field label="Finishes and extras" optional>
        <AmenityChips
          presets={BATHROOM_EXTRA_AMENITY_PRESETS}
          value={bath.amenitiesText ?? ""}
          onChange={(next) => set({ amenitiesText: next })}
        />
      </Field>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Photos and video</p>
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

function StepBathrooms({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openBathId, setOpenBathId] = useState<string | null>(null);
  const baths = sub.bathrooms ?? [];
  const openBath = baths.find((b) => b.id === openBathId) ?? null;
  useDetailBack(Boolean(openBath), () => setOpenBathId(null));
  if (openBath) {
    return (
      <BathroomDetail
        bath={openBath}
        index={baths.indexOf(openBath)}
        onBack={() => setOpenBathId(null)}
        onChange={(next) => patch({ bathrooms: baths.map((b) => (b.id === next.id ? next : b)) })}
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
        step={3}
        total={TOTAL_STEPS}
        name="Bathrooms"
        title={`Your ${baths.length} ${baths.length === 1 ? "bathroom" : "bathrooms"}`}
        subtitle="One row each. Open a bathroom to add fixtures, amenities and photos."
      />
      <RowList columns={cols}>
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
              onChange={(v) => patch({ bathrooms: baths.map((b) => (b.id === bath.id ? { ...b, name: v } : b)) })}
            />
            <RowSelectCell
              ariaLabel={`Floor for bathroom ${i + 1}`}
              value={bath.location ?? ""}
              options={floors}
              placeholder="Floor…"
              onChange={(v) => patch({ bathrooms: baths.map((b) => (b.id === bath.id ? { ...b, location: v } : b)) })}
            />
            <RowSelectCell
              ariaLabel={`Type of bathroom ${i + 1}`}
              value={bath.bathtub ? "full" : bath.shower ? "shower" : "half"}
              options={[
                { value: "full", label: "Full bath" },
                { value: "shower", label: "Shower only" },
                { value: "half", label: "Half bath" },
              ]}
              onChange={(v) =>
                patch({
                  bathrooms: baths.map((b) =>
                    b.id === bath.id
                      ? {
                          ...b,
                          toilet: true,
                          sink: true,
                          shower: v !== "half",
                          bathtub: v === "full",
                        }
                      : b,
                  ),
                })
              }
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
  onChange,
  onBack,
}: {
  space: ManagerSharedSpaceSubmission;
  index: number;
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
        step={4}
        total={TOTAL_STEPS}
        name="Shared spaces"
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

function HouseLeaseTermsGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const allowed = resolveAllowedLeaseTerms(sub);

  function toggleTerm(term: string) {
    const next = allowed.includes(term) ? allowed.filter((t) => t !== term) : [...allowed, term];
    patch({ allowedLeaseTerms: next, leaseTermsBody: formatLeaseTermsBodyFromAllowed(next) });
  }
  function toggleShortTerm() {
    const on = !sub.shortTermRentalsAllowed;
    const next = syncShortTermLeaseTermInAllowed(allowed.filter((t) => t !== SHORT_TERM_LEASE_TERM), on);
    patch({ shortTermRentalsAllowed: on, allowedLeaseTerms: next, leaseTermsBody: formatLeaseTermsBodyFromAllowed(next) });
  }
  function toggleAirbnb() {
    const on = !sub.airbnbRentalsAllowed;
    const next = syncAirbnbLeaseTermInAllowed(allowed.filter((t) => t !== AIRBNB_LEASE_TERM), on);
    patch({ airbnbRentalsAllowed: on, allowedLeaseTerms: next, leaseTermsBody: formatLeaseTermsBodyFromAllowed(next) });
  }

  return (
    <>
      <Field
        group
        label="Lease types you offer"
        required
        hint="An applicant chooses from exactly these. A room may narrow the list, never widen it."
      >
        <ChipRow>
          {LEASE_TERM_CHOICES.filter((t) => t !== CUSTOM_LEASE_TERM).map((term) => (
            <ChipToggle key={term} label={term} on={allowed.includes(term)} onToggle={() => toggleTerm(term)} />
          ))}
          <ChipToggle label="Short-term stay" on={Boolean(sub.shortTermRentalsAllowed)} onToggle={toggleShortTerm} />
          <ChipToggle label="Airbnb" on={Boolean(sub.airbnbRentalsAllowed)} onToggle={toggleAirbnb} />
          <ChipToggle
            label={CUSTOM_LEASE_TERM}
            on={allowed.includes(CUSTOM_LEASE_TERM)}
            onToggle={() => toggleTerm(CUSTOM_LEASE_TERM)}
          />
        </ChipRow>
      </Field>
      <p className="mb-4 text-[12px] leading-relaxed text-muted">
        Long-term is a fixed term whose length is the applicant&apos;s own move-in and move-out dates. 3, 6, 9 and
        12-month are no longer offered — a signed lease carrying one still works.
      </p>

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
        <ChipRow>
          <ChipToggle
            label="Rolls to month-to-month"
            on={Boolean(sub.rolloverToMonthToMonth)}
            onToggle={() => patch({ rolloverToMonthToMonth: !sub.rolloverToMonthToMonth })}
          />
          <ChipToggle
            label="Professional cleaning required"
            on={Boolean(sub.longTermProfessionalCleaningRequired)}
            onToggle={() => patch({ longTermProfessionalCleaningRequired: !sub.longTermProfessionalCleaningRequired })}
          />
        </ChipRow>
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
function HousePaymentsGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const signing = new Set<PaymentAtSigningOptionId>(sub.paymentAtSigningIncludes ?? []);
  const wholePlace = sub.listingPlaceCategoryId === "entire_home";
  return (
    <>
      {wholePlace ? (
        <>
          {/*
           * A home let as one household has no room to carry its rent, so this
           * is the only place it can be asked. Without it a manager on "the
           * whole place" cannot price their listing at all.
           */}
          <p className="mb-3 text-[12.5px] font-bold text-foreground">Rent for the whole place</p>
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
        </>
      ) : null}

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Applying and signing</p>
      <FieldRow cols={2}>
        <Field label="Application fee">
          <Input value={money(sub.applicationFee)} onChange={(e) => patch({ applicationFee: e.target.value })} />
        </Field>
        <Field label="Waive code" optional hint="Give this to an applicant to waive the fee.">
          <Input
            value={sub.applicationFeeWaiverCode ?? ""}
            placeholder="E.G. WELCOME50"
            onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase() })}
          />
        </Field>
      </FieldRow>
      <Field group label="Due at signing" hint="What a resident pays before they move in.">
        <ChipRow>
          {PAYMENT_AT_SIGNING_OPTIONS.map((o) => (
            <ChipToggle
              key={o.id}
              label={o.label}
              on={signing.has(o.id)}
              onToggle={() => {
                const next = new Set(signing);
                if (next.has(o.id)) next.delete(o.id);
                else next.add(o.id);
                patch({ paymentAtSigningIncludes: [...next] });
              }}
            />
          ))}
        </ChipRow>
      </Field>
      <Field label="When a holding deposit is taken">
        <Select
          value={sub.holdingDepositTiming ?? "after_approval"}
          onChange={(e) => patch({ holdingDepositTiming: e.target.value as ManagerListingSubmissionV1["holdingDepositTiming"] })}
        >
          <option value="after_approval">After I approve the application</option>
          <option value="at_application">When the application is submitted</option>
        </Select>
      </Field>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Rent day and late fees</p>
      <Field group label="Late fee">
        <ChipRow>
          <ChipToggle
            label="Charge a late fee"
            on={Boolean(sub.lateFeeEnabled)}
            onToggle={() => patch({ lateFeeEnabled: !sub.lateFeeEnabled })}
          />
        </ChipRow>
      </Field>
      <FieldRow cols={3}>
        <Field label="Rent is due">
          <Select
            value={sub.rentDueDayMode ?? "first_of_month"}
            onChange={(e) => patch({ rentDueDayMode: e.target.value as ManagerListingSubmissionV1["rentDueDayMode"] })}
          >
            <option value="first_of_month">On the 1st</option>
            <option value="last_of_month">On the last day</option>
          </Select>
        </Field>
        <Field label="Late fee" optional>
          <Input value={money(sub.lateFeeAmount)} onChange={(e) => patch({ lateFeeAmount: e.target.value })} />
        </Field>
        <Field label="Grace days" optional>
          <Input
            value={sub.lateFeeGraceDays ? String(sub.lateFeeGraceDays) : ""}
            inputMode="numeric"
            onChange={(e) => patch({ lateFeeGraceDays: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>
      </FieldRow>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">How rent reaches you</p>
      <Field group label="Accepted for rent">
        <ChipRow>
          <ChipToggle
            label="Card or bank on PropLane"
            on={sub.axisPaymentsEnabled !== false}
            onToggle={() => patch({ axisPaymentsEnabled: sub.axisPaymentsEnabled === false })}
          />
          <ChipToggle
            label="Zelle"
            on={Boolean(sub.zellePaymentsEnabled)}
            onToggle={() => patch({ zellePaymentsEnabled: !sub.zellePaymentsEnabled })}
          />
          <ChipToggle
            label="Venmo"
            on={Boolean(sub.venmoPaymentsEnabled)}
            onToggle={() => patch({ venmoPaymentsEnabled: !sub.venmoPaymentsEnabled })}
          />
          <ChipToggle
            label="ACH link"
            on={Boolean(sub.achPaymentLinkEnabled)}
            onToggle={() => patch({ achPaymentLinkEnabled: !sub.achPaymentLinkEnabled })}
          />
        </ChipRow>
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
      <Field group label="Accepted for the application fee">
        <ChipRow>
          <ChipToggle
            label="Card"
            on={sub.applicationFeeStripeEnabled !== false}
            onToggle={() => patch({ applicationFeeStripeEnabled: sub.applicationFeeStripeEnabled === false })}
          />
          <ChipToggle
            label="Zelle"
            on={Boolean(sub.applicationFeeZelleEnabled)}
            onToggle={() => patch({ applicationFeeZelleEnabled: !sub.applicationFeeZelleEnabled })}
          />
          <ChipToggle
            label="Venmo"
            on={Boolean(sub.applicationFeeVenmoEnabled)}
            onToggle={() => patch({ applicationFeeVenmoEnabled: !sub.applicationFeeVenmoEnabled })}
          />
          <ChipToggle
            label="Other"
            on={Boolean(sub.applicationFeeOtherEnabled)}
            onToggle={() => patch({ applicationFeeOtherEnabled: !sub.applicationFeeOtherEnabled })}
          />
        </ChipRow>
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

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">House-wide amounts</p>
      <p className="mb-3 text-[12px] leading-relaxed text-muted">
        Used where a room does not set its own. Set them per room when they differ.
      </p>
      <FieldRow cols={3}>
        <Field label="Security deposit" optional>
          <Input value={money(sub.securityDeposit)} onChange={(e) => patch({ securityDeposit: e.target.value })} />
        </Field>
        <Field label="Move-in fee" optional>
          <Input value={money(sub.moveInFee)} onChange={(e) => patch({ moveInFee: e.target.value })} />
        </Field>
        <Field label="Holding deposit" optional>
          <Input value={money(sub.holdingDeposit)} onChange={(e) => patch({ holdingDeposit: e.target.value })} />
        </Field>
      </FieldRow>
      <FieldRow cols={3}>
        <Field label="Parking / month" optional>
          <Input value={money(sub.parkingMonthly)} onChange={(e) => patch({ parkingMonthly: e.target.value })} />
        </Field>
        <Field label="HOA / month" optional>
          <Input value={money(sub.hoaMonthly)} onChange={(e) => patch({ hoaMonthly: e.target.value })} />
        </Field>
        <Field label="Other monthly fees" optional>
          <Input value={money(sub.otherMonthlyFees)} onChange={(e) => patch({ otherMonthlyFees: e.target.value })} />
        </Field>
      </FieldRow>
      <FieldRow cols={2}>
        <Field label="Month-to-month surcharge" optional>
          <Input value={money(sub.monthToMonthSurcharge)} onChange={(e) => patch({ monthToMonthSurcharge: e.target.value })} />
        </Field>
        <Field label="Custom-term surcharge" optional>
          <Input value={money(sub.customLeaseSurcharge)} onChange={(e) => patch({ customLeaseSurcharge: e.target.value })} />
        </Field>
      </FieldRow>
      {wholePlace ? (
        <Field label="How utilities are handled" hint="Whether the estimate above is billed or only shown.">
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
      ) : null}

      <Field label="Who pays the card processing fee" hint="Choosing PropLane applies the FREE100 code to this account.">
        <Select
          value={sub.serviceFeePayer ?? "resident"}
          onChange={(e) => patch({ serviceFeePayer: e.target.value as ManagerListingSubmissionV1["serviceFeePayer"] })}
        >
          <option value="resident">The resident</option>
          <option value="manager">I do</option>
          <option value="proplane">PropLane absorbs it</option>
        </Select>
      </Field>

      <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Extra charges on every lease</p>
      {(sub.customFees ?? []).map((fee, i) => (
        <FieldRow cols={3} key={fee.id}>
          <Field label={`Charge ${i + 1}`}>
            <Input
              value={fee.label}
              placeholder="Parking"
              onChange={(e) =>
                patch({ customFees: (sub.customFees ?? []).map((f) => (f.id === fee.id ? { ...f, label: e.target.value } : f)) })
              }
            />
          </Field>
          <Field label="Amount">
            <Input
              value={money(fee.amount)}
              onChange={(e) =>
                patch({ customFees: (sub.customFees ?? []).map((f) => (f.id === fee.id ? { ...f, amount: e.target.value } : f)) })
              }
            />
          </Field>
          <Field label="How often">
            <Select
              value={fee.frequency ?? "monthly"}
              onChange={(e) =>
                patch({
                  customFees: (sub.customFees ?? []).map((f) =>
                    f.id === fee.id ? { ...f, frequency: e.target.value as ManagerCustomFeeRow["frequency"] } : f,
                  ),
                })
              }
            >
              <option value="monthly">Monthly</option>
              <option value="one-time">One-time</option>
            </Select>
          </Field>
        </FieldRow>
      ))}
      <button
        type="button"
        data-attr="listing-v2-add-fee"
        onClick={() => patch({ customFees: [...(sub.customFees ?? []), emptyCustomFeeRow()] })}
        className="min-h-[38px] rounded-full border border-border bg-card px-4 text-[12.5px] font-bold text-primary"
      >
        Add a charge
      </button>
    </>
  );
}

function HouseMediaGroup({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  return (
    <>
      <p className="mb-4 text-[12px] leading-relaxed text-muted">
        The listing&apos;s photos, video and description are on the page above, where they are hard to miss. This is
        the drawing.
      </p>
      <Field label="Floor plan" optional hint="One image of the layout.">
        <PhotoStrip
          label="floor plan"
          max={1}
          urls={sub.propertyFloorPlanDataUrl ? [sub.propertyFloorPlanDataUrl] : []}
          onChange={(next) => patch({ propertyFloorPlanDataUrl: next[0] ?? null })}
        />
      </Field>
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
      <Field label="Entry photos" optional hint="Key box, bins, parking — what a resident needs on arrival.">
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
      <Field group label="Applying to several of your homes">
        <ChipRow>
          <ChipToggle
            label="One application may name several homes"
            on={Boolean(sub.allowMultiplePropertyApplications)}
            onToggle={() => patch({ allowMultiplePropertyApplications: !sub.allowMultiplePropertyApplications })}
          />
          <ChipToggle
            label="Charge the fee only once"
            on={Boolean(sub.applicationFeeOnlyFirstApplication)}
            onToggle={() => patch({ applicationFeeOnlyFirstApplication: !sub.applicationFeeOnlyFirstApplication })}
          />
        </ChipRow>
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
        <ChipRow>
          <ChipToggle
            label="Utilities are shared, not separately metered"
            on={Boolean(sub.sharedUtilityMetering)}
            onToggle={() => patch({ sharedUtilityMetering: !sub.sharedUtilityMetering })}
          />
          <ChipToggle
            label="Regular pest service"
            on={Boolean(sub.hasPeriodicPestService)}
            onToggle={() => patch({ hasPeriodicPestService: !sub.hasPeriodicPestService })}
          />
        </ChipRow>
      </Field>
      <Field label="Amenities in the whole house">
        <AmenityChips
          presets={HOUSE_WIDE_AMENITY_PRESETS}
          value={sub.amenitiesText}
          onChange={(next) => patch({ amenitiesText: next })}
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

function StepReview({ sub }: { sub: ManagerListingSubmissionV1 }) {
  const checks = listingReadiness(sub);
  const done = checks.filter((c) => c.state === "done").length;
  const pct = Math.round((done / checks.length) * 100);
  return (
    <StepColumn wide>
      <StepHeading
        step={5}
        total={TOTAL_STEPS}
        name="Review"
        title="Ready to publish"
        subtitle="Nothing here stops you publishing. Stronger listings fill it in."
      />
      <div className="max-w-[560px]">
        <b className="text-[13px] font-bold text-foreground">Listing completeness</b>
        <div className="my-2 h-2 overflow-hidden rounded-full bg-border">
          <span className="block h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <p className="mb-4 text-[12px] text-muted">{pct}% complete</p>
        <ul>
          {checks.map((c) => (
            <li key={c.id} className="flex items-center gap-2.5 border-b border-border/60 py-2.5 text-[13px] last:border-b-0">
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
              <span className="text-foreground">{c.label}</span>
            </li>
          ))}
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
}: {
  submission: ManagerListingSubmissionV1;
  onChange: (next: ManagerListingSubmissionV1) => void;
  /** Receives the step the manager left on, so resuming lands where they were. */
  onSaveExit: (stepIndex: number) => void;
  onClose: () => void;
  onPublish: () => void;
  title: string;
  busy?: boolean;
}) {
  const [step, setStep] = useState(0);
  const [defaults, setDefaults] = useState<ListingHouseDefaults>(() => houseDefaultsForSubmission(submission));
  // Set while a room, bathroom or shared space detail is open — see useDetailBack.
  const [closeDetail, setCloseDetail] = useState<{ run: () => void } | null>(null);
  const registerDetailBack = useMemo(
    () => (close: (() => void) | null) => setCloseDetail(close ? { run: close } : null),
    [],
  );
  const patch: Patch = (next) => onChange({ ...submission, ...next });
  const last = LISTING_V2_STEPS.length - 1;
  const stepId = LISTING_V2_STEPS[step]!.id;

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

  const body = useMemo(() => {
    switch (stepId) {
      case "basics":
        return <StepBasics sub={submission} patch={patch} />;
      case "rooms":
        return <StepRooms sub={submission} patch={patch} defaults={defaults} setDefaults={setDefaults} />;
      case "bathrooms":
        return <StepBathrooms sub={submission} patch={patch} />;
      case "spaces":
        return <StepSharedSpaces sub={submission} patch={patch} />;
      default:
        return <StepReview sub={submission} />;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, submission, defaults]);

  return (
    <WizardModal
      title={title}
      onClose={onClose}
      headerAside={<ModalAssistantStrip contextHint={assistantContext} storageScopeKey="listing-wizard-v2" />}
      stepper={<WizardStepper steps={LISTING_V2_STEPS} current={step} onJump={setStep} />}
      footer={
        <>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={step === 0 && !closeDetail}
              onClick={() => {
                if (closeDetail) closeDetail.run();
                else setStep((s) => Math.max(0, s - 1));
              }}
              className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
            >
              Back
            </button>
            {/* Saving lives here, next to the other actions, rather than in the
                header corner where it competed with Ask PropLane and the close. */}
            <button
              type="button"
              onClick={() => onSaveExit(step)}
              disabled={busy}
              data-attr="listing-v2-save-exit"
              className="min-h-[44px] rounded-full px-4 text-[13.5px] font-bold text-muted hover:text-foreground disabled:opacity-60"
            >
              Save &amp; exit
            </button>
          </div>
          {step === last ? (
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => onSaveExit(step)}
                disabled={busy}
                className="min-h-[44px] rounded-full border border-border bg-card px-5 text-[14px] font-bold text-foreground disabled:opacity-60"
              >
                Keep as draft
              </button>
              <button
                type="button"
                onClick={onPublish}
                disabled={busy}
                data-attr="listing-v2-publish"
                className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(last, s + 1))}
              data-attr="listing-v2-next"
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
            >
              Next
            </button>
          )}
        </>
      }
    >
      <DetailBackContext.Provider value={registerDetailBack}>{body}</DetailBackContext.Provider>
    </WizardModal>
  );
}
