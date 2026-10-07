"use client";

/**
 * Vendor Finances → Tax info (vendor-banking-1006, part A): the vendor's one
 * W-9 (legal name, tax ID, entity type, address, certification), a tax-year
 * summary (earnings, fees, refunds) and the 1099 line for each year. The tax ID
 * is encrypted server-side and only its last four digits ever come back.
 */
import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatMoney } from "@/components/portal/portal-payouts-panel";
import {
  form1099StatusLabel,
  maskTin,
  VENDOR_W9_ENTITY_TYPES,
  vendorW9EntityLabel,
  type VendorTaxYearSummary,
  type VendorW9Profile,
} from "@/lib/vendor-banking/tax";

type TaxPayload = { profile: VendorW9Profile | null; years: VendorTaxYearSummary[]; currentYear: number };

type Draft = {
  legalName: string;
  businessName: string;
  entityType: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  tinType: "ssn" | "ein";
  tin: string;
  attested: boolean;
};

function draftFrom(profile: VendorW9Profile | null): Draft {
  return {
    legalName: profile?.legalName ?? "",
    businessName: profile?.businessName ?? "",
    entityType: profile?.entityType ?? "individual",
    addressLine1: profile?.addressLine1 ?? "",
    addressLine2: profile?.addressLine2 ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    zip: profile?.zip ?? "",
    tinType: profile?.tinType ?? "ein",
    tin: "",
    attested: false,
  };
}

export function VendorTaxPanel({ basePath }: { basePath: string }) {
  const { showToast } = useAppUi();
  const [data, setData] = useState<TaxPayload | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch("/api/vendor/finances/tax", { credentials: "include" });
      if (!res.ok) throw new Error("tax unavailable");
      const body = (await res.json()) as Partial<TaxPayload>;
      if (!Array.isArray(body.years)) throw new Error("malformed");
      setData({ profile: body.profile ?? null, years: body.years, currentYear: body.currentYear ?? new Date().getUTCFullYear() });
      setState("ready");
    } catch {
      setData(null);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const profile = data?.profile ?? null;
  const hasW9 = Boolean(profile?.tinLast4 && profile.attested);

  return (
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav compactFilterRow>
      {state === "loading" ? (
        <PortalRecordListSurface loading dataAttr="vendor-tax-loading" />
      ) : state === "error" || !data ? (
        <PortalRecordListSurface loadError="Could not load your tax info." onRetry={() => void load()} dataAttr="vendor-tax-error" />
      ) : (
        <>
          <PortalSettingsSection
            title="W-9"
            action={<PortalIconAction icon={Pencil} label={hasW9 ? "Edit W-9" : "Add W-9"} data-attr="vendor-tax-edit" onClick={() => setEditing(true)} />}
          >
            <PortalSettingsGroup>
              {profile ? (
                <>
                  <PortalSettingsRow label="Legal name"><span data-attr="vendor-tax-legal-name">{profile.legalName ?? "—"}</span></PortalSettingsRow>
                  <PortalSettingsRow label="Tax ID"><span data-attr="vendor-tax-tin">{maskTin(profile.tinType, profile.tinLast4)}</span></PortalSettingsRow>
                  <PortalSettingsRow label="Entity type">{vendorW9EntityLabel(profile.entityType)}</PortalSettingsRow>
                  <PortalSettingsRow label="Address">{[profile.city, profile.state].filter(Boolean).join(", ") || "—"}</PortalSettingsRow>
                </>
              ) : (
                <PortalSettingsRow label="W-9">Not submitted</PortalSettingsRow>
              )}
            </PortalSettingsGroup>
          </PortalSettingsSection>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            destinations={[
              {
                id: "years",
                label: "Tax years",
                count: data.years.length,
                href: `${basePath}/financials/tax`,
                dataAttr: "vendor-tax-years-tab",
              },
            ]}
            activeDestinationId="years"
            destinationAriaLabel="Tax years"
          />
          <PortalRecordListSurface
            isEmpty={data.years.length === 0}
            emptyCard={{ title: "No tax years yet", section: "financials", tone: "muted" }}
            dataAttr="vendor-tax-years"
          >
            {data.years.map((year) => (
              <PortalPropertyRecordRow
                key={year.year}
                title={String(year.year)}
                leading={
                  <span className="grid size-14 place-items-center rounded-xl bg-accent text-sm font-semibold text-primary" aria-hidden>
                    {year.year}
                  </span>
                }
                leadingShape="square"
                facts={
                  <>
                    <span>Earnings {formatMoney(year.earningsCents, "usd")}</span>
                    <span>Fees {formatMoney(year.feesCents, "usd")}</span>
                    <span>Refunds {formatMoney(year.refundsCents, "usd")}</span>
                    <span data-attr="vendor-tax-1099-status">{form1099StatusLabel(year, { hasW9, currentYear: data.currentYear })}</span>
                  </>
                }
                dataAttr="vendor-tax-year-row"
              />
            ))}
          </PortalRecordListSurface>
        </>
      )}
      {editing ? (
        <W9Dialog
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            showToast("W-9 saved.");
            void load();
          }}
        />
      ) : null}
    </ManagerPortalPageShell>
  );
}

