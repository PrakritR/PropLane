"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, FileCheck2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

type OnboardingProfile = {
  businessName: string;
  serviceArea: string;
  trades: string[];
  serviceAreaZips: string[];
  serviceRadiusMiles: number | null;
  licenseNumber: string;
  licenseDocPath: string | null;
  insuranceProvider: string;
  insurancePolicyNumber: string;
  insuranceExpiresAt: string | null;
  insuranceDocPath: string | null;
  directoryListed: boolean;
  onboardingCompletedAt: string | null;
};

const EMPTY: OnboardingProfile = {
  businessName: "",
  serviceArea: "",
  trades: [],
  serviceAreaZips: [],
  serviceRadiusMiles: null,
  licenseNumber: "",
  licenseDocPath: null,
  insuranceProvider: "",
  insurancePolicyNumber: "",
  insuranceExpiresAt: null,
  insuranceDocPath: null,
  directoryListed: true,
  onboardingCompletedAt: null,
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

/** Short onboarding step a self-serve vendor lands on right after signup — Business, Trades & area, License & insurance, Directory. */
export function VendorOnboardingFlow() {
  const router = useRouter();
  const { showToast } = useAppUi();
  const [profile, setProfile] = useState<OnboardingProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [zipsDraft, setZipsDraft] = useState("");
  const [licenseFile, setLicenseFile] = useState<File | null>(null);
  const [insuranceFile, setInsuranceFile] = useState<File | null>(null);
  const licenseInputRef = useRef<HTMLInputElement | null>(null);
  const insuranceInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetch("/api/vendor/business-profile", { credentials: "include" })
      .then((r) => r.json())
      .then((data: { profile?: OnboardingProfile }) => {
        if (data.profile) {
          // The DB column (and the EMPTY shape a brand-new profile reads back
          // as) defaults directory_listed to FALSE for safety — a vendor must
          // never be listed without having seen the toggle. But that means a
          // real self-serve signup always starts here with `directoryListed:
          // false`, not null/undefined, so `?? true` never applies. Show the
          // toggle ON for as long as onboarding isn't complete (the vendor
          // hasn't made a real choice yet); once onboarding_completed_at is
          // set, respect whatever was actually saved.
          const directoryListed = data.profile.onboardingCompletedAt ? data.profile.directoryListed : true;
          setProfile({ ...EMPTY, ...data.profile, directoryListed });
          setZipsDraft((data.profile.serviceAreaZips ?? []).join(", "));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const requiredFilled = useMemo(() => {
    const hasArea = profile.serviceArea.trim().length > 0 || zipsDraft.trim().length > 0 || profile.serviceRadiusMiles != null;
    return profile.businessName.trim().length > 0 && profile.trades.length > 0 && hasArea;
  }, [profile, zipsDraft]);

  async function uploadDoc(kind: "license" | "insurance", file: File): Promise<void> {
    const dataUrl = await fileToDataUrl(file);
    const res = await fetch("/api/vendor/onboarding/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ kind, dataUrl, fileName: file.name }),
    });
    const data = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Could not upload ${kind}.`);
  }

  async function save(finish: boolean) {
    setSaving(true);
    try {
      if (licenseFile) await uploadDoc("license", licenseFile);
      if (insuranceFile) await uploadDoc("insurance", insuranceFile);

      const zips = zipsDraft
        .split(/[,\s]+/)
        .map((z) => z.trim())
        .filter(Boolean);

      const res = await fetch("/api/vendor/business-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          businessName: profile.businessName,
          serviceArea: profile.serviceArea,
          trades: profile.trades,
          serviceAreaZips: zips,
          serviceRadiusMiles: profile.serviceRadiusMiles,
          licenseNumber: profile.licenseNumber,
          insuranceProvider: profile.insuranceProvider,
          insurancePolicyNumber: profile.insurancePolicyNumber,
          insuranceExpiresAt: profile.insuranceExpiresAt ?? null,
          directoryListed: profile.directoryListed,
        }),
      });
      const data = (await res.json()) as { profile?: OnboardingProfile; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save onboarding.");
      setLicenseFile(null);
      setInsuranceFile(null);
      if (data.profile) setProfile((cur) => ({ ...cur, ...data.profile }));
      showToast(finish ? "You're set up." : "Saved.");
      if (finish) router.push("/vendor/dashboard");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save onboarding.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="px-4 py-8 text-sm text-muted">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-0" data-attr="vendor-onboarding-flow">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Set up your vendor profile</h1>
      </div>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-business">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Building2 className="size-4" aria-hidden />
          Business
        </div>
        <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
          <label className={`${PORTAL_MODAL_FORM_FIELD_CLASS} ${PORTAL_MODAL_FORM_FULL_ROW_CLASS}`}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Business name</span>
            <Input
              value={profile.businessName}
              onChange={(e) => setProfile((cur) => ({ ...cur, businessName: e.target.value }))}
              placeholder="Apex Plumbing LLC"
              data-attr="vendor-onboarding-business-name"
            />
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-trades">
        <p className="text-sm font-semibold text-foreground">Trades</p>
        <CheckboxMultiSelect
          label="Trades"
          hideLabel
          options={VENDOR_TRADE_OPTIONS.map((t) => ({ value: t, label: t }))}
          selected={profile.trades}
          onChange={(next) => setProfile((cur) => ({ ...cur, trades: next }))}
          dataAttr="vendor-onboarding-trades-select"
        />
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-area">
        <p className="text-sm font-semibold text-foreground">Service area</p>
        <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>City</span>
            <Input
              value={profile.serviceArea}
              onChange={(e) => setProfile((cur) => ({ ...cur, serviceArea: e.target.value }))}
              placeholder="Seattle, WA"
              data-attr="vendor-onboarding-city"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>ZIP codes</span>
            <Input
              value={zipsDraft}
              onChange={(e) => setZipsDraft(e.target.value)}
              placeholder="98101, 98104, 98109"
              data-attr="vendor-onboarding-zips"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Radius (miles)</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="size-9 rounded-full p-0 text-base"
                onClick={() => setProfile((cur) => ({ ...cur, serviceRadiusMiles: Math.max(1, (cur.serviceRadiusMiles ?? 0) - 5) }))}
                data-attr="vendor-onboarding-radius-minus"
                aria-label="Decrease radius"
              >
                −
              </Button>
              <Input
                type="number"
                min={1}
                max={500}
                className="text-center"
                value={profile.serviceRadiusMiles ?? ""}
                onChange={(e) =>
                  setProfile((cur) => ({ ...cur, serviceRadiusMiles: e.target.value ? Number(e.target.value) : null }))
                }
                data-attr="vendor-onboarding-radius"
              />
              <Button
                type="button"
                variant="outline"
                className="size-9 rounded-full p-0 text-base"
                onClick={() => setProfile((cur) => ({ ...cur, serviceRadiusMiles: Math.min(500, (cur.serviceRadiusMiles ?? 0) + 5) }))}
                data-attr="vendor-onboarding-radius-plus"
                aria-label="Increase radius"
              >
                +
              </Button>
            </div>
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-license">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <FileCheck2 className="size-4" aria-hidden />
          License
        </div>
        <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>License number</span>
            <Input
              value={profile.licenseNumber}
              onChange={(e) => setProfile((cur) => ({ ...cur, licenseNumber: e.target.value }))}
              data-attr="vendor-onboarding-license-number"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>License document</span>
            <input
              ref={licenseInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setLicenseFile(e.target.files?.[0] ?? null)}
              data-attr="vendor-onboarding-license-file"
              className="text-sm"
            />
            {licenseFile ? (
              <span className="text-xs text-muted">{licenseFile.name}</span>
            ) : profile.licenseDocPath ? (
              <span className="text-xs text-muted">On file</span>
            ) : null}
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-insurance">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <ShieldCheck className="size-4" aria-hidden />
          Insurance
        </div>
        <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Provider</span>
            <Input
              value={profile.insuranceProvider}
              onChange={(e) => setProfile((cur) => ({ ...cur, insuranceProvider: e.target.value }))}
              data-attr="vendor-onboarding-insurance-provider"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Policy number</span>
            <Input
              value={profile.insurancePolicyNumber}
              onChange={(e) => setProfile((cur) => ({ ...cur, insurancePolicyNumber: e.target.value }))}
              data-attr="vendor-onboarding-insurance-policy"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Expires</span>
            <Input
              type="date"
              value={profile.insuranceExpiresAt ?? ""}
              onChange={(e) => setProfile((cur) => ({ ...cur, insuranceExpiresAt: e.target.value || null }))}
              data-attr="vendor-onboarding-insurance-expires"
            />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Certificate</span>
            <input
              ref={insuranceInputRef}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setInsuranceFile(e.target.files?.[0] ?? null)}
              data-attr="vendor-onboarding-insurance-file"
              className="text-sm"
            />
            {insuranceFile ? (
              <span className="text-xs text-muted">{insuranceFile.name}</span>
            ) : profile.insuranceDocPath ? (
              <span className="text-xs text-muted">On file</span>
            ) : null}
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-4" data-attr="vendor-onboarding-directory">
        <label className="flex items-center gap-3 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={profile.directoryListed}
            onChange={(e) => setProfile((cur) => ({ ...cur, directoryListed: e.target.checked }))}
            data-attr="vendor-onboarding-directory-toggle"
          />
          List me in the PropLane vendor directory
        </label>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 pb-6">
        <Button type="button" variant="outline" onClick={() => router.push("/vendor/dashboard")} data-attr="vendor-onboarding-skip">
          Skip for now
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => void save(false)} data-attr="vendor-onboarding-save">
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" disabled={saving || !requiredFilled} onClick={() => void save(true)} data-attr="vendor-onboarding-finish">
            {saving ? "Saving…" : "Finish"}
          </Button>
        </div>
      </div>
    </div>
  );
}
