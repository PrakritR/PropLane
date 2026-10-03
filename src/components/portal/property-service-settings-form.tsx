"use client";

import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { ToggleRow } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingServiceOption,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmission,
  type ManagerPropertySaveTarget,
} from "@/lib/manager-property-save-target";

type Props = {
  sub: ManagerListingSubmissionV1;
  saveTarget: ManagerPropertySaveTarget;
  managerUserId: string;
  onUpdated: () => void;
  showToast: (m: string) => void;
  onSave?: () => void;
};

function offerId(offer: ManagerListingServiceOption): string {
  return offer.id;
}

/** Service settings gear — types offered, per-type price, audience, approval (C2-PS13). */
export function PropertyServiceSettingsForm({
  sub,
  saveTarget,
  managerUserId,
  onUpdated,
  showToast,
  onSave,
}: Props) {
  const draft = normalizeManagerListingSubmissionV1(sub);
  const offers = draft.serviceRequestOptions ?? [];
  const settings = draft.propertyServiceSettings ?? {};

  const persist = (next: ManagerListingSubmissionV1) => {
    const normalized = normalizeManagerListingSubmissionV1(next);
    if (!persistManagerListingSubmission(saveTarget, managerUserId, normalized)) {
      showToast("Could not save service settings.");
      return false;
    }
    onUpdated();
    return true;
  };

  const offeredIds = offers.filter((o) => o.available).map(offerId);
  const options = offers.map((o) => ({ value: o.id, label: o.name.trim() || "Service" }));

  const patchOffers = (ids: string[]) => {
    const nextOffers = offers.map((o) => ({ ...o, available: ids.includes(o.id) }));
    persist({ ...draft, serviceRequestOptions: nextOffers });
  };

  const patchOfferPrice = (id: string, price: string) => {
    const nextOffers = offers.map((o) => (o.id === id ? { ...o, price } : o));
    persist({ ...draft, serviceRequestOptions: nextOffers });
  };

  const patchSettings = (patch: Partial<NonNullable<ManagerListingSubmissionV1["propertyServiceSettings"]>>) => {
    persist({
      ...draft,
      propertyServiceSettings: { ...settings, ...patch },
    });
  };

  const saveAll = () => {
    if (persist(draft)) {
      showToast("Service settings saved.");
      onSave?.();
    }
  };

  return (
    <div className="space-y-5" data-ps40-svcset>
      <div>
        <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Offered</p>
        <div className="divide-y divide-border rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[14px] font-semibold text-foreground">Service types offered</span>
            <CheckboxMultiSelect
              label="Service types offered"
              options={options}
              selected={offeredIds}
              onChange={patchOffers}
              dataAttr="property-service-settings-offered"
            />
          </div>
          {offers
            .filter((o) => o.available)
            .map((o) => (
              <div
                key={o.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="text-[14px] font-semibold text-foreground">{o.name.trim() || "Service"} price</span>
                <MoneyInput
                  label={`${o.name} price`}
                  value={o.price ?? ""}
                  onChange={(v) => patchOfferPrice(o.id, v)}
                />
              </div>
            ))}
        </div>
      </div>
      <div>
        <p className="mb-2 text-[12px] font-bold uppercase tracking-wide text-muted">Requests</p>
        <div className="divide-y divide-border rounded-xl border border-border bg-card px-4 py-3">
          <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[14px] font-semibold text-foreground">Who can request</span>
            <FieldSingleSelect
              label="Who can request"
              options={[
                { value: "residents", label: "Residents" },
                { value: "residents_applicants", label: "Residents and approved applicants" },
              ]}
              value={settings.requestAudience ?? "residents"}
              onChange={(v) =>
                patchSettings({
                  requestAudience: v === "residents_applicants" ? "residents_applicants" : "residents",
                })
              }
              dataAttr="property-service-settings-who"
            />
          </div>
          <div className="py-3">
            <ToggleRow
              label="You approve each request"
              checked={settings.approveEachRequest !== false}
              onChange={(on) => patchSettings({ approveEachRequest: on })}
              dataAttr="property-service-settings-approve"
            />
          </div>
        </div>
      </div>
      <button
        type="button"
        className="min-h-[44px] rounded-full bg-primary px-6 text-[14px] font-bold text-white"
        data-attr="property-service-settings-save"
        onClick={saveAll}
      >
        Save
      </button>
    </div>
  );
}
