"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PreferredArrivalField } from "@/components/portal/preferred-arrival-field";
import { ENTRY_PERMISSION_OPTIONS } from "@/lib/work-order-entry";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerListingServiceOption } from "@/lib/manager-listing-submission";
import { mergeResidentServiceCatalogOffers } from "@/lib/manager-listing-submission";
import { hasDeposit } from "@/lib/service-requests-storage";
import {
  buildServiceIntakeOptions,
  findServiceIntakeOption,
  RESIDENT_SERVICE_REPAIR_CATEGORIES,
  SERVICE_INTAKE_PRIORITY_OPTIONS,
  serviceIntakeIsCustomAddOn,
  type ServiceIntakeOption,
} from "@/lib/service-intake";
import type { ResidentMaintenanceCategoryLabel } from "@/lib/work-order-taxonomy";

export type ServiceIntakeFormState = {
  optionKey: string;
  title: string;
  description: string;
  categoryLabel: ResidentMaintenanceCategoryLabel;
  priority: string;
  customPriceLimit: string;
  arrivalPreset: string;
  arrivalCustom: string;
  entryPermission: DemoManagerWorkOrderRow["entryPermission"];
  entryNotes: string;
};

export function createEmptyServiceIntakeFormState(
  options: readonly ServiceIntakeOption[],
): ServiceIntakeFormState {
  const first = options[0];
  return {
    optionKey: first?.key ?? "repair:General",
    title: "",
    description: "",
    categoryLabel: first?.categoryLabel ?? "General",
    priority: "Medium",
    customPriceLimit: "",
    arrivalPreset: "Anytime",
    arrivalCustom: "",
    entryPermission: "call_first",
    entryNotes: "",
  };
}

/**
 * Who is filling the form in. The resident form asks in the resident's own
 * words ("Can maintenance enter if you're not home?"); the manager logging a
 * service on a resident's behalf is not the resident, so the manager voice
 * drops those two fields and keeps the access notes.
 */
export type ServiceIntakeVoice = "resident" | "manager";

