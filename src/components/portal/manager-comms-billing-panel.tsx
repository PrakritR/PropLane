"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  PortalSettingsRow,
  PortalSettingsGroup,
  PortalSettingsSection,
} from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ManagerCommsBillingSummary } from "@/lib/comms-billing/summary.server";

const ENDPOINT = "/api/manager/comms-billing";

export function ManagerCommsBillingPanel() {
  const { showToast } = useAppUi();
  const [summary, setSummary] = useState<ManagerCommsBillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(ENDPOINT, { credentials: "include", cache: "no-store" });
      if (!res.ok) throw new Error("Could not load usage billing.");
      const body = (await res.json()) as ManagerCommsBillingSummary;
      setSummary(body);
      setBudgetDraft(
        body.monthlyBudgetCents != null ? String(body.monthlyBudgetCents / 100) : "",
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load usage billing.");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveBudget = async () => {
    setSaving(true);
    try {
      const trimmed = budgetDraft.trim();
      const monthlyBudgetCents =
        trimmed === "" ? null : Math.round(Number.parseFloat(trimmed) * 100);
      if (monthlyBudgetCents != null && (!Number.isFinite(monthlyBudgetCents) || monthlyBudgetCents < 0)) {
        showToast("Enter a valid monthly budget in dollars, or leave blank.");
        return;
      }
      const res = await fetch(ENDPOINT, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthlyBudgetCents }),
      });
      if (!res.ok) throw new Error("Could not save budget.");
      setSummary((await res.json()) as ManagerCommsBillingSummary);
      showToast("Usage budget saved.");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save budget.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PortalSettingsSection title="Usage billing" description="Pay-as-you-go communication rates.">
        <p className="text-sm text-muted">Loading…</p>
      </PortalSettingsSection>
    );
  }

  if (!summary?.paygEnabled) return null;

  return (
    <PortalSettingsSection
      title="Usage billing"
      description="Text, voice, and AI on your work number are billed pay-as-you-go. Inbound messages and calls are charged to your account."
    >
      {summary.blockMessage ? (
        <p className="text-sm text-destructive">{summary.blockMessage}</p>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">This month</p>
        <PortalSettingsGroup>
        <PortalSettingsRow label="Estimated usage" description="Resets on the 1st (UTC).">
          <p className="text-lg font-semibold">{summary.formattedMonthToDate}</p>
        </PortalSettingsRow>
        {summary.meterTotals.length > 0 ? (
          <ul className="text-sm space-y-1">
            {summary.meterTotals.map((row) => (
              <li key={row.meter} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{row.label}</span>
                <span>
                  {row.quantity} · ${(row.totalCents / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No usage recorded yet this month.</p>
        )}
      </PortalSettingsGroup>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Rates</p>
        <PortalSettingsGroup>
        <ul className="text-sm space-y-1 text-muted-foreground">
          <li>Outbound SMS — $0.03 / segment</li>
          <li>Inbound SMS — $0.02 / segment</li>
          <li>Voice — $0.04 / minute</li>
          <li>Speech recognition — $0.05 / turn</li>
          <li>AI assistant — $0.15 / turn</li>
          <li>Work number — $3.00 / month</li>
        </ul>
      </PortalSettingsGroup>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Budget alerts</p>
        <PortalSettingsGroup>
        <PortalSettingsRow
          label="Monthly budget (optional)"
          description="Email at 80% and 100% of this amount. Leave blank for no alerts."
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">$</span>
            <Input
              className="max-w-[8rem]"
              inputMode="decimal"
              value={budgetDraft}
              onChange={(e) => setBudgetDraft(e.target.value)}
              placeholder="64"
            />
            <Button loading={saving} onClick={() => saveBudget()}>
              Save budget
            </Button>
          </div>
        </PortalSettingsRow>
      </PortalSettingsGroup>
      </div>

      <p className="text-sm text-muted-foreground">
        {summary.hasPaymentMethod
          ? "Payment method on file."
          : "Add a card in "}
        {!summary.hasPaymentMethod ? (
          <Link href="/portal/settings/billing" className="underline">
            Billing
          </Link>
        ) : null}
        {!summary.hasPaymentMethod ? " before sending texts or taking calls." : null}
      </p>
    </PortalSettingsSection>
  );
}
