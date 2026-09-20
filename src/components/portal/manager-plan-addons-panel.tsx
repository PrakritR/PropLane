"use client";

import Link from "next/link";
import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { formatAddonPrice, type PlanAddonId } from "@/lib/plan-addons";

const ENDPOINT = "/api/manager/plan-addons";

/** The fact that follows the per-unit price on each add-on's row label (PLAN-0920 UI mock). */
const ADDON_ROW_FACT: Partial<Record<PlanAddonId, string>> = {
  extra_work_number: "up to 2 per workspace",
  extra_workspace: "includes a work number",
};

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

function quantitiesOf(addons: AddonRow[]): Partial<Record<PlanAddonId, number>> {
  return Object.fromEntries(addons.map((a) => [a.id, a.quantity]));
}

function formatSignedAddonPrice(cents: number): string {
  return cents < 0 ? `-${formatAddonPrice(-cents)}` : `+${formatAddonPrice(cents)}`;
}

/**
 * Settings → Billing & plan → Add-ons. Steppers only ever change LOCAL draft
 * state; nothing is sent to the server until Buy (PLAN-0920). A banner
 * appears the moment any row differs from what the account already holds,
 * with the combined monthly delta, and one Buy commits every changed row as
 * a single prorated batch — quantities are re-read from that response, never
 * assumed from the click. Free sees the prices and an upgrade link instead
 * of steppers. Add-ons are always purchasable: a row is never disabled for a
 * missing Stripe price (the server creates one from the catalog before the
 * first charge) — only at a real plan/workspace cap.
 */
