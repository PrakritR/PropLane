"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { Button } from "@/components/ui/button";
import type { CommsPlanCreditRule } from "@/lib/comms-billing/pool.server";

const TIER_LABEL: Record<string, string> = { free: "Free", pro: "Pro", business: "Business" };

type RuleDraft = { includedDollars: string; sharedAcrossWorkspaces: boolean; rollsOver: boolean };

/**
 * Global per-plan messaging-credit defaults (S27): included credit, whether
 * it is shared across a funder's workspaces, and whether unused credit rolls
 * over. Only takes effect through the messaging-credit pool
 * (`COMMS_CREDIT_POOL_ENABLED`) — while that flag is off this table still
 * edits real rows, but nothing reads them yet.
 *
 * Exported so `AdminAxisUsersClient` (the live Accounts surface) can mount it
 * inside the "Plan credit" header modal its header icon action opens. Saves
 * go through the same `/api/admin/comms-plan-credit-rules` route regardless
 * of which surface renders this component.
 */
export function PlanCreditRulesSection() {
  const [rules, setRules] = useState<CommsPlanCreditRule[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>({});
  const [busyTier, setBusyTier] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/admin/comms-plan-credit-rules", { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as { rules?: CommsPlanCreditRule[]; error?: string };
      if (!res.ok) throw new Error(body.error || "Could not load plan credit rules.");
      setRules(body.rules ?? []);
      setDrafts(
        Object.fromEntries(
          (body.rules ?? []).map((rule) => [
            rule.tier,
            {
              includedDollars: String(rule.includedCents / 100),
              sharedAcrossWorkspaces: rule.sharedAcrossWorkspaces,
              rollsOver: rule.rollsOver,
            },
          ]),
        ),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load plan credit rules.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (tier: string) => {
    const draft = drafts[tier];
    if (!draft) return;
    const includedDollars = Number(draft.includedDollars);
    if (!Number.isFinite(includedDollars) || includedDollars < 0) {
      setError("Enter a whole-dollar included amount.");
      return;
    }
    setBusyTier(tier);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/admin/comms-plan-credit-rules", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          includedDollars,
          sharedAcrossWorkspaces: draft.sharedAcrossWorkspaces,
          rollsOver: draft.rollsOver,
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "Could not save the plan credit rule.");
      setNotice(`${TIER_LABEL[tier] ?? tier} saved.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the plan credit rule.");
    } finally {
      setBusyTier(null);
    }
  };

  return (
    <PortalSettingsSection title="Plan credit">
      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mb-3 text-sm text-muted">
          {notice}
        </p>
      ) : null}
      {!rules ? (
        <div className="h-32 animate-pulse rounded-2xl border border-border bg-accent/30" aria-hidden />
      ) : (
        <PortalSettingsGroup>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-attr="admin-plan-credit-table">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="px-4 py-2.5 font-semibold">Plan</th>
                  <th className="px-4 py-2.5 font-semibold">Included/mo</th>
                  <th className="px-4 py-2.5 font-semibold">Shared across workspaces</th>
                  <th className="px-4 py-2.5 font-semibold">Unused rolls over</th>
                  <th className="px-4 py-2.5 font-semibold" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {rules.map((rule) => {
                  const draft = drafts[rule.tier] ?? {
                    includedDollars: String(rule.includedCents / 100),
                    sharedAcrossWorkspaces: rule.sharedAcrossWorkspaces,
                    rollsOver: rule.rollsOver,
                  };
                  return (
                    <tr key={rule.tier} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium text-foreground">{TIER_LABEL[rule.tier] ?? rule.tier}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5">
                          <span className="text-muted">$</span>
                          <input
                            inputMode="decimal"
                            value={draft.includedDollars}
                            onChange={(e) =>
                              setDrafts((prev) => ({ ...prev, [rule.tier]: { ...draft, includedDollars: e.target.value } }))
                            }
                            className="w-16 bg-transparent tabular-nums outline-none"
                            aria-label={`${TIER_LABEL[rule.tier] ?? rule.tier} included credit in dollars`}
                            data-attr={`admin-plan-credit-included-${rule.tier}`}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={draft.sharedAcrossWorkspaces}
                          onChange={(e) =>
                            setDrafts((prev) => ({ ...prev, [rule.tier]: { ...draft, sharedAcrossWorkspaces: e.target.checked } }))
                          }
                          data-attr={`admin-plan-credit-shared-${rule.tier}`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={draft.rollsOver}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [rule.tier]: { ...draft, rollsOver: e.target.checked } }))}
                          data-attr={`admin-plan-credit-rollover-${rule.tier}`}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-full text-[13px]"
                          loading={busyTier === rule.tier}
                          onClick={() => void save(rule.tier)}
                          data-attr={`admin-plan-credit-save-${rule.tier}`}
                        >
                          Save
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </PortalSettingsGroup>
      )}
    </PortalSettingsSection>
  );
}

/**
 * Admin → Billing: merged into Accounts (captain: "combine Billing and
 * Accounts"). Plan, caps, complimentary status and comms credit all live on
 * the account record page now — Billing was a second editor over the exact
 * same accounts Accounts already lists, which is two sets of rules for the
 * same write.
 *
 * `/admin/billing` has no route: `"billing"` was never added to
 * `adminPortal.sections` (`src/lib/portals/admin.ts`), so
 * `render-portal-section.tsx`'s `findSection` lookup 404s before any branch
 * for this section could run — the redirect card below was landed but never
 * actually reachable by URL. The stale claim that it "still resolves" has
 * been corrected in `admin.ts`, and the now-dead `section === "billing"`
 * branch that used to mount this component has been removed from
 * `render-portal-section.tsx`, so `AdminBillingClient` itself is unused by any
 * route today. It is kept only because the shared `PlanCreditRulesSection`
 * above lived in this file first; that table is what actually ships now, via
 * the "Plan credit" header action + modal on Accounts
 * (`AdminAxisUsersClient`), per `docs/agents/plan-entitlements.md` § Admin
 * Billing (a GLOBAL, not per-account, plan default).
 */
export function AdminBillingClient() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const openAccounts = () => {
    const href = query.trim() ? `/admin/axis-users?q=${encodeURIComponent(query.trim())}` : "/admin/axis-users";
    router.push(href);
  };

  return (
    <ManagerPortalPageShell title="Billing" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null}>
      <div className="mx-auto max-w-3xl space-y-8">
        <PlanCreditRulesSection />
      </div>
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-10 text-center">
        <CreditCard className="size-6 text-muted" aria-hidden />
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">Billing is now part of Accounts</h2>
          <p className="text-sm text-muted">
            Plan, fees and comms credit live on each manager&apos;s account — open Accounts and pick a manager.
          </p>
        </div>
        <form
          className="flex w-full items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            openAccounts();
          }}
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a manager by name or email"
            className="h-10 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
            data-attr="admin-billing-redirect-search"
          />
          <Button type="submit" variant="outline" data-attr="admin-billing-redirect-find">
            Find
          </Button>
        </form>
        <Button type="button" onClick={openAccounts} data-attr="admin-billing-redirect-open-accounts">
          Open Accounts
        </Button>
      </div>
    </ManagerPortalPageShell>
  );
}
