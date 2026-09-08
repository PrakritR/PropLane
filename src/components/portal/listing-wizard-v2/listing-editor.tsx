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

import { useMemo, useState } from "react";
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
import { derivedRoomCharges, isUnsetCharge, suggestionPlaceholder } from "@/lib/listing-room-derived-pricing";
import { applyListingBedroomSlots } from "@/lib/manager-listing-submission";
import {
  applyHouseDefaultsToRooms,
  houseDefaultsForSubmission,
  roomInheritsDefault,
  roomOverriddenDefaults,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  AddRowButton,
  BulkButton,
  ChipRow,
  ChipToggle,
  Field,
  FieldRow,
  MoreOptions,
  Row,
  RowBulkBar,
  RowCell,
  RowList,
  RowSelectCell,
  StepColumn,
  StepHeading,
  WizardModal,
  WizardStepper,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";

export const LISTING_V2_STEPS = [
  { id: "basics", label: "Home" },
  { id: "rooms", label: "Rooms" },
  { id: "bathrooms", label: "Bathrooms" },
  { id: "spaces", label: "Shared spaces" },
  { id: "money", label: "Rent & fees" },
  { id: "marketing", label: "Photos" },
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
    </StepColumn>
  );
}

/* ─────────────────────────── step 2 · rooms ─────────────────────────── */

