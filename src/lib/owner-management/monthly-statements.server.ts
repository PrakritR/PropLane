import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { portalSignInHref } from "@/lib/one-number/link-destinations.server";
import { loadOwnerFinances } from "@/lib/managed-finance/finances.server";
import { pacificMonthKey, previousMonthKey } from "@/lib/owner-management/fee-math";

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthName(key: string): string {
  const m = Number(key.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? key} ${key.slice(0, 4)}`;
}

/** The one text an owner gets on the 1st: plain, one segment where possible, no emoji. */
export function statementText(input: { monthKey: string; workspaceName: string; rentCents: number; feeCents: number; vendorCents: number; netCents: number; balanceCents: number; link: string }): string {
  const parts = [`${monthName(input.monthKey)} statement, ${input.workspaceName}:`, `rent ${usd(input.rentCents)}`];
  if (input.feeCents) parts.push(`PropLane ${usd(input.feeCents)}`);
  if (input.vendorCents) parts.push(`repairs ${usd(input.vendorCents)}`);
  parts.push(`you net ${usd(input.netCents)}.`, `Balance ${usd(input.balanceCents)}.`, input.link);
  return parts.join(" ").replace(/[^\x20-\x7e]/g, "");
}

/**
 * Last month's statement for every managed workspace, once: the unique (workspace, month) row is claimed first, so a re-run of
 * the cron (or two overlapping runs) sends nothing twice. A claimed row whose sends BOTH failed keeps null stamps and is
 * re-driven on the next run, so a provider outage delays a statement instead of losing the month. The email is from the
 * workspace's work email; the text is one line.
 */
export async function sendMonthlyOwnerStatements(db: SupabaseClient, now: Date = new Date()): Promise<{ sent: number; skipped: number }> {
  const month = previousMonthKey(pacificMonthKey(now));
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select("workspace_id, owner_user_id")
    .eq("status", "active")
    .not("signed_at", "is", null)
    .limit(1000);
  if (error) {
    if (String(error.code) === "42P01" || String(error.code) === "PGRST205") return { sent: 0, skipped: 0 };
    throw new Error("Could not list managed workspaces.");
  }
  let sent = 0;
  let skipped = 0;
  for (const p of (data ?? []) as Array<{ workspace_id: string; owner_user_id: string }>) {
    // A row that was claimed but never DELIVERED (a provider failure, a crash between the claim and the send) is
    // re-driven: the claim marks the month, the send stamps are what prove it went out.
    const { data: existing } = await db
      .from("owner_statements")
      .select("id, emailed_at, texted_at")
      .eq("workspace_id", p.workspace_id)
      .eq("month_key", month)
      .maybeSingle();
    const prior = existing as { emailed_at?: string | null; texted_at?: string | null } | null;
    if (prior && (prior.emailed_at || prior.texted_at)) { skipped += 1; continue; }
    const view = await loadOwnerFinances(db, null, { ownerUserId: p.owner_user_id, workspaceId: p.workspace_id, month }, now);
    const s = view.statement;
    if (s.rows.length === 0 && s.beginningCents === 0 && s.endingCents === 0) { skipped += 1; continue; }
    const totals = {
      rentGrossCents: s.totals.rentGrossCents, feeCents: s.totals.feeCents, vendorChargesCents: s.totals.vendorChargesCents,
      otherCents: s.totals.otherCents, netCents: s.totals.netCents, withdrawalsCents: s.totals.withdrawalsCents,
      beginningCents: s.beginningCents, endingCents: s.endingCents,
    };
    if (!prior) {
      const { data: claimed, error: claimError } = await db
        .from("owner_statements")
        .upsert({ workspace_id: p.workspace_id, owner_user_id: p.owner_user_id, month_key: month, totals }, { onConflict: "workspace_id,month_key", ignoreDuplicates: true })
        .select("id");
      // Another run claimed it in this instant: it owns the send.
      if (claimError || !claimed || claimed.length === 0) { skipped += 1; continue; }
    }

    const { data: ws } = await db.from("portal_workspaces").select("owner_user_id, name").eq("id", p.workspace_id).maybeSingle();
    const manager = String((ws as { owner_user_id?: string } | null)?.owner_user_id ?? "");
    const path = `/portal/financials/owner-payouts?workspace=${encodeURIComponent(p.workspace_id)}&month=${month}`;
    const link = `${resolveEmailLinkBaseUrl()}${portalSignInHref(path)}`;
    const body = [
      `Your ${monthName(month)} statement for ${view.workspace.name}`,
      `Rent collected: ${usd(s.totals.rentGrossCents)}`,
      `PropLane fee: ${usd(s.totals.feeCents)}`,
      `Repairs and vendors: ${usd(s.totals.vendorChargesCents)}`,
      `Net to you: ${usd(s.totals.netCents)}`,
      `Withdrawals: ${usd(s.totals.withdrawalsCents)}`,
      `Balance at the end of the month: ${usd(s.endingCents)}`,
    ].join("\n");
    let emailed = false;
    let texted = false;
    if (manager) {
      const r = await sendManagerNoticeEmail(db, {
        recipientUserId: p.owner_user_id, ownerUserId: manager, workspaceId: p.workspace_id,
        subject: `${monthName(month)} statement`, text: body, url: portalSignInHref(path), idempotencyKey: `owner-statement:${p.workspace_id}:${month}`,
      }).catch(() => ({ status: "failed" as const }));
      emailed = r.status === "sent";
    }
    const { data: profile } = await db.from("profiles").select("phone, phone_verified_at").eq("id", p.owner_user_id).maybeSingle();
    const prof = (profile ?? {}) as { phone?: string; phone_verified_at?: string };
    if (prof.phone && prof.phone_verified_at) {
      texted = await sendWorkspacePhoneText(db, {
        workspaceId: p.workspace_id, phoneKey: prof.phone, role: "manager", idempotencyKey: `owner-statement:${p.workspace_id}:${month}`,
        basis: { kind: "manager_notice", topic: "owner_statement", recipientUserId: p.owner_user_id },
        body: statementText({
          monthKey: month, workspaceName: view.workspace.name, rentCents: s.totals.rentGrossCents, feeCents: s.totals.feeCents,
          vendorCents: s.totals.vendorChargesCents, netCents: s.totals.netCents, balanceCents: s.endingCents, link,
        }),
      }).catch(() => false);
    }
    // Only what really went out is stamped; a null stamp is what lets the next run try again.
    if (emailed || texted) {
      await db
        .from("owner_statements")
        .update({ ...(emailed ? { emailed_at: now.toISOString() } : {}), ...(texted ? { texted_at: now.toISOString() } : {}) })
        .eq("workspace_id", p.workspace_id)
        .eq("month_key", month);
      sent += 1;
    } else {
      skipped += 1;
    }
  }
  return { sent, skipped };
}
