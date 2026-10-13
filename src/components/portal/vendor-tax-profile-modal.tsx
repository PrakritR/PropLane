"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {Input, Select} from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";

export type VendorTaxDraft = {
  legalName: string;
  businessName: string;
  entityType: "individual" | "business";
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  tinType: "ein" | "ssn";
  tin: string;
  w9Attestation: boolean;
};

const EMPTY: VendorTaxDraft = {
  legalName: "",
  businessName: "",
  entityType: "business",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  tinType: "ein",
  tin: "",
  w9Attestation: false,
};

export function VendorTaxProfileModal({
  open,
  vendorId,
  vendorName,
  onClose,
  onSaved,
}: {
  open: boolean;
  vendorId: string | null;
  vendorName?: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const [draft, setDraft] = useState<VendorTaxDraft>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !vendorId) return;
    void Promise.resolve().then(() => {
      setLoading(true);
      void fetch(`/api/vendors/${encodeURIComponent(vendorId)}/tax-profile`)
        .then((r) => r.json())
        .then((data) => {
          const p = data.profile;
          if (!p) {
            setDraft({ ...EMPTY, legalName: vendorName ?? "" });
            return;
          }
          setDraft({
            legalName: p.legal_name ?? "",
            businessName: p.business_name ?? "",
            entityType: p.entity_type === "individual" ? "individual" : "business",
            addressLine1: p.address_line1 ?? "",
            addressLine2: p.address_line2 ?? "",
            city: p.city ?? "",
            state: p.state ?? "",
            zip: p.zip ?? "",
            tinType: p.tin_type === "ssn" ? "ssn" : "ein",
            tin: "",
            w9Attestation: p.w9_attestation === true,
          });
        })
        .finally(() => setLoading(false));
    });
  }, [open, vendorId, vendorName]);

  async function save() {
    if (!vendorId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/vendors/${encodeURIComponent(vendorId)}/tax-profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legalName: draft.legalName,
          businessName: draft.businessName,
          entityType: draft.entityType,
          addressLine1: draft.addressLine1,
          addressLine2: draft.addressLine2,
          city: draft.city,
          state: draft.state,
          zip: draft.zip,
          tinType: draft.tinType,
          tin: draft.tin || undefined,
          w9Attestation: draft.w9Attestation,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      showToast("Tax profile saved.");
      onSaved?.();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`W-9 / tax info${vendorName ? ` · ${vendorName}` : ""}`}
      footer={
        <ModalFooter>
          <Button variant="primary" onClick={() => save()} disabled={saving || loading}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Legal name
            <Input value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Business name
            <Input value={draft.businessName} onChange={(e) => setDraft({ ...draft, businessName: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Entity type
            <Select
             
              value={draft.entityType}
              onChange={(e) => setDraft({ ...draft, entityType: e.target.value as VendorTaxDraft["entityType"] })}
            >
              <option value="business">Business</option>
              <option value="individual">Individual</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            TIN type
            <Select
             
              value={draft.tinType}
              onChange={(e) => setDraft({ ...draft, tinType: e.target.value as VendorTaxDraft["tinType"] })}
            >
              <option value="ein">EIN</option>
              <option value="ssn">SSN</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Address line 1
            <Input value={draft.addressLine1} onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Address line 2
            <Input value={draft.addressLine2} onChange={(e) => setDraft({ ...draft, addressLine2: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            City
            <Input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            State
            <Input value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            ZIP
            <Input value={draft.zip} onChange={(e) => setDraft({ ...draft, zip: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            {draft.tinType === "ein" ? "EIN" : "SSN"} (leave blank to keep existing)
            <Input value={draft.tin} onChange={(e) => setDraft({ ...draft, tin: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
            <input
              type="checkbox"
              checked={draft.w9Attestation}
              onChange={(e) => setDraft({ ...draft, w9Attestation: e.target.checked })}
            />
            W-9 on file
          </label>
        </div>
      )}
    </Modal>
  );
}
