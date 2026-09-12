"use client";

import Link from "next/link";
import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { formatAddonPrice, type PlanAddonId } from "@/lib/plan-addons";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/manager/plan-addons";

type AddonRow = {
  id: PlanAddonId;
  label: string;
  unit: string;
  description: string;
  monthlyCents: number;
  maxQuantity: number | null;
  quantity: number;
  purchasable: boolean;
};

type AddonsPayload = {
  tier: "free" | "pro" | "business" | null;
  canHoldAddons: boolean;
  addons: AddonRow[];
  monthlyTotalCents: number;
};

/**
 * Settings → Billing & plan → Add-ons. One row per add-on with the price for
 * this plan and an Add / Remove stepper; Free sees the prices and an upgrade
 * link instead of steppers. Quantities are set server-side, which validates
 * the plan, the cap and the Stripe subscription item before anything is
 * written — the row here only ever reflects what the server answered.
 */
export function ManagerPlanAddonsPanel() {
  const { isNative } = useIsNativeApp();
  const [data, setData] = useState<AddonsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<PlanAddonId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      const body = (await response.json()) as AddonsPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "We couldn’t load your add-ons.");
      if (!mounted.current) return;
      setData(body);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "We couldn’t load your add-ons.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const setQuantity = async (row: AddonRow, quantity: number) => {
    setBusy(row.id);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addonId: row.id, quantity }),
      });
      const body = (await response.json()) as AddonsPayload & { error?: string; stripeSynced?: boolean };
      if (!response.ok) throw new Error(body.error || "We couldn’t update that add-on.");
      if (!mounted.current) return;
      setData(body);
      setError(null);
      setNotice(
        quantity > row.quantity
          ? `${row.label} added. Your next invoice includes it${body.stripeSynced ? ", prorated from today" : ""}.`
          : `${row.label} removed${body.stripeSynced ? "; the unused part of this month is credited" : ""}.`,
      );
    } catch (e) {
      if (mounted.current) setNotice(e instanceof Error ? e.message : "We couldn’t update that add-on.");
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const canEdit = Boolean(data?.canHoldAddons) && isNative === false;

  return (
    <PortalSettingsSection
      title="Add-ons"
      description="A price for everything past your plan's bundle — more listings, numbers, workspaces or seats, one at a time. Billed monthly with your subscription."
      action={
        data && data.monthlyTotalCents > 0 ? (
          <span className="text-sm font-semibold tabular-nums text-foreground" data-attr="plan-addons-total">
            {formatAddonPrice(data.monthlyTotalCents)}/mo
          </span>
        ) : undefined
      }
    >
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="outline" onClick={() => load()}>
            Try again
          </Button>
        </div>
      ) : null}
      {!data && !error ? (
        <p role="status" className="text-sm text-muted">
          Loading add-ons…
        </p>
      ) : null}
      {data ? (
        <>
          {!data.canHoldAddons ? (
            <p className="text-sm text-muted" data-attr="plan-addons-upgrade">
              Add-ons are for Pro and Business.{" "}
              <Link href={MANAGER_PLAN_PORTAL_URL} className="font-semibold text-primary hover:underline">
                Upgrade your plan
              </Link>{" "}
              to add listings, a work number, workspaces or seats.
            </p>
          ) : null}
          <PortalSettingsGroup>
            {data.addons.map((row) => {
              const atCap = row.maxQuantity !== null && row.quantity >= row.maxQuantity;
              return (
                <PortalSettingsRow
                  key={row.id}
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      {row.label}
                      <span className="text-[12.5px] font-normal text-muted">
                        {formatAddonPrice(row.monthlyCents)}/mo each
                      </span>
                    </span>
                  }
                  description={row.description}
                >
                  {canEdit ? (
                    <div className="flex items-center gap-1" data-attr={`plan-addon-${row.id}`}>
                      <button
                        type="button"
                        aria-label={`Remove one ${row.unit}`}
                        disabled={busy !== null || row.quantity === 0}
                        onClick={() => void setQuantity(row, row.quantity - 1)}
                        className={cn(
                          "grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40",
                        )}
                        data-attr={`plan-addon-${row.id}-remove`}
                      >
                        <Minus className="size-4" aria-hidden />
                      </button>
                      <span className="w-8 text-center text-sm font-semibold tabular-nums" data-attr={`plan-addon-${row.id}-quantity`}>
                        {row.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${row.unit}`}
                        disabled={busy !== null || atCap || !row.purchasable}
                        title={
                          !row.purchasable
                            ? "Not available for purchase yet"
                            : atCap
                              ? `Your plan can hold up to ${row.maxQuantity} of these`
                              : undefined
                        }
                        onClick={() => void setQuantity(row, row.quantity + 1)}
                        className={cn(
                          "grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40",
                        )}
                        data-attr={`plan-addon-${row.id}-add`}
                      >
                        <Plus className="size-4" aria-hidden />
                      </button>
                    </div>
                  ) : data.canHoldAddons && row.quantity > 0 ? (
                    <span className="text-sm font-semibold tabular-nums">{row.quantity}</span>
                  ) : null}
                </PortalSettingsRow>
              );
            })}
          </PortalSettingsGroup>
          {notice ? (
            <p role="status" className="text-sm text-muted" data-attr="plan-addons-notice">
              {notice}
            </p>
          ) : null}
          {data.canHoldAddons && isNative ? (
            <p className="text-sm text-muted">Add-ons are managed on the web.</p>
          ) : null}
        </>
      ) : null}
    </PortalSettingsSection>
  );
}
