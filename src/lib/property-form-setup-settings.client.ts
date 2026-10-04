"use client";

/**
 * Shared client data for the Application/Lease editors' Setup step (P003, P006,
 * P009, P011). Reads and writes the SAME server-side settings the Settings →
 * Forms panel already edits (`pro-portal-settings-forms-panel.tsx`) — the
 * account-level application fee (`manager-application-settings.ts`), the
 * per-property leasing pipeline order / lease signing fee / default template
 * ids (`leasing-pipeline-preferences.ts`), and the property's application-fee
 * waiver code — scoped this time to ONE property via `?propertyId=`.
 *
 * Deliberately NOT a new money resolver: `applicationFeeCents` stays the one
 * whole-account fee (`docs/agents/resident-payments.md` "the Application
 * system fee is authoritative for EVERY listing"), and `leaseSigningFeeCents`
 * reuses the existing lease-signing-fee charge path
 * (`src/lib/lease-signing-fee-checkout.server.ts`). This hook only relocates
 * where those already-real values are edited — onto the property's own
 * Application/Lease forms — instead of inventing a second fee.
 */
import { sharedGet, writeThroughFetch } from "@/lib/shared-get-cache";
import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_LEASING_PIPELINE,
  normalizeLeasingPipelinePreferences,
  type LeasingPipelinePreferences,
} from "@/lib/leasing-pipeline-preferences";
import {
  DEFAULT_MANAGER_APPLICATION_SETTINGS,
  normalizeManagerApplicationSettings,
  type ApplicationFeeChargePolicy,
  type ManagerApplicationSettings,
} from "@/lib/manager-application-settings";

export type PropertyFormSetupState = {
  loaded: boolean;
  leasingPipeline: LeasingPipelinePreferences;
  applicationSettings: ManagerApplicationSettings;
  waiverCode: string | null;
};

export type PropertyFormSetupPatch = {
  leasingPipeline?: LeasingPipelinePreferences;
  applicationFeeCents?: number | null;
  applicationFeeChargePolicy?: ApplicationFeeChargePolicy;
  waiverCode?: string;
};

type SettingsResponseBody = {
  leasingPipeline?: unknown;
  settings?: unknown;
  waiverCode?: unknown;
  error?: string;
};

export function usePropertyFormSetupSettings(
  propertyId: string | null | undefined,
  opts?: { enabled?: boolean },
): PropertyFormSetupState & { patch: (fields: PropertyFormSetupPatch) => Promise<boolean> } {
  const enabled = opts?.enabled !== false && Boolean(propertyId?.trim());
  const [state, setState] = useState<PropertyFormSetupState>({
    loaded: false,
    leasingPipeline: DEFAULT_LEASING_PIPELINE,
    applicationSettings: DEFAULT_MANAGER_APPLICATION_SETTINGS,
    waiverCode: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState((prev) => (prev.loaded ? prev : { ...prev, loaded: true }));
      return;
    }
    setState((prev) => ({ ...prev, loaded: false }));
    void (async () => {
      try {
        // Shared with every other reader of this property's settings on the page: the
        // Applications and Lease panels (and the row facts) each mount this hook, and
        // one visit used to send one identical request per mount.
        const res = await sharedGet(
          `/api/portal/manager-application-settings?propertyId=${encodeURIComponent(propertyId!.trim())}`,
        );
        const body = (res.data ?? {}) as SettingsResponseBody;
        if (!res.ok) throw new Error(body.error ?? "Could not load form settings.");
        if (!cancelled) {
          setState({
            loaded: true,
            leasingPipeline: normalizeLeasingPipelinePreferences(body.leasingPipeline),
            applicationSettings: normalizeManagerApplicationSettings(body.settings),
            waiverCode: typeof body.waiverCode === "string" ? body.waiverCode : null,
          });
        }
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, enabled]);

  const patch = useCallback(
    async (fields: PropertyFormSetupPatch): Promise<boolean> => {
      const id = propertyId?.trim();
      if (!id) return false;
      try {
        const res = await writeThroughFetch("/api/portal/manager-application-settings", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId: id, ...fields }),
        });
        const body = (await res.json().catch(() => ({}))) as SettingsResponseBody;
        if (!res.ok) return false;
        setState((prev) => ({
          loaded: true,
          leasingPipeline: body.leasingPipeline ? normalizeLeasingPipelinePreferences(body.leasingPipeline) : prev.leasingPipeline,
          applicationSettings: body.settings ? normalizeManagerApplicationSettings(body.settings) : prev.applicationSettings,
          waiverCode: typeof body.waiverCode === "string" ? body.waiverCode : prev.waiverCode,
        }));
        return true;
      } catch {
        return false;
      }
    },
    [propertyId],
  );

  return { ...state, patch };
}
