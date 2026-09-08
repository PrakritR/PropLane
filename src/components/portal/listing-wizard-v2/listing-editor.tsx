"use client";

/**
 * Phase 2 of the redesigned wizard: six short, named steps that complete a
 * listing which already exists.
 *
 * PRP-430 merge (cursor-1 + Claude-2):
 * - Top chrome keeps the Image-2 stepper: Basics → Rooms → Spaces → Rent & fees
 *   → Photos → Review, with "Step N of 6 · …" under the title.
 * - Basics borrows Claude-2 Home features (how you rent, address autocomplete,
 *   bedroom slots) with an Advanced disclosure for secondary details.
 * - Rooms keep Mock B (list + Edit drawer + defaults).
 *
 * The submission shape is unchanged.
 */

import { useMemo, useState } from "react";
import { Input, Select, Textarea } from "@/components/ui/input";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import {
  HOUSE_WIDE_AMENITY_PRESETS,
  LISTING_PROPERTY_TYPE_OPTIONS,
  LISTING_STORIES_OPTIONS,
  LISTING_TOTAL_BATH_OPTIONS,
  ROOM_AMENITY_PRESETS,
  listingAmenityLinesFromValue,
} from "@/data/manager-listing-presets";
import {
  PAYMENT_AT_SIGNING_OPTIONS,
  applyListingBedroomSlots,
  formatLeaseTermsBodyFromAllowed,
  resolveAllowedLeaseTerms,
  syncAirbnbLeaseTermInAllowed,
  syncShortTermLeaseTermInAllowed,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
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
  StepColumn,
  StepHeading,
  WizardModal,
  WizardStepper,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ListingPhotoStrip } from "@/components/portal/listing-wizard-v2/listing-photo-strip";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { cn } from "@/lib/utils";