export function ServiceIntakeFormFields({
  catalogOffers,
  form,
  onChange,
  disabled = false,
  photoSlot,
  voice = "resident",
}: {
  catalogOffers: readonly ManagerListingServiceOption[];
  form: ServiceIntakeFormState;
  onChange: (patch: Partial<ServiceIntakeFormState>) => void;
  disabled?: boolean;
  photoSlot?: ReactNode;
  voice?: ServiceIntakeVoice;
}) {
  const options = buildServiceIntakeOptions(mergeResidentServiceCatalogOffers(catalogOffers));
  const selected = findServiceIntakeOption(options, form.optionKey);
  const isRepair = selected?.kind === "repair";
  const isCustomAddOn = serviceIntakeIsCustomAddOn(selected);
  const managerVoice = voice === "manager";
  const selectedCatalogOffer =
    selected?.offerId && !isCustomAddOn
      ? catalogOffers.find((offer) => offer.id === selected.offerId) ?? null
      : null;

  // One flat list, in a fixed order: property services, then Maintenance,
  // then the custom add-on. `buildServiceIntakeOptions` already emits them in
  // that order; group headers inside the menu are deliberately not drawn.
  const typeOptions = options.map((option) => ({ value: option.key, label: option.label }));

  return (
    <div className="space-y-3">
      <FieldSingleSelect
        label="Service type"
        labelClassName="mb-1 block text-[11px] font-medium text-muted"
        value={form.optionKey}
        options={typeOptions}
        placeholder="Choose a service type"
        onChange={(value) => {
          const next = findServiceIntakeOption(options, value);
          onChange({
            optionKey: value,
            categoryLabel:
              next?.categoryLabel ??
              (next?.kind === "repair" ? "General" : form.categoryLabel),
            title: next?.kind === "repair" ? "" : form.title,
          });
        }}
        disabled={disabled}
        dataAttr="service-intake-type"
      />

      {selectedCatalogOffer ? (
        <div className="rounded-xl border border-border bg-accent/20 px-3 py-2.5 text-sm">
          <p className="font-semibold text-foreground">{selectedCatalogOffer.name}</p>
          {selectedCatalogOffer.description ? (
            <p className="mt-1 text-xs text-muted">{selectedCatalogOffer.description}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted">
            {[
              selectedCatalogOffer.price ? `Price ${selectedCatalogOffer.price}` : null,
              hasDeposit(selectedCatalogOffer.deposit) ? `Deposit ${selectedCatalogOffer.deposit}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "Manager-set pricing"}
          </p>
        </div>
      ) : null}

      {isRepair ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Category</p>
            <Select
              value={form.categoryLabel}
              onChange={(e) =>
                onChange({ categoryLabel: e.target.value as ResidentMaintenanceCategoryLabel })
              }
              className="bg-card"
              disabled={disabled}
              data-attr="service-intake-category"
            >
              {RESIDENT_SERVICE_REPAIR_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Priority</p>
            <Select
              value={form.priority}
              onChange={(e) => onChange({ priority: e.target.value })}
              className="bg-card"
              disabled={disabled}
              data-attr="service-intake-priority"
            >
              {SERVICE_INTAKE_PRIORITY_OPTIONS.map((priority) => (
                <option key={priority} value={priority}>
                  {priority}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ) : isCustomAddOn ? (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted">Priority</p>
          <Select
            value={form.priority}
            onChange={(e) => onChange({ priority: e.target.value })}
            className="bg-card"
            disabled={disabled}
            data-attr="service-intake-priority"
          >
            {SERVICE_INTAKE_PRIORITY_OPTIONS.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </Select>
        </div>
      ) : null}

      {isRepair || isCustomAddOn ? (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted">
            Title <span className="text-rose-500">*</span>
          </p>
          <Input
            value={form.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={isRepair ? "Short summary (e.g. Kitchen faucet leaking)" : "e.g. Extra storage bin"}
            className="bg-card"
            disabled={disabled}
            data-attr="service-intake-title"
          />
        </div>
      ) : null}

      <div>
        <p className="mb-1 text-[11px] font-medium text-muted">
          {isRepair ? "Description" : "Notes"}
          {isRepair ? <span className="text-rose-500"> *</span> : null}
        </p>
        <Textarea
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder={
            isRepair
              ? managerVoice
                ? "What's happening?"
                : "What's happening? Include timing or access details…"
              : "Preferred timing, special instructions…"
          }
          rows={isRepair ? 4 : 3}
          className="bg-card"
          disabled={disabled}
          data-attr="service-intake-description"
        />
      </div>

      {isCustomAddOn ? (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted">
            Price limit <span className="text-rose-500">*</span>
          </p>
          <Input
            value={form.customPriceLimit}
            onChange={(e) => onChange({ customPriceLimit: e.target.value })}
            placeholder="$50"
            inputMode="decimal"
            className="bg-card"
            disabled={disabled}
            data-attr="service-intake-price-limit"
          />
        </div>
      ) : null}

      {isRepair ? (
        <>
          {managerVoice ? null : (
            <>
              <PreferredArrivalField
                preset={form.arrivalPreset}
                custom={form.arrivalCustom}
                onPresetChange={(value) => onChange({ arrivalPreset: value })}
                onCustomChange={(value) => onChange({ arrivalCustom: value })}
              />
              <div>
                <p className="mb-1 text-[11px] font-medium text-muted">Can maintenance enter if you&apos;re not home?</p>
                <Select
                  value={form.entryPermission ?? "call_first"}
                  onChange={(e) =>
                    onChange({
                      entryPermission: e.target.value as DemoManagerWorkOrderRow["entryPermission"],
                    })
                  }
                  className="bg-card"
                  disabled={disabled}
                >
                  {ENTRY_PERMISSION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
            </>
          )}
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">
              {managerVoice ? "Access notes (gate code, pets, parking…)" : "Entry notes (gate code, pets, parking…)"}
            </p>
            <Input
              value={form.entryNotes}
              onChange={(e) => onChange({ entryNotes: e.target.value })}
              placeholder="Optional"
              className="bg-card"
              disabled={disabled}
            />
          </div>
          {photoSlot}
        </>
      ) : null}
    </div>
  );
}

export function ServiceIntakePhotoPicker({
  onPick,
  disabled = false,
}: {
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted">Photos (up to 6)</p>
      <Button
        type="button"
        variant="outline"
        className="w-fit rounded-full text-xs"
        onClick={onPick}
        disabled={disabled}
        data-attr="service-intake-photos"
      >
        Attach photos
      </Button>
    </div>
  );
}
