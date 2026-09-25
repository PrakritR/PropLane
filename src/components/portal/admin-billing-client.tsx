"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CreditCard } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";

/**
 * Admin → Billing: merged into Accounts (captain: "combine Billing and
 * Accounts"). Plan, caps, complimentary status and comms credit all live on
 * the account record page now — Billing was a second editor over the exact
 * same accounts Accounts already lists, which is two sets of rules for the
 * same write.
 *
 * The `/admin/billing` route survives only as this one-line redirect card, so
 * a bookmark or a link a staff member already sent lands somewhere real
 * instead of a 404. There is no separate nav row any more (`admin.ts`).
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