export const LISTING_V2_STEPS = [
  { id: "basics", label: "Basics" },
  { id: "rooms", label: "Rooms" },
  { id: "spaces", label: "Spaces" },
  { id: "money", label: "Rent & fees" },
  { id: "marketing", label: "Photos" },
  { id: "review", label: "Review" },
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

/* ─────────────────────────── step 1 · basics (Claude-2 Home + Advanced) ─────────────────────────── */

function StepBasics({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const rentByRoom = sub.listingPlaceCategoryId !== "entire_home";
  const roomCount = sub.rooms?.length || sub.listingBedroomSlots || 1;
  const [openAdvanced, setOpenAdvanced] = useState(false);

  return (
    <StepColumn>
      <StepHeading
        step={1}
        total={6}
        name="Basics"
        title="The home itself"
        subtitle="Where it is, what it is, and how it is laid out."
      />

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

      <Field group label="Pets" hint="Shown on the public listing.">
        <ChipRow>
          <ChipToggle
            label="No pets"
            on={!sub.petFriendly}
            onToggle={() => patch({ petFriendly: false })}
            dataAttr="listing-v2-pets-no"
          />
          <ChipToggle
            label="Pets OK (approval)"
            on={Boolean(sub.petFriendly)}
            onToggle={() => patch({ petFriendly: true })}
            dataAttr="listing-v2-pets-yes"
          />
        </ChipRow>
      </Field>

      <MoreOptions
        label="Advanced — listing name, neighborhood, layout note"
        open={openAdvanced}
        onToggle={() => setOpenAdvanced((v) => !v)}
        dataAttr="listing-v2-basics-advanced"
      >
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
        <Field label="Layout note" optional hint="Anything the floor and bathroom counts do not capture.">
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

/* ─────────────────────────── step 2 · rooms (Mock B) ─────────────────────────── */

function roomBathroomLabel(sub: ManagerListingSubmissionV1, roomId: string): string {
  for (const bath of sub.bathrooms ?? []) {
    if (bath.allResidents) return "Shared";
    if ((bath.assignedRoomIds ?? []).includes(roomId)) {
      const kind = bath.accessKindByRoomId?.[roomId];
      if (kind === "ensuite") return "Ensuite";
      if (kind === "shared") return "Shared";
      if (kind === "hall") return "Hall";
      return (bath.name || "Assigned").trim() || "Assigned";
    }
  }
  return "—";
}

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
  const photoCount = (room.photoDataUrls ?? []).length;

  return (
    <StepColumn>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-[12.5px] font-bold text-primary"
        data-attr="listing-v2-room-back"
      >
        ← Back to rooms
      </button>
      <p className="mb-2 text-[12px] font-bold text-muted">Edit room</p>
      <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
        {room.name.trim() || "Untitled room"}
      </h2>
      <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
        Photos, rent, and beds live here. Rare rates stay under Advanced.
      </p>

      <ListingPhotoStrip
        label="Room photos"
        urls={room.photoDataUrls ?? []}
        onChange={(photoDataUrls) => set({ photoDataUrls })}
        dataAttr="listing-v2-room-photos"
      />

      <Field label="Room name" required>
        <Input
          value={room.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Room 6"
        />
      </Field>
      <FieldRow cols={2}>
        <Field label="Floor" optional>
          <Input
            value={room.floor}
            onChange={(e) => set({ floor: e.target.value })}
            placeholder="1st floor"
          />
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
      <Field
        label="Rent / month"
        hint={
          inheritsRent && defaults.monthlyRent > 0
            ? `Following the house default of $${defaults.monthlyRent}. Edit to stop following.`
            : undefined
        }
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
      <Field label="Furnishing" optional>
        <Select
          value={room.furnishing || ""}
          onChange={(e) => set({ furnishing: e.target.value })}
        >
          <option value="">Select…</option>
          <option value="Furnished">Furnished</option>
          <option value="Unfurnished">Unfurnished</option>
        </Select>
      </Field>

      <MoreOptions
        label="Advanced — other rates, short stays, part-month rent, amenities, inspections"
        open={openMore}
        onToggle={() => setOpenMore((v) => !v)}
        dataAttr="listing-v2-room-more"
      >
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
          <Field label="Rent / week" optional>
            <Input
              value={room.weeklyRentPrice ? String(room.weeklyRentPrice) : ""}
              inputMode="numeric"
              onChange={(e) => set({ weeklyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
            />
          </Field>
          <Field label="Rent / day" optional hint="The room's own daily rate.">
            <Input
              value={room.dailyRentPrice ? String(room.dailyRentPrice) : ""}
              inputMode="numeric"
              onChange={(e) => set({ dailyRentPrice: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
            />
          </Field>
        </FieldRow>

        <p className="mb-3 mt-5 text-[12.5px] font-bold text-foreground">This room&apos;s own charges</p>
        <FieldRow cols={3}>
          <Field label="Security deposit" optional>
            <Input
              value={money(room.securityDeposit)}
              placeholder={defaults.securityDeposit || "500"}
              onChange={(e) => set({ securityDeposit: e.target.value })}
            />
          </Field>
          <Field label="Move-in fee" optional>
            <Input
              value={money(room.moveInFee)}
              placeholder={defaults.moveInFee || "0"}
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

        <p className="mb-1 mt-5 text-[12.5px] font-bold text-foreground">Part-month rent</p>
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
          <Field label="Part-month rent / day" optional>
            <Input
              value={room.dailyRentRate ? String(room.dailyRentRate) : ""}
              inputMode="numeric"
              onChange={(e) => set({ dailyRentRate: Number(e.target.value.replace(/[^0-9.]/g, "")) || undefined })}
            />
          </Field>
          <Field label="Part-month utilities / day" optional>
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

        <div className="mt-5">
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

      <p className="mt-4 text-[12px] text-muted">
        {photoCount === 0 ? "No photos yet — listings with a photo per room get more enquiries." : null}
      </p>

      <button
        type="button"
        onClick={onBack}
        className="mt-5 min-h-[44px] rounded-[10px] border border-border bg-card px-6 text-[14px] font-bold text-foreground"
      >
        Done
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
  const [copySourceId, setCopySourceId] = useState<string | null>(null);
  const rooms = sub.rooms ?? [];
  const openRoom = rooms.find((r) => r.id === openRoomId) ?? null;

  function writeRooms(next: ManagerRoomSubmission[]) {
    patch({ rooms: next });
  }

  function editDefault(field: keyof ListingHouseDefaults, value: ListingHouseDefaults[keyof ListingHouseDefaults]) {
    const previous = defaults;
    const next = { ...defaults, [field]: value } as ListingHouseDefaults;
    setDefaults(next);
    writeRooms(applyHouseDefaultsToRooms(rooms, next, { onlyFields: [field], previousDefaults: previous }));
  }

  function copyDefaultsToAll() {
    writeRooms(
      applyHouseDefaultsToRooms(rooms, defaults, {
        onlyFields: ["monthlyRent", "securityDeposit", "furnishing", "occupancyCapacity", "moveInFee", "utilitiesEstimate"],
      }),
    );
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

  return (
    <StepColumn wide>
      <StepHeading
        step={2}
        total={6}
        name="Rooms"
        title={`Your ${rooms.length} ${rooms.length === 1 ? "room" : "rooms"}`}
        subtitle="Set what is true for most rooms once. Change only the rooms that differ."
      />

      <div className="mb-4 rounded-xl border border-primary/25 bg-primary/[0.04] p-4" data-attr="listing-v2-room-defaults">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <b className="text-[13px] font-bold text-foreground">Defaults for new / following rooms</b>
            <p className="mt-0.5 text-[11.5px] text-muted">
              Changing a default updates rooms still following it. Custom rooms keep a badge.
            </p>
          </div>
          <button
            type="button"
            onClick={copyDefaultsToAll}
            className="min-h-[36px] rounded-[10px] bg-primary px-3 text-[12.5px] font-bold text-white"
            data-attr="listing-v2-copy-defaults-all"
          >
            Copy to all
          </button>
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
      </div>

      <ul className="mb-3 space-y-2" data-attr="listing-v2-room-list">
        {rooms.map((room, i) => {
          const rentInherited = roomInheritsDefault(room, defaults, "monthlyRent");
          const bedsInherited = roomInheritsDefault(room, defaults, "occupancyCapacity");
          const overrides = roomOverriddenDefaults(room, defaults);
          const photos = (room.photoDataUrls ?? []).length;
          const rentLabel =
            room.monthlyRent > 0
              ? `$${room.monthlyRent.toLocaleString("en-US")}`
              : defaults.monthlyRent > 0
                ? `$${defaults.monthlyRent.toLocaleString("en-US")}`
                : "Rent not set";
          const isSelected = selected.has(room.id);
          const followBits = [
            rentInherited ? "rent" : null,
            bedsInherited ? "beds" : null,
          ].filter(Boolean);

          return (
            <li
              key={room.id}
              className={cn(
                "flex items-center gap-3 rounded-xl border border-border bg-card p-3",
                isSelected && "border-l-4 border-l-primary bg-primary/[0.04]",
              )}
            >
              <RowSelectCheckbox
                checked={isSelected}
                aria-label={`Select ${room.name || `room ${i + 1}`}`}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(room.id);
                    else next.delete(room.id);
                    return next;
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[14px] font-extrabold text-foreground">
                    {room.name.trim() || `Room ${i + 1}`}
                  </b>
                  {followBits.length > 0 ? (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-muted">
                      follows {followBits.join(" · ")}
                    </span>
                  ) : null}
                  {overrides.includes("monthlyRent") ? (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                      custom rent
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  {[
                    room.floor.trim() || null,
                    roomBathroomLabel(sub, room.id),
                    rentLabel,
                    `${room.occupancyCapacity ?? defaults.occupancyCapacity} bed${(room.occupancyCapacity ?? defaults.occupancyCapacity) === 1 ? "" : "s"}`,
                    `${photos} photo${photos === 1 ? "" : "s"}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpenRoomId(room.id)}
                className="shrink-0 rounded-[10px] border border-primary px-3 py-1.5 text-[12.5px] font-bold text-primary"
                data-attr="listing-v2-edit-room"
              >
                Edit room
              </button>
            </li>
          );
        })}
      </ul>

      {selected.size > 0 ? (
        <div className="mb-3" data-attr="listing-v2-room-bulk">
          <RowBulkBar count={selected.size}>
            <BulkButton
              onClick={() => {
                const source = rooms.find((r) => r.id === (copySourceId ?? [...selected][0]));
                if (!source) return;
                writeRooms(
                  rooms.map((r) =>
                    selected.has(r.id) && r.id !== source.id
                      ? {
                          ...r,
                          monthlyRent: source.monthlyRent,
                          occupancyCapacity: source.occupancyCapacity,
                          floor: source.floor,
                          furnishing: source.furnishing,
                          securityDeposit: source.securityDeposit,
                          moveInFee: source.moveInFee,
                          utilitiesEstimate: source.utilitiesEstimate,
                        }
                      : r,
                  ),
                );
              }}
            >
              Copy to another room
            </BulkButton>
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
              Set rent to ${defaults.monthlyRent || 0}
            </BulkButton>
            <BulkButton
              onClick={() => {
                const copies = rooms
                  .filter((r) => selected.has(r.id))
                  .map((r, i) => ({
                    ...r,
                    id: `${r.id}-copy-${i}-${Date.now()}`,
                    name: `${r.name || "Room"} (copy)`,
                    photoDataUrls: [],
                    videoDataUrl: null,
                  }));
                writeRooms([...rooms, ...copies]);
                setSelected(new Set());
              }}
            >
              Duplicate
            </BulkButton>
            <BulkButton
              onClick={() => {
                if (rooms.length <= selected.size) return;
                writeRooms(rooms.filter((r) => !selected.has(r.id)));
                setSelected(new Set());
              }}
            >
              Remove
            </BulkButton>
          </RowBulkBar>
          {selected.size === 1 ? (
            <label className="mt-2 flex items-center gap-1.5 text-[11.5px] font-semibold text-muted">
              Copy from
              <select
                className="rounded border border-border bg-card px-1.5 py-1 text-[12px] font-bold text-foreground"
                value={copySourceId ?? [...selected][0] ?? ""}
                onChange={(e) => setCopySourceId(e.target.value)}
              >
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name.trim() || r.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      <AddRowButton
        label="+ ADD ROOM"
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
        Open <b>Edit room</b> for photos and full pricing. Defaults update following rooms; use{" "}
        <b>Copy to all</b> when you want to overwrite every room.
      </p>
    </StepColumn>
  );
}

/* ─────────────────────────── step 3 · spaces ─────────────────────────── */

function StepSpaces({ sub, patch }: { sub: ManagerListingSubmissionV1; patch: Patch }) {
  const [selectedBath, setSelectedBath] = useState<Set<string>>(new Set());
  const baths = sub.bathrooms ?? [];
  const spaces = sub.sharedSpaces ?? [];
  const bathCols = [
    { key: "name", label: "Bathroom" },
    { key: "floor", label: "Floor" },
  ];
  const spaceCols = [
    { key: "name", label: "Shared space" },
    { key: "floor", label: "Floor" },
  ];
  return (
    <StepColumn wide>
      <StepHeading
        step={3}
        total={6}
        name="Spaces"
        title="Bathrooms and shared rooms"
        subtitle="A row each. Everything outside the bedrooms."
      />
      <RowList columns={bathCols}>
        {baths.map((bath, i) => (
          <Row
            key={bath.id}
            columnCount={bathCols.length}
            selected={selectedBath.has(bath.id)}
            onSelectChange={(on) =>
              setSelectedBath((prev) => {
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
            <RowCell
              ariaLabel={`Floor for bathroom ${i + 1}`}
              value={bath.location ?? ""}
              placeholder="Main"
              onChange={(v) => patch({ bathrooms: baths.map((b) => (b.id === bath.id ? { ...b, location: v } : b)) })}
            />
          </Row>
        ))}
      </RowList>
      <AddRowButton
        label="+ Add a bathroom"
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

      <div className="mt-7">
        <RowList columns={spaceCols}>
          {spaces.map((space, i) => (
            <Row
              key={space.id}
              columnCount={spaceCols.length}
              selected={false}
              onSelectChange={() => {}}
              removeLabel={`Remove ${space.name || `shared space ${i + 1}`}`}
              onRemove={() => patch({ sharedSpaces: spaces.filter((s) => s.id !== space.id) })}
            >
              <RowCell
                ariaLabel={`Name for shared space ${i + 1}`}
                value={space.name}
                placeholder="Kitchen"
                onChange={(v) =>
                  patch({ sharedSpaces: spaces.map((s) => (s.id === space.id ? { ...s, name: v } : s)) })
                }
              />
              <RowCell
                ariaLabel={`Floor for shared space ${i + 1}`}
                value={space.location ?? ""}
                placeholder="Main"
                onChange={(v) =>
                  patch({ sharedSpaces: spaces.map((s) => (s.id === space.id ? { ...s, location: v } : s)) })
                }
              />
            </Row>
          ))}
        </RowList>
        <AddRowButton
          label="+ Add a shared space"
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
      </div>
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
        total={6}
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
      <Field label="Holding deposit" optional hint="Refundable; credited toward the security deposit on approval.">
        <Input value={money(sub.holdingDeposit)} onChange={(e) => patch({ holdingDeposit: e.target.value })} />
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

      <MoreOptions
        label="Advanced fees — waiver code, late fees, parking, HOA, surcharges, who pays the card fee"
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
        <FieldRow cols={2}>
          <Field label="Parking / month" optional>
            <Input value={money(sub.parkingMonthly)} onChange={(e) => patch({ parkingMonthly: e.target.value })} />
          </Field>
          <Field label="HOA / month" optional>
            <Input value={money(sub.hoaMonthly)} onChange={(e) => patch({ hoaMonthly: e.target.value })} />
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
        step={5}
        total={6}
        name="Photos & description"
        title="How it looks and reads"
        subtitle="Listings with a photo of every room get far more enquiries. Add house photos here; room photos live in each room’s Edit drawer."
      />
      <ListingPhotoStrip
        label="House photos"
        urls={sub.housePhotoDataUrls ?? []}
        onChange={(housePhotoDataUrls) => patch({ housePhotoDataUrls })}
        dataAttr="listing-v2-house-photos"
        addLabel="+ House photo"
      />
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

      <MoreOptions
        label="Copy & move-in extras — ad titles, house rules, move-in instructions, layout note"
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
        step={6}
        total={6}
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

  const body = useMemo(() => {
    switch (stepId) {
      case "basics":
        return <StepBasics sub={submission} patch={patch} />;
      case "rooms":
        return <StepRooms sub={submission} patch={patch} defaults={defaults} setDefaults={setDefaults} />;
      case "spaces":
        return <StepSpaces sub={submission} patch={patch} />;
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
      onSaveExit={() => onSaveExit(step)}
      stepper={<WizardStepper steps={LISTING_V2_STEPS} current={step} onJump={setStep} />}
      footer={
        <>
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="min-h-[44px] rounded-[10px] border border-border bg-card px-6 text-[14px] font-bold text-foreground disabled:opacity-45"
          >
            Back
          </button>
          {step === last ? (
            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={() => onSaveExit(step)}
                disabled={busy}
                className="min-h-[44px] rounded-[10px] border border-border bg-card px-5 text-[14px] font-bold text-foreground disabled:opacity-60"
              >
                Keep as draft
              </button>
              <button
                type="button"
                onClick={onPublish}
                disabled={busy}
                data-attr="listing-v2-publish"
                className="min-h-[44px] rounded-[10px] bg-primary px-6 text-[14px] font-bold text-white disabled:opacity-60"
              >
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(last, s + 1))}
              data-attr="listing-v2-next"
              className="min-h-[44px] rounded-[10px] bg-primary px-6 text-[14px] font-bold text-white"
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
