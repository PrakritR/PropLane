"use client";

/**
 * Phase 1 of creating a listing: three short screens that produce a real listing.
 *
 * The old wizard asked seventeen questions before a manager had anything at all.
 * This asks for the address, confirms it, and asks the ONE question that changes
 * every screen after it — whether the home is rented by the room or as a whole.
 * Everything else is optional and belongs to phase 2, which can be finished
 * later.
 *
 * Confirming the address on its own screen is deliberate: the address goes on the
 * lease and on the public listing, a typo is expensive to discover later, and it
 * is far cheaper to check once here than to validate it on submit.
 */

import { useMemo, useState } from "react";
import { ListingAddressAutocomplete } from "@/components/portal/listing-address-autocomplete";
import { Input, Select } from "@/components/ui/input";
import type { AddressSuggestion } from "@/lib/geocode-address";
import {
  LISTING_PROPERTY_TYPE_OPTIONS,
} from "@/data/manager-listing-presets";
import {
  ChoiceCard,
  Field,
  FieldRow,
  StepColumn,
  WizardModal,
} from "@/components/portal/listing-wizard-v2/wizard-primitives";

export type AddPropertyResult = {
  address: string;
  unitLabel: string;
  city: string;
  state: string;
  zip: string;
  neighborhood: string;
  propertyTypeId: string;
  rentByRoom: boolean;
  bedrooms: number;
};

type Screen = "address" | "confirm" | "how";

const MAX_BEDROOMS = 20;