function RoomDetail({
  room,
  defaults,
  onChange,
  onBack,
}: {
  room: ManagerRoomSubmission;
  defaults: ListingHouseDefaults;
  onChange: (next: ManagerRoomSubmission) => void;
  onBack: () => void;
}) {
  const [openMore, setOpenMore] = useState(false);
  const set = (patch: Partial<ManagerRoomSubmission>) => onChange({ ...room, ...patch });
  const inheritsRent = roomInheritsDefault(room, defaults, "monthlyRent");
  // Suggestions from the rent, shown in the empty fields. They are never written
  // behind the manager's back: a deposit is legally capped in some places, and
  // setting a weekly or daily rate changes how rent is billed.
  const effectiveRent = room.monthlyRent > 0 ? room.monthlyRent : defaults.monthlyRent;
  const suggested = derivedRoomCharges(effectiveRent);
  const acceptSuggestions = () => {
    if (!suggested) return;
    set({
      securityDeposit: isUnsetCharge(room.securityDeposit) ? String(suggested.securityDeposit) : room.securityDeposit,
      moveInFee: isUnsetCharge(room.moveInFee) ? String(suggested.moveInFee) : room.moveInFee,
      weeklyRentPrice: isUnsetCharge(room.weeklyRentPrice) ? suggested.weeklyRent : room.weeklyRentPrice,
      // dailyRentPrice is deliberately NOT filled: a daily price with
      // rentBasis "daily" changes billing, so it stays an explicit choice.
    });
  };
  return (
    <StepColumn>
      <p className="mb-2 text-[12px] font-bold text-muted">Room</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {room.name.trim() || "Room"}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        Only what most managers fill in. Everything else is one click away.
      </p>

      <Field
        label="Rent / month"
        hint={inheritsRent && defaults.monthlyRent > 0 ? `Following the house default of $${defaults.monthlyRent}.` : undefined}
      >
        <Input
          value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
          inputMode="numeric"
          placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
          onChange={(e) => set({ monthlyRent: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })}
        />
      </Field>
      <Field label="Beds (residents)" hint="How many people may live in this room.">
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

      <MoreOptions
        label="More options — other rates, short stays, prorated rent, amenities, furniture, inspections"
        open={openMore}
        onToggle={() => setOpenMore((v) => !v)}
        dataAttr="listing-v2-room-more"
      >
        {suggested ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-accent/25 px-4 py-3">
            <p className="min-w-0 text-[12.5px] leading-relaxed text-muted">
              Empty money fields below show what PropLane would use, worked out from the ${effectiveRent} rent.
            </p>
            <button
              type="button"
              onClick={acceptSuggestions}
              data-attr="listing-v2-accept-suggestions"
              className="shrink-0 rounded-full border border-primary/35 bg-primary/10 px-4 py-2 text-[12.5px] font-bold text-primary"
            >
              Use these
            </button>
          </div>
        ) : null}
        <p className="mb-3 text-[12.5px] font-bold text-foreground">Other ways to price this room</p>
        <FieldRow cols={3}>
          <Field label="Billed by" hint="Changes the headline price.">
            <Select
              value={room.rentBasis ?? "monthly"}
              onChange={(e) => set({ rentBasis: e.target.value as ManagerRoomSubmission["rentBasis"] })}
            >
              <option value="monthly">Month</option>
              <option value="weekly">Week</option>
              <option value="daily">Day</option>
            </Select>
          </Field>
          <Field
            label="Rent / week"
            optional
            hint={suggested ? `Suggested ${suggested.weeklyRent} from the monthly rent.` : undefined}
          >
            <Input
              value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""}
              placeholder={suggestionPlaceholder(suggested?.weeklyRent)}
              inputMode="numeric"
              onChange={(e) => set({ weeklyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
            />
          </Field>
          <Field
            label="Rent / day"
            optional
            hint={
              suggested
                ? `Suggested ${suggested.dailyRent}. Setting this changes how rent is billed, so it is never filled in for you.`
                : "The room's own daily rate."
            }
          >
            <Input
              value={room.dailyRentPrice ? String(room.dailyRentPrice) : ""}
              placeholder={suggestionPlaceholder(suggested?.dailyRent)}
              inputMode="numeric"
              onChange={(e) => set({ dailyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
            />
          </Field>
        </FieldRow>

        <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">This room&apos;s own charges</p>
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
          <Field label="Move-in fee" optional hint={suggested ? `Suggested ${suggested.moveInFee}.` : undefined}>
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
        <FieldRow cols={2}>
          <Field label="How utilities are handled" hint="Decides whether the amount above is billed or only an estimate.">
            <Select
              value={room.utilitiesPaymentModel ?? ""}
              onChange={(e) =>
                set({ utilitiesPaymentModel: e.target.value as ManagerRoomSubmission["utilitiesPaymentModel"] })
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
          <Field label="Short lease surcharge / month" optional hint="Added for leases under the length you set below.">
            <Input
              value={money(room.shortLeaseSurchargeMonthly)}
              onChange={(e) => set({ shortLeaseSurchargeMonthly: e.target.value })}
            />
          </Field>
        </FieldRow>

        <p className="mb-1 mt-5 text-[12.5px] font-bold text-foreground">Prorated rent</p>
        <p className="mb-3 text-[12px] leading-relaxed text-muted">
          Used only to split a partial first or last month. This is not a headline price.
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

        <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Short stays</p>
        <FieldRow cols={3}>
          <Field label="Rent / night" optional>
            <Input value={money(room.shortTermRent)} onChange={(e) => set({ shortTermRent: e.target.value })} />
          </Field>
          <Field label="Move-in fee" optional>
            <Input
              value={money(room.shortTermMoveInFee)}
              onChange={(e) => set({ shortTermMoveInFee: e.target.value })}
            />
          </Field>
          <Field label="Deposit" optional>
            <Input value={money(room.shortTermDeposit)} onChange={(e) => set({ shortTermDeposit: e.target.value })} />
          </Field>
        </FieldRow>

        <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">Flexible pricing</p>
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
        <Field label="A short lease is up to" optional hint="Months. The surcharge above applies below this length.">
          <Input
            value={room.shortLeaseMaxMonths ? String(room.shortLeaseMaxMonths) : ""}
            inputMode="numeric"
            placeholder="5"
            onChange={(e) => set({ shortLeaseMaxMonths: Number(e.target.value.replace(/[^0-9]/g, "")) || undefined })}
          />
        </Field>

        <div className="mt-5">
          <Field label="Furnishing" optional hint="What this room comes with.">
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
          <Field group label="Inspections">
            <ChipRow>
              <ChipToggle
                label="Move-in inspection"
                on={room.moveInInspectionRequired === true}
                onToggle={() => set({ moveInInspectionRequired: !room.moveInInspectionRequired })}
              />
              <ChipToggle
                label="Move-out inspection"
                on={room.moveOutInspectionRequired === true}
                onToggle={() => set({ moveOutInspectionRequired: !room.moveOutInspectionRequired })}
              />
            </ChipRow>
          </Field>
          <Field label="Photos of this room" optional>
            <PhotoStrip
              label="room"
              urls={room.photoDataUrls ?? []}
              onChange={(next) => set({ photoDataUrls: next })}
            />
          </Field>
          <Field label="Video of this room" optional>
            <VideoSlot label="room" url={room.videoDataUrl} onChange={(next) => set({ videoDataUrl: next })} />
          </Field>
          <Field label="Move-in instructions for this room" optional>
            <Textarea
              rows={3}
              value={room.moveInInstructions ?? ""}
              onChange={(e) => set({ moveInInstructions: e.target.value })}
              placeholder="Door code, key box, which entrance to use…"
            />
          </Field>
        </div>
      </MoreOptions>

      <button
        type="button"
        onClick={onBack}
        className="mt-5 min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
      >
        Back to rooms
      </button>
    </StepColumn>
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
  const [copyTargets, setCopyTargets] = useState<Set<string>>(new Set());
  const rooms = sub.rooms ?? [];
  const openRoom = rooms.find((r) => r.id === openRoomId) ?? null;

  function writeRooms(next: ManagerRoomSubmission[]) {
    patch({ rooms: next });
  }

  function editDefault(field: keyof ListingHouseDefaults, value: ListingHouseDefaults[keyof ListingHouseDefaults]) {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    // Inheritance is judged against the PREVIOUS default — see
    // applyHouseDefaultsToRooms. Judging against the new one freezes every room.
    writeRooms(applyHouseDefaultsToRooms(rooms, next, { onlyFields: [field], previousDefaults: previous }));
  }

  if (openRoom) {
    return (
      <RoomDetail
        room={openRoom}
        defaults={defaults}
        onBack={() => setOpenRoomId(null)}
        onChange={(next) => writeRooms(rooms.map((r) => (r.id === next.id ? next : r)))}
      />
    );
  }

  const columns = [
    { key: "name", label: "Room" },
    { key: "floor", label: "Floor" },
    { key: "bathroom", label: "Bathroom" },
    { key: "access", label: "Access" },
    { key: "rent", label: "Rent" },
    { key: "beds", label: "Beds" },
    { key: "details", label: "" },
  ];
  const floorOptions = floorLevelSelectOptions(sub.listingStoriesId, "").map((l) => ({ value: l, label: l }));
  const baths = sub.bathrooms ?? [];
  const bathOptions = baths.map((b, i) => ({ value: b.id, label: b.name.trim() || `Bathroom ${i + 1}` }));

  /**
   * Which bathroom a room uses is stored on the BATHROOM (`assignedRoomIds`),
   * because one bathroom serves many rooms. The row shows it from the room's
   * side, so writing it means moving the room's id between bathrooms rather
   * than setting a field on the room.
   */
  const bathroomForRoom = (roomId: string): string =>
    baths.find((b) => (b.assignedRoomIds ?? []).includes(roomId))?.id ?? "";
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
    patch({
      bathrooms: baths.map((b) =>
        (b.assignedRoomIds ?? []).includes(roomId)
          ? { ...b, accessKindByRoomId: { ...(b.accessKindByRoomId ?? {}), [roomId]: next } }
          : b,
      ),
    });
  };
  const assignBathroom = (roomId: string, bathId: string) => {
    patch({
      bathrooms: baths.map((b) => {
        const without = (b.assignedRoomIds ?? []).filter((id) => id !== roomId);
        return { ...b, assignedRoomIds: b.id === bathId ? [...without, roomId] : without };
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

      <div className="mb-4 rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <b className="text-[13px] font-bold text-foreground">Most rooms are…</b>
          <span className="text-[11.5px] text-muted">applied to all {rooms.length} · any row can differ</span>
        </div>
        <FieldRow cols={4}>
          <Field label="Rent / month">
            <Input
              value={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : ""}
              inputMode="numeric"
              placeholder="1,050"
              onChange={(e) => editDefault("monthlyRent", Number(e.target.value.replace(/[^0-9.]/g, "")) || 0)}
            />
          </Field>
          <Field label="Deposit">
            <Input
              value={defaults.securityDeposit}
              placeholder="500"
              onChange={(e) => editDefault("securityDeposit", e.target.value)}
            />
          </Field>
          <Field label="Furnishing">
            <Select value={defaults.furnishing} onChange={(e) => editDefault("furnishing", e.target.value)}>
              <option value="">Select…</option>
              <option value="Furnished">Furnished</option>
              <option value="Unfurnished">Unfurnished</option>
            </Select>
          </Field>
          <Field label="Beds">
            <Select
              value={String(defaults.occupancyCapacity)}
              onChange={(e) => editDefault("occupancyCapacity", Number(e.target.value) || 1)}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </FieldRow>

        <MoreOptions
          label="Furnishing details, amenities, move-in fee, utilities and inspections for most rooms"
          open={openDefaults}
          onToggle={() => setOpenDefaults((v) => !v)}
          dataAttr="listing-v2-more-defaults"
        >
          <FieldRow cols={2}>
            <Field label="Move-in fee" optional>
              <Input
                value={defaults.moveInFee}
                placeholder="0"
                onChange={(e) => editDefault("moveInFee", e.target.value)}
              />
            </Field>
            <Field label="Utilities / month" optional>
              <Input
                value={defaults.utilitiesEstimate}
                placeholder="80"
                onChange={(e) => editDefault("utilitiesEstimate", e.target.value)}
              />
            </Field>
          </FieldRow>
          <Field label="What the furnishing includes" optional hint="Shown on every room that follows the house.">
            <Input
              value={defaults.furnishing}
              placeholder="Furnished — bed, desk, chair, dresser"
              onChange={(e) => editDefault("furnishing", e.target.value)}
            />
          </Field>
          <Field label="Amenities in most rooms" optional>
            <AmenityChips
              presets={ROOM_AMENITY_PRESETS}
              value={defaults.roomAmenitiesText}
              onChange={(next) => editDefault("roomAmenitiesText", next)}
            />
          </Field>
          <Field group label="Inspections for most rooms">
            <ChipRow>
              <ChipToggle
                label="Move-in inspection"
                on={defaults.moveInInspectionRequired}
                onToggle={() => editDefault("moveInInspectionRequired", !defaults.moveInInspectionRequired)}
              />
              <ChipToggle
                label="Move-out inspection"
                on={defaults.moveOutInspectionRequired}
                onToggle={() => editDefault("moveOutInspectionRequired", !defaults.moveOutInspectionRequired)}
              />
            </ChipRow>
          </Field>
        </MoreOptions>
      </div>

      <RowList columns={columns}>
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
                onChange={(v) => writeRooms(rooms.map((r) => (r.id === room.id ? { ...r, name: v } : r)))}
              />
              <RowSelectCell
                ariaLabel={`Floor for ${room.name || `room ${i + 1}`}`}
                value={room.floor}
                options={floorOptions}
                placeholder="Floor…"
                onChange={(v) => writeRooms(rooms.map((r) => (r.id === room.id ? { ...r, floor: v } : r)))}
              />
              <RowSelectCell
                ariaLabel={`Bathroom for ${room.name || `room ${i + 1}`}`}
                value={bathroomForRoom(room.id)}
                options={bathOptions}
                placeholder={bathOptions.length ? "Pick one…" : "Add one first"}
                onChange={(v) => assignBathroom(room.id, v)}
              />
              <RowSelectCell
                ariaLabel={`Bathroom access for ${room.name || `room ${i + 1}`}`}
                value={accessForRoom(room.id)}
                options={BATHROOM_ACCESS_OPTIONS}
                placeholder="Shared"
                onChange={(v) => setAccessForRoom(room.id, v)}
              />
              <RowCell
                ariaLabel={`Rent for ${room.name || `room ${i + 1}`}`}
                inputMode="numeric"
                inherited={rentInherited}
                value={room.monthlyRent > 0 ? String(room.monthlyRent) : ""}
                placeholder={defaults.monthlyRent > 0 ? String(defaults.monthlyRent) : "1,050"}
                onChange={(v) =>
                  writeRooms(
                    rooms.map((r) =>
                      r.id === room.id ? { ...r, monthlyRent: Number(v.replace(/[^0-9.]/g, "")) || 0 } : r,
                    ),
                  )
                }
              />
              <RowCell
                ariaLabel={`Beds in ${room.name || `room ${i + 1}`}`}
                inputMode="numeric"
                inherited={bedsInherited}
                value={room.occupancyCapacity ? String(room.occupancyCapacity) : ""}
                placeholder={String(defaults.occupancyCapacity)}
                onChange={(v) =>
                  writeRooms(
                    rooms.map((r) =>
                      r.id === room.id ? { ...r, occupancyCapacity: Number(v.replace(/[^0-9]/g, "")) || 1 } : r,
                    ),
                  )
                }
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
        Dashed grey means the room is using the house default. Type over it to make that room different.
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
        Fixtures, finishes and photos for this bathroom.
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

function StepMoney({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [openMore, setOpenMore] = useState(false);
  const allowed = resolveAllowedLeaseTerms(sub);
  const signing = new Set<PaymentAtSigningOptionId>(sub.paymentAtSigningIncludes ?? []);

  function toggleTerm(term: string) {
    const has = allowed.includes(term);
    const next = has ? allowed.filter((t) => t !== term) : [...allowed, term];
    patch({ allowedLeaseTerms: next, leaseTermsBody: formatLeaseTermsBodyFromAllowed(next) });
  }

  function toggleShortTerm() {
    const on = !sub.shortTermRentalsAllowed;
    const base = allowed.filter((t) => t !== SHORT_TERM_LEASE_TERM);
    const next = syncShortTermLeaseTermInAllowed(base, on);
    patch({
      shortTermRentalsAllowed: on,
      allowedLeaseTerms: next,
      leaseTermsBody: formatLeaseTermsBodyFromAllowed(next),
    });
  }

  function toggleAirbnb() {
    const on = !sub.airbnbRentalsAllowed;
    const base = allowed.filter((t) => t !== AIRBNB_LEASE_TERM);
    const next = syncAirbnbLeaseTermInAllowed(base, on);
    patch({
      airbnbRentalsAllowed: on,
      allowedLeaseTerms: next,
      leaseTermsBody: formatLeaseTermsBodyFromAllowed(next),
    });
  }

  return (
    <StepColumn>
      <StepHeading
        step={4}
        total={TOTAL_STEPS}
        name="Rent & fees"
        title="What a resident pays"
        subtitle="Rent comes from the Rooms step. This is everything on top of it."
      />
      <Field group label="Lease lengths you offer" required hint="At least one. This is what an applicant chooses from.">
        <ChipRow>
          {LEASE_TERM_CHOICES.filter((t) => t !== CUSTOM_LEASE_TERM).map((term) => (
            <ChipToggle key={term} label={term} on={allowed.includes(term)} onToggle={() => toggleTerm(term)} />
          ))}
          <ChipToggle label="Short-term" on={Boolean(sub.shortTermRentalsAllowed)} onToggle={toggleShortTerm} />
          <ChipToggle label="Airbnb" on={Boolean(sub.airbnbRentalsAllowed)} onToggle={toggleAirbnb} />
          <ChipToggle
            label={CUSTOM_LEASE_TERM}
            on={allowed.includes(CUSTOM_LEASE_TERM)}
            onToggle={() => toggleTerm(CUSTOM_LEASE_TERM)}
          />
        </ChipRow>
      </Field>
      <Field label="Security deposit" hint="Set it per room on the Rooms step when it differs.">
        <Input value={money(sub.securityDeposit)} onChange={(e) => patch({ securityDeposit: e.target.value })} />
      </Field>
      <Field label="Application fee">
        <Input value={money(sub.applicationFee)} onChange={(e) => patch({ applicationFee: e.target.value })} />
      </Field>
      <Field label="Move-in fee" optional>
        <Input value={money(sub.moveInFee)} onChange={(e) => patch({ moveInFee: e.target.value })} />
      </Field>
      <Field label="Utilities" optional hint="Shown to renters as an estimate.">
        <Input
          value={money(sub.entireHomeUtilitiesEstimate)}
          placeholder="80"
          onChange={(e) => patch({ entireHomeUtilitiesEstimate: e.target.value })}
        />
      </Field>

      <MoreOptions
        label="More options — waiver code, due at signing, late fees, parking, HOA, surcharges, who pays the card fee"
        open={openMore}
        onToggle={() => setOpenMore((v) => !v)}
        dataAttr="listing-v2-money-more"
      >
        <Field
          label="Application fee waive code"
          optional
          hint="Give this to an applicant to waive the application fee."
        >
          <Input
            value={sub.applicationFeeWaiverCode ?? ""}
            placeholder="E.G. WELCOME50"
            onChange={(e) => patch({ applicationFeeWaiverCode: e.target.value.toUpperCase() })}
          />
        </Field>
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
        <FieldRow cols={2}>
          <Field label="Rent due">
            <Select
              value={sub.rentDueDayMode ?? "first_of_month"}
              onChange={(e) =>
                patch({ rentDueDayMode: e.target.value as ManagerListingSubmissionV1["rentDueDayMode"] })
              }
            >
              <option value="first_of_month">1st of the month</option>
              <option value="last_of_month">Last day of the month</option>
            </Select>
          </Field>
          <Field label="Utilities billing">
            <Select
              value={sub.entireHomeUtilitiesPaymentModel ?? ""}
              onChange={(e) =>
                patch({
                  entireHomeUtilitiesPaymentModel: e.target
                    .value as ManagerListingSubmissionV1["entireHomeUtilitiesPaymentModel"],
                })
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
        </FieldRow>
        <FieldRow cols={3}>
          <Field label="Late fee after">
            <Input
              value={sub.lateFeeGraceDays != null ? String(sub.lateFeeGraceDays) : ""}
              inputMode="numeric"
              placeholder="5"
              onChange={(e) => patch({ lateFeeGraceDays: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })}
            />
          </Field>
          <Field label="Late fee amount">
            <Input
              value={money(sub.lateFeeAmount)}
              placeholder="50"
              onChange={(e) => patch({ lateFeeAmount: e.target.value })}
            />
          </Field>
          <Field group label="Charge automatically">
            <ChipRow>
              <ChipToggle
                label={sub.lateFeeEnabled ? "On" : "Off"}
                on={Boolean(sub.lateFeeEnabled)}
                onToggle={() => patch({ lateFeeEnabled: !sub.lateFeeEnabled })}
              />
            </ChipRow>
          </Field>
        </FieldRow>
        <FieldRow cols={3}>
          <Field label="Parking / month" optional>
            <Input value={money(sub.parkingMonthly)} onChange={(e) => patch({ parkingMonthly: e.target.value })} />
          </Field>
          <Field label="HOA / month" optional>
            <Input value={money(sub.hoaMonthly)} onChange={(e) => patch({ hoaMonthly: e.target.value })} />
          </Field>
          <Field label="Holding deposit" optional>
            <Input value={money(sub.holdingDeposit)} onChange={(e) => patch({ holdingDeposit: e.target.value })} />
          </Field>
        </FieldRow>
        <FieldRow cols={3}>
          <Field label="Month-to-month surcharge" optional>
            <Input
              value={money(sub.monthToMonthSurcharge)}
              onChange={(e) => patch({ monthToMonthSurcharge: e.target.value })}
            />
          </Field>
          <Field label="Custom-lease surcharge" optional>
            <Input
              value={money(sub.customLeaseSurcharge)}
              onChange={(e) => patch({ customLeaseSurcharge: e.target.value })}
            />
          </Field>
          <Field label="Other monthly fees" optional>
            <Input
              value={money(sub.otherMonthlyFees)}
              onChange={(e) => patch({ otherMonthlyFees: e.target.value })}
            />
          </Field>
        </FieldRow>
        <div className="mb-4">
          <p className="mb-1 text-[12.5px] font-bold text-foreground">Your own charges</p>
          <p className="mb-3 text-[12px] leading-relaxed text-muted">
            Anything not already listed — a pet fee, a parking spot, a cleaning charge.
          </p>
          {(sub.customFees ?? []).map((fee, i) => (
            <div key={fee.id} className="mb-2 grid gap-2 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
              <Input
                value={fee.label}
                placeholder="Pet fee"
                aria-label={`Name of charge ${i + 1}`}
                onChange={(e) =>
                  patch({
                    customFees: (sub.customFees ?? []).map((f) =>
                      f.id === fee.id ? { ...f, label: e.target.value } : f,
                    ),
                  })
                }
              />
              <Input
                value={money(fee.amount)}
                placeholder="50"
                aria-label={`Amount of charge ${i + 1}`}
                onChange={(e) =>
                  patch({
                    customFees: (sub.customFees ?? []).map((f) =>
                      f.id === fee.id ? { ...f, amount: e.target.value } : f,
                    ),
                  })
                }
              />
              <Select
                value={fee.frequency ?? "monthly"}
                aria-label={`How often charge ${i + 1} is billed`}
                onChange={(e) =>
                  patch({
                    customFees: (sub.customFees ?? []).map((f) =>
                      f.id === fee.id
                        ? { ...f, frequency: e.target.value as ManagerCustomFeeRow["frequency"] }
                        : f,
                    ),
                  })
                }
              >
                <option value="monthly">Every month</option>
                <option value="one-time">Once</option>
              </Select>
              <button
                type="button"
                aria-label={`Remove charge ${i + 1}`}
                onClick={() => patch({ customFees: (sub.customFees ?? []).filter((f) => f.id !== fee.id) })}
                className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-accent/50"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            data-attr="listing-v2-add-fee"
            onClick={() => patch({ customFees: [...(sub.customFees ?? []), emptyCustomFeeRow()] })}
            className="rounded-full border border-dashed border-border px-4 py-2 text-[12.5px] font-bold text-primary"
          >
            + Add a charge
          </button>
        </div>

        <Field label="Processing fee paid by" hint="Who covers the card or bank fee on a rent payment.">
          <Select
            value={sub.serviceFeePayer ?? "resident"}
            onChange={(e) =>
              patch({ serviceFeePayer: e.target.value as ManagerListingSubmissionV1["serviceFeePayer"] })
            }
          >
            <option value="resident">Resident</option>
            <option value="manager">Me, the manager</option>
            <option value="proplane">PropLane absorbs it</option>
          </Select>
        </Field>
        <FieldRow cols={3}>
          <Field label="Short stay · rent / night" optional>
            <Input
              value={money(sub.shortTermDailyCost)}
              onChange={(e) => patch({ shortTermDailyCost: e.target.value })}
            />
          </Field>
          <Field label="Short stay · deposit" optional>
            <Input value={money(sub.shortTermDeposit)} onChange={(e) => patch({ shortTermDeposit: e.target.value })} />
          </Field>
          <Field label="Short stay · move-in fee" optional>
            <Input
              value={money(sub.shortTermMoveInFee)}
              onChange={(e) => patch({ shortTermMoveInFee: e.target.value })}
            />
          </Field>
        </FieldRow>
      </MoreOptions>
    </StepColumn>
  );
}

/* ─────────────────────── step 5 · photos & words ─────────────────────── */

function StepMarketing({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [openMore, setOpenMore] = useState(false);
  return (
    <StepColumn>
      <StepHeading
        step={6}
        total={TOTAL_STEPS}
        name="Photos & description"
        title="How it looks and reads"
        subtitle="Listings with a photo of every room get far more enquiries."
      />
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
      <Field label="Tagline" optional hint="One line at the top of the listing.">
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
      <Field label="Amenities" hint="Kitchen gear belongs to a shared space; bathroom finishes to a bathroom.">
        <AmenityChips
          presets={HOUSE_WIDE_AMENITY_PRESETS}
          value={sub.amenitiesText}
          onChange={(next) => patch({ amenitiesText: next })}
        />
      </Field>

      <Field
        label="Quick facts"
        optional
        hint="Rows you add replace the auto-generated At a glance card on the listing."
      >
        <div>
          {(sub.quickFacts ?? []).map((qf, i) => (
            <div key={qf.id} className="mb-2 grid gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
              <Input
                value={qf.label}
                placeholder="Neighborhood"
                aria-label={`Quick fact ${i + 1} label`}
                onChange={(e) =>
                  patch({
                    quickFacts: (sub.quickFacts ?? []).map((q) =>
                      q.id === qf.id ? { ...q, label: e.target.value } : q,
                    ),
                  })
                }
              />
              <Input
                value={qf.value}
                placeholder="U District, 5 min to campus"
                aria-label={`Quick fact ${i + 1} value`}
                onChange={(e) =>
                  patch({
                    quickFacts: (sub.quickFacts ?? []).map((q) =>
                      q.id === qf.id ? { ...q, value: e.target.value } : q,
                    ),
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove quick fact ${i + 1}`}
                onClick={() => patch({ quickFacts: (sub.quickFacts ?? []).filter((q) => q.id !== qf.id) })}
                className="grid h-11 w-11 place-items-center rounded-lg text-muted hover:bg-accent/50"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            data-attr="listing-v2-add-quickfact"
            onClick={() => patch({ quickFacts: [...(sub.quickFacts ?? []), emptyQuickFactRow()] })}
            className="rounded-full border border-dashed border-border px-4 py-2 text-[12.5px] font-bold text-primary"
          >
            + Add a quick fact
          </button>
        </div>
      </Field>

      <MoreOptions
        label="More options — ad titles, house rules, move-in instructions, layout note"
        open={openMore}
        onToggle={() => setOpenMore((v) => !v)}
        dataAttr="listing-v2-marketing-more"
      >
        <Field
          label="Also listed as"
          optional
          hint="Your Facebook or Craigslist ad titles, so a prospect quoting the ad over text is matched to this home."
        >
          <Input
            value={sub.alsoListedAs ?? ""}
            onChange={(e) => patch({ alsoListedAs: e.target.value })}
            placeholder="Private locked room near University of Washington"
          />
        </Field>
        <Field label="About this home" optional hint="Notes the texting assistant can use. Renters can see this.">
          <Textarea
            rows={3}
            value={sub.marketingNotes ?? ""}
            onChange={(e) => patch({ marketingNotes: e.target.value })}
            placeholder="Nicknames, landmarks, what makes it special…"
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
        <Field label="Move-in instructions for the house" optional>
          <Textarea
            rows={3}
            value={sub.houseMoveInInstructions ?? ""}
            onChange={(e) => patch({ houseMoveInInstructions: e.target.value })}
            placeholder="Parking, entry, bins, wifi…"
          />
        </Field>
        <Field label="Extra layout note" optional>
          <Input
            value={sub.homeStructureNote}
            onChange={(e) => patch({ homeStructureNote: e.target.value })}
            placeholder="3-story townhouse · 3.5 baths"
          />
        </Field>
      </MoreOptions>
    </StepColumn>
  );
}

/* ─────────────────────────── step 6 · review ─────────────────────────── */

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
        step={7}
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
      case "money":
        return <StepMoney sub={submission} patch={patch} />;
      case "marketing":
        return <StepMarketing sub={submission} patch={patch} />;
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
              disabled={step === 0}
              onClick={() => setStep((s) => Math.max(0, s - 1))}
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
      {body}
    </WizardModal>
  );
}
