"use client";

import { useCallback, useEffect, useState } from "react";
import { MoneyInput } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { ownValuesOnPropertiesLabel } from "@/components/portal/settings-scope-bar";
import {
  normalizeWorkspacePricingDefaults,
  type WorkspacePricingDefaults,
} from "@/lib/workspace-pricing-defaults";

type WorkspacePaymentPublic = {
  pricingDefaults?: WorkspacePricingDefaults;
};

/**
 * Settings → Payments → Defaults for properties — workspace default rents (C2-PRC6 / C2-PS4).
 */
export function WorkspacePricingDefaultsPanel({ workspaceId }: { workspaceId: string | null }) {
  const [draft, setDraft] = useState<WorkspacePricingDefaults>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ownCount, setOwnCount] = useState(0);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setDraft({});
      setOwnCount(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/portal/manager-manual-payment-settings?workspaceId=${encodeURIComponent(workspaceId)}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      const row = (data.workspacePaymentSettings?.[workspaceId] ?? {}) as WorkspacePaymentPublic;
      setDraft(normalizeWorkspacePricingDefaults(row.pricingDefaults));
      setOwnCount(typeof data.ownPricingPropertyCount === "number" ? data.ownPricingPropertyCount : 0);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: WorkspacePricingDefaults) => {
    if (!workspaceId) return;
    setSaving(true);
    try {
      await fetch("/api/portal/manager-manual-payment-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          workspacePricingDefaults: patch,
        }),
      });
      setDraft(patch);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof WorkspacePricingDefaults, label: string) => (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="min-w-0">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {ownCount > 0 ? (
          <p className="mt-0.5 text-[12px] font-semibold text-muted">{ownValuesOnPropertiesLabel(ownCount)}</p>
        ) : null}
      </div>
      <MoneyInput
        label={label}
        value={draft[key] ? String(draft[key]) : ""}
        onChange={(v) => {
          const n = Number(v.replace(/[^0-9.]/g, ""));
          const next = { ...draft, [key]: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined };
          void save(next);
        }}
      />
    </div>
  );

  return (
    <div data-ps30-defaults>
      <PortalSettingsSection title="Defaults for properties">
        {loading ? (
          <p className="text-sm font-semibold text-muted">Loading defaults…</p>
        ) : (
          <PortalSettingsGroup>
            {field("rentPrivate", "Private room /mo")}
            {field("rentShared2", "Shared by 2 / resident")}
            {field("rentShared3", "Shared by 3+ / resident")}
            {field("rentWhole", "Whole house /mo")}
            {field("nightly", "Nightly rate")}
          </PortalSettingsGroup>
        )}
        {saving ? <p className="mt-2 text-[12px] font-semibold text-muted">Saving…</p> : null}
      </PortalSettingsSection>
    </div>
  );
}