export function ManagerPlanAddonsPanel() {
  const { isNative } = useIsNativeApp();
  const [data, setData] = useState<AddonsPayload | null>(null);
  const [draft, setDraft] = useState<Partial<Record<PlanAddonId, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      const body = (await response.json()) as AddonsPayload & { error?: string };
      if (!response.ok) throw new Error(body.error || "We couldn’t load your add-ons.");
      if (!mounted.current) return;
      setData(body);
      setDraft(quantitiesOf(body.addons));
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

  const step = (row: AddonRow, delta: number) => {
    setDraft((prev) => {
      const current = prev[row.id] ?? row.quantity;
      const max = row.maxQuantity ?? 100;
      return { ...prev, [row.id]: Math.max(0, Math.min(max, current + delta)) };
    });
  };

  // Rows whose local draft differs from the account's committed quantity —
  // exactly what Buy will send, and what drives the banner and its delta.
  const changes = useMemo(() => {
    if (!data) return [];
    return data.addons
      .filter((row) => (draft[row.id] ?? row.quantity) !== row.quantity)
      .map((row) => ({ addonId: row.id, quantity: draft[row.id] ?? row.quantity }));
  }, [data, draft]);

  const deltaCents = useMemo(() => {
    if (!data) return 0;
    return changes.reduce((sum, change) => {
      const row = data.addons.find((a) => a.id === change.addonId);
      return row ? sum + (change.quantity - row.quantity) * row.monthlyCents : sum;
    }, 0);
  }, [data, changes]);

  const buy = async () => {
    if (!changes.length) return;
    setBuying(true);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
      const body = (await response.json()) as AddonsPayload & { error?: string; stripeSynced?: boolean };
      if (!response.ok) throw new Error(body.error || "We couldn’t update your add-ons. Nothing changed.");
      if (!mounted.current) return;
      // Quantities always come back from the server response — never assumed
      // from what was clicked — so an all-or-nothing Stripe failure or a
      // partial catch-up on reload never drifts from what was actually billed.
      setData(body);
      setDraft(quantitiesOf(body.addons));
      setError(null);
      setNotice(`Add-ons updated${body.stripeSynced ? ", prorated from today" : ""}.`);
    } catch (e) {
      if (mounted.current) setNotice(e instanceof Error ? e.message : "We couldn’t update your add-ons. Nothing changed.");
    } finally {
      if (mounted.current) setBuying(false);
    }
  };

  const canEdit = Boolean(data?.canHoldAddons) && isNative === false;

  return (
    <PortalSettingsSection
      title="Add-ons"
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
              const quantity = draft[row.id] ?? row.quantity;
              const atCap = row.maxQuantity !== null && quantity >= row.maxQuantity;
              const fact = ADDON_ROW_FACT[row.id];
              return (
                <PortalSettingsRow
                  key={row.id}
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-1">
                      {row.label}
                      <span className="text-[12.5px] font-normal text-muted">
                        {` · ${formatAddonPrice(row.monthlyCents)}/mo each${fact ? ` · ${fact}` : ""}`}
                      </span>
                    </span>
                  }
                >
                  {canEdit ? (
                    <div className="flex items-center gap-1" data-attr={`plan-addon-${row.id}`}>
                      <button
                        type="button"
                        aria-label={`Remove one ${row.unit}`}
                        disabled={buying || quantity === 0}
                        onClick={() => step(row, -1)}
                        className="grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40"
                        data-attr={`plan-addon-${row.id}-remove`}
                      >
                        <Minus className="size-4" aria-hidden />
                      </button>
                      <span className="w-8 text-center text-sm font-semibold tabular-nums" data-attr={`plan-addon-${row.id}-quantity`}>
                        {quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${row.unit}`}
                        disabled={buying || atCap}
                        title={atCap ? `Your plan can hold up to ${row.maxQuantity} of these` : undefined}
                        onClick={() => step(row, 1)}
                        className="grid size-9 place-items-center rounded-full border border-border bg-card text-foreground transition hover:border-primary/40 disabled:opacity-40"
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
          {canEdit && changes.length > 0 ? (
            <div
              className="flex items-center justify-between gap-3 rounded-xl bg-muted/30 px-4 py-2.5"
              data-attr="plan-addons-commit-banner"
            >
              <span className="text-sm text-muted" data-attr="plan-addons-delta">
                {formatSignedAddonPrice(deltaCents)}/mo from today, prorated
              </span>
              <Button onClick={buy} loading={buying} data-attr="plan-addons-buy">
                Buy
              </Button>
            </div>
          ) : null}
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
      <RentReportingAddonRow disabled={isNative === true} />
    </PortalSettingsSection>
  );
}

const RENT_REPORTING_ENDPOINT = "/api/manager/rent-reporting-addon";

type RentReportingAddonPayload = {
  tier: "free" | "pro" | "business" | null;
  canHoldAddon: boolean;
  /** False until a furnisher partner is signed — the row reads "Coming soon" and cannot be turned on. */
  partnerLive?: boolean;
  enabled: boolean;
  reporting: number;
  total: number;
};

/**
 * Rent reporting is its own On/Off switch, not a `PLAN_ADDONS` quantity: its cost
 * scales with however many residents opt in this month, which the manager does not
 * choose, so it has no stepper and no per-unit price row here (see
 * `docs/agents/rent-reporting.md` "Billing" for how that gets charged).
 */
function RentReportingAddonRow({ disabled }: { disabled: boolean }) {
  const [data, setData] = useState<RentReportingAddonPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(RENT_REPORTING_ENDPOINT, { credentials: "include", cache: "no-store" });
      const body = (await response.json()) as RentReportingAddonPayload & { error?: string };
      if (!response.ok) return;
      if (mounted.current) setData(body);
    } catch {
      /* Settings panel already surfaces a load error for the addons above; this row just stays hidden. */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const toggle = async (next: string) => {
    if (!data) return;
    const enabled = next === "on";
    setBusy(true);
    try {
      const response = await fetch(RENT_REPORTING_ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await response.json()) as RentReportingAddonPayload & { error?: string };
      if (response.ok && mounted.current) setData(body);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!data) return null;

  return (
    <PortalSettingsGroup className="mt-4">
      <PortalSettingsRow label="Rent reporting">
        {data.partnerLive !== true ? (
          <FieldSingleSelect
            label="Rent reporting"
            hideLabel
            variant="cell"
            wrapperClassName="w-32"
            value="coming_soon"
            onChange={() => undefined}
            disabled
            options={[{ value: "coming_soon", label: "Coming soon" }]}
            dataAttr="rent-reporting-addon-coming-soon"
          />
        ) : data.canHoldAddon ? (
          <FieldSingleSelect
            label="Rent reporting"
            hideLabel
            variant="cell"
            wrapperClassName="w-32"
            value={data.enabled ? "on" : "off"}
            onChange={(next) => void toggle(next)}
            disabled={disabled || busy}
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            dataAttr="rent-reporting-addon-toggle"
          />
        ) : (
          <Link href={MANAGER_PLAN_PORTAL_URL} className="text-sm font-semibold text-primary hover:underline" data-attr="rent-reporting-addon-upgrade">
            Upgrade
          </Link>
        )}
      </PortalSettingsRow>
      {data.partnerLive === true && data.canHoldAddon && data.enabled ? (
        <PortalSettingsRow label="Residents reporting">
          <span className="text-sm font-semibold tabular-nums" data-attr="rent-reporting-addon-count">
            {data.reporting} of {data.total}
          </span>
        </PortalSettingsRow>
      ) : null}
    </PortalSettingsGroup>
  );
}