export function AddPropertyFlow({
  onCancel,
  onCreate,
  creating = false,
}: {
  onCancel: () => void;
  onCreate: (result: AddPropertyResult) => void;
  creating?: boolean;
}) {
  const [screen, setScreen] = useState<Screen>("address");
  const [address, setAddress] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [picked, setPicked] = useState<AddressSuggestion | null>(null);
  const [propertyTypeId, setPropertyTypeId] = useState("");
  const [rentByRoom, setRentByRoom] = useState(true);
  const [bedrooms, setBedrooms] = useState(1);
  const [touched, setTouched] = useState(false);

  // Validate on blur / on advance, never only at the end.
  const addressError = touched && !address.trim() ? "Enter the street address." : "";
  const typeError = touched && !propertyTypeId ? "Choose a property type." : "";

  const bedroomOptions = useMemo(
    () => Array.from({ length: MAX_BEDROOMS }, (_, i) => i + 1),
    [],
  );

  function selectSuggestion(s: AddressSuggestion) {
    setPicked(s);
    setAddress(s.address || s.label);
  }

  if (screen === "address") {
    return (
      <WizardModal
        title="Add property"
        onClose={onCancel}
        footer={
          <>
            <button type="button" onClick={onCancel} className="text-[14px] font-bold text-muted">
              Cancel
            </button>
            <button
              type="button"
              data-attr="listing-v2-address-continue"
              onClick={() => {
                setTouched(true);
                if (address.trim()) setScreen("confirm");
              }}
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
            >
              Continue
            </button>
          </>
        }
      >
        <StepColumn>
          <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">
            First, let&apos;s add your property
          </h2>
          <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
            Once it is added you can list it, take applications and collect rent. The details can wait.
          </p>
          <Field
            label="Street address"
            required
            error={addressError}
            hint="Start typing and pick the match, so the city, state and ZIP fill in for you."
          >
            <ListingAddressAutocomplete
              value={address}
              onChange={(next) => {
                setAddress(next);
                setPicked(null);
              }}
              onSelect={selectSuggestion}
              aria-invalid={Boolean(addressError)}
            />
          </Field>
          <Field label="Unit number" optional hint="Only if the building has several units.">
            <Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder="#" />
          </Field>
        </StepColumn>
      </WizardModal>
    );
  }

  if (screen === "confirm") {
    const city = picked?.city ?? "";
    const state = picked?.state ?? "";
    const zip = picked?.zip ?? "";
    const neighborhood = picked?.neighborhood ?? "";
    return (
      <WizardModal
        title="Add property"
        onClose={onCancel}
        footer={
          <>
            <button
              type="button"
              onClick={() => setScreen("address")}
              className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
            >
              Back
            </button>
            <button
              type="button"
              data-attr="listing-v2-address-confirm"
              onClick={() => setScreen("how")}
              className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white"
            >
              Yes, that&apos;s it
            </button>
          </>
        }
      >
        <StepColumn wide>
          <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">Is this right?</h2>
          <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
            This address goes on the lease and on the public listing.
          </p>
          <div className="rounded-xl border border-border bg-card p-4">
            <p className="text-[12.5px] font-bold text-foreground">Street address</p>
            <p className="mt-0.5 text-[14px] text-muted">
              {address}
              {unitLabel.trim() ? ` · Unit ${unitLabel.trim()}` : ""}
            </p>
            {city || state || zip ? (
              <p className="mt-0.5 text-[14px] text-muted">
                {[city, state].filter(Boolean).join(", ")} {zip}
              </p>
            ) : (
              <p className="mt-2 text-[12.5px] font-semibold text-amber-700">
                We could not confirm this address automatically. Check the spelling, or continue and fill the city,
                state and ZIP in on the next step.
              </p>
            )}
            {neighborhood ? (
              <p className="mt-3 text-[12.5px] text-muted">
                <span className="font-bold text-foreground">Neighborhood</span> · {neighborhood}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => setScreen("address")}
              className="mt-4 rounded-full border border-border bg-card px-3.5 py-1.5 text-[12px] font-semibold text-muted"
            >
              Edit address
            </button>
          </div>
        </StepColumn>
      </WizardModal>
    );
  }

  return (
    <WizardModal
      title="Add property"
      onClose={onCancel}
      footer={
        <>
          <button
            type="button"
            onClick={() => setScreen("confirm")}
            className="min-h-[44px] rounded-full border border-border bg-card px-6 text-[14px] font-bold text-foreground"
          >
            Back
          </button>
          <button
            type="button"
            data-attr="listing-v2-create"
            disabled={creating}
            onClick={() => {
              setTouched(true);
              if (!propertyTypeId) return;
              onCreate({
                address: address.trim(),
                unitLabel: unitLabel.trim(),
                city: picked?.city ?? "",
                state: picked?.state ?? "",
                zip: picked?.zip ?? "",
                neighborhood: picked?.neighborhood ?? "",
                propertyTypeId,
                rentByRoom,
                bedrooms: rentByRoom ? bedrooms : 1,
              });
            }}
            className="min-h-[44px] rounded-full bg-primary px-7 text-[14px] font-bold text-white disabled:opacity-60"
          >
            {creating ? "Creating…" : "Create listing"}
          </button>
        </>
      }
    >
      <StepColumn>
        <h2 className="text-[23px] font-bold leading-tight tracking-tight text-foreground">How do you rent it?</h2>
        <p className="mb-5 mt-1.5 text-[13.5px] leading-relaxed text-muted">
          This decides whether rent is set per room or once for the whole place. You can change it later.
        </p>
        <ChoiceCard
          selected={rentByRoom}
          onSelect={() => setRentByRoom(true)}
          dataAttr="listing-v2-by-room"
          title="By the room"
          description="Each room has its own rent, deposit and resident. They share the kitchen and bathrooms."
        />
        <ChoiceCard
          selected={!rentByRoom}
          onSelect={() => setRentByRoom(false)}
          dataAttr="listing-v2-whole-place"
          title="The whole place"
          description="One rent, one lease, one household for the entire home."
        />
        <div className="mt-5">
          <FieldRow cols={2}>
            <Field label="Property type" required error={typeError}>
              <Select value={propertyTypeId} onChange={(e) => setPropertyTypeId(e.target.value)}>
                <option value="">Select…</option>
                {LISTING_PROPERTY_TYPE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            {rentByRoom ? (
              <Field
                label="Bedrooms you are renting out"
                required
                hint={`Creates ${bedrooms} room ${bedrooms === 1 ? "row" : "rows"} for you. Add or remove any time.`}
              >
                <Select value={String(bedrooms)} onChange={(e) => setBedrooms(Number(e.target.value) || 1)}>
                  {bedroomOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </FieldRow>
        </div>
      </StepColumn>
    </WizardModal>
  );
}