function W9Dialog({ profile, onClose, onSaved }: { profile: VendorW9Profile | null; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/vendor/finances/tax", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not save your W-9.");
        return;
      }
      onSaved();
    } catch {
      setError("Could not save your W-9.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PortalDialog
      open
      onClose={onClose}
      title="W-9"
      size="wizard"
      dataAttr="vendor-tax-dialog"
      primaryAction={{ label: "Submit W-9", onClick: save, loading: saving, disabled: saving || !draft.attested, dataAttr: "vendor-tax-submit" }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Legal name
          <Input value={draft.legalName} onChange={(e) => set({ legalName: e.target.value })} autoComplete="name" data-attr="vendor-tax-legal-name-input" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Business name (optional)
          <Input value={draft.businessName} onChange={(e) => set({ businessName: e.target.value })} />
        </label>
        <FieldSingleSelect
          label="Entity type"
          value={draft.entityType}
          onChange={(entityType) => set({ entityType })}
          options={VENDOR_W9_ENTITY_TYPES.map((entry) => ({ value: entry.value, label: entry.label }))}
        />
        <FieldSingleSelect
          label="Tax ID type"
          value={draft.tinType}
          onChange={(tinType) => set({ tinType: tinType === "ssn" ? "ssn" : "ein" })}
          options={[{ value: "ein", label: "EIN" }, { value: "ssn", label: "SSN" }]}
        />
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          {draft.tinType === "ein" ? "EIN" : "SSN"}
          <Input
            value={draft.tin}
            onChange={(e) => set({ tin: e.target.value })}
            inputMode="numeric"
            autoComplete="off"
            placeholder={profile?.tinLast4 ? maskTin(profile.tinType, profile.tinLast4) : undefined}
            data-attr="vendor-tax-tin-input"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Address line 1
          <Input value={draft.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} autoComplete="address-line1" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
          Address line 2
          <Input value={draft.addressLine2} onChange={(e) => set({ addressLine2: e.target.value })} autoComplete="address-line2" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          City
          <Input value={draft.city} onChange={(e) => set({ city: e.target.value })} autoComplete="address-level2" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          State
          <Input value={draft.state} onChange={(e) => set({ state: e.target.value })} maxLength={2} autoComplete="address-level1" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          ZIP
          <Input value={draft.zip} onChange={(e) => set({ zip: e.target.value })} autoComplete="postal-code" />
        </label>
        <label className="flex items-start gap-2 text-sm text-foreground sm:col-span-2">
          <input type="checkbox" checked={draft.attested} onChange={(e) => set({ attested: e.target.checked })} data-attr="vendor-tax-attest" />
          Under penalties of perjury, I certify that the tax ID shown is correct and that I am a U.S. person.
        </label>
        {error ? (
          <p role="alert" className="text-sm text-danger sm:col-span-2" data-attr="vendor-tax-error-message">{error}</p>
        ) : null}
      </div>
    </PortalDialog>
  );
}
