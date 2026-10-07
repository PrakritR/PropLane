"use client";

import { useEffect, useState } from "react";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import {
  PortalSettingsField,
  PortalSettingsGroup,
  PortalSettingsLinkRow,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { sharedGet } from "@/lib/shared-get-cache";
import { isDemoModeActive } from "@/lib/demo/demo-session";

type TaxProfileView = {
  legal_name?: string | null;
  business_name?: string | null;
  entity_type?: string | null;
  tin_type?: string | null;
  tin_last4?: string | null;
  w9_received_at?: string | null;
};

function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Settings → Invoicing: the tax details your invoices and year-end reports are
 * issued with (the W-9 on file, read-only — a manager records it) and the door
 * to the invoices themselves, which live on Payments.
 */
export function VendorInvoicingSettings() {
  const demo = isDemoModeActive();
  const [state, setState] = useState<"loading" | "ready" | "error">(demo ? "ready" : "loading");
  const [profile, setProfile] = useState<TaxProfileView | null>(null);
  const [linked, setLinked] = useState(true);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    void sharedGet("/api/vendor/tax-profile").then((read) => {
      if (cancelled) return;
      if (!read.ok) {
        setState("error");
        return;
      }
      const body = read.data as { profile?: TaxProfileView | null; linked?: boolean } | null;
      setProfile(body?.profile ?? null);
      setLinked(body?.linked !== false);
      setState("ready");
    });
    return () => {
      cancelled = true;
    };
  }, [demo]);

  return (
    <div data-attr="vendor-invoicing-settings" className="space-y-6">
      <PortalSettingsSection title="Tax details">
        <PortalSettingsGroup>
          {state === "loading" ? (
            <div className="px-4 py-4">
              <ListSkeleton rows={3} showLeading={false} />
            </div>
          ) : state === "error" ? (
            <p role="alert" className="px-4 py-4 text-sm" data-attr="vendor-invoicing-error">
              Could not load your tax details.
            </p>
          ) : !linked ? (
            <PortalSettingsField label="Status" value="Waiting on a manager" />
          ) : !profile ? (
            <PortalSettingsField label="W-9" value="Not on file" />
          ) : (
            <>
              <PortalSettingsField label="Legal name" value={profile.legal_name || "—"} />
              <PortalSettingsField label="Business name" value={profile.business_name || "—"} />
              <PortalSettingsField
                label={profile.tin_type === "ssn" ? "SSN" : "EIN"}
                value={profile.tin_last4 ? `•••• ${profile.tin_last4}` : "—"}
              />
              <PortalSettingsField label="W-9 received" value={formatDay(profile.w9_received_at)} />
            </>
          )}
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <PortalSettingsGroup>
        <PortalSettingsLinkRow label="Invoices and payments" href="/vendor/financials/income" dataAttr="vendor-invoicing-open-payments" />
      </PortalSettingsGroup>
    </div>
  );
}
