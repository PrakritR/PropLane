"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
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

export function ServiceIntakeFormFields({
  catalogOffers,
  form,
  onChange,
  disabled = false,
  photoSlot,
}: {
  catalogOffers: readonly ManagerListingServiceOption[];
  form: ServiceIntakeFormState;
  onChange: (patch: Partial<ServiceIntakeFormState>) => void;
  disabled?: boolean;
  photoSlot?: ReactNode;
}) {
  const options = buildServiceIntakeOptions(mergeResidentServiceCatalogOffers(catalogOffers));
  const selected = findServiceIntakeOption(options, form.optionKey);
  const isRepair = selected?.kind === "repair";
  const isCustomAddOn = serviceIntakeIsCustomAddOn(selected);
  const selectedCatalogOffer =
    selected?.offerId && !isCustomAddOn
      ? catalogOffers.find((offer) => offer.id === selected.offerId) ?? null
      : null;

  const grouped = {
    property: options.filter((option) => option.group === "property"),
    repair: options.filter((option) => option.group === "repair"),
    other: options.filter((option) => option.group === "other"),
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-[11px] font-medium text-muted">
          Service type <span className="text-rose-500">*</span>
        </p>
        <Select
          value={form.optionKey}
          onChange={(e) => {
            const next = findServiceIntakeOption(options, e.target.value);
            onChange({
              optionKey: e.target.value,
              categoryLabel:
                next?.categoryLabel ??
                (next?.kind === "repair" ? "General" : form.categoryLabel),
              title: next?.kind === "repair" ? "" : form.title,
            });
          }}
          className="bg-card"
          disabled={disabled}
          data-attr="service-intake-type"
        >
          {grouped.property.length > 0 ? (
            <optgroup label="Property services">
              {grouped.property.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {grouped.repair.length > 0 ? (
            <optgroup label="Maintenance">
              {grouped.repair.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {grouped.other.length > 0 ? (
            <optgroup label="Other">
              {grouped.other.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
      </div>

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
              ? "What's happening? Include timing or access details…"
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
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Entry notes (gate code, pets, parking…)</p>
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
