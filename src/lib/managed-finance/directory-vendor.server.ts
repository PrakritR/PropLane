import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { pacificDayKey } from "@/lib/house-groups/time";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { createVendorInviteDraft } from "@/lib/vendor-invite.server";
import { LedgerError, postJournal, vendorDirectoryParty, vendorParty } from "@/lib/managed-finance/ledger.server";

/**
 * A vendor dispatched by text may have no PropLane login: the manager's directory row is all there is. On a managed workspace
 * the bill still posts (the payable sits under `vendor_dir:<directory id>`); this module (1) tells that vendor, once a day, that
 * money is waiting and how to create the account, and (2) when the account exists, moves the waiting balance to the vendor's
 * own party in one balanced, idempotent `directory_claim` journal per workspace, so the weekly batch and a manual withdrawal
 * can pay it. docs/agents/owner-management.md § Vendors without a login.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** What the directory party is owed per workspace (positive = owed), from the ledger lines. */
export async function directoryBalancesByWorkspace(db: SupabaseClient, directoryId: string): Promise<Array<{ workspaceId: string | null; owedCents: number }>> {
  const { data, error } = await db
    .from("party_ledger_lines")
    .select("workspace_id, amount_cents")
    .eq("account", "vendor_payable")
    .eq("party_id", vendorDirectoryParty(directoryId))
    .limit(5000);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new LedgerError(500, "Could not read the vendor's waiting balance.");
  }
  const byWorkspace = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ workspace_id: string | null; amount_cents: number | string }>) {
    const key = row.workspace_id ?? "";
    byWorkspace.set(key, (byWorkspace.get(key) ?? 0) + Number(row.amount_cents));
  }
  return [...byWorkspace.entries()]
    .map(([workspaceId, sum]) => ({ workspaceId: workspaceId || null, owedCents: -sum }))
    .filter((r) => Number.isSafeInteger(r.owedCents) && r.owedCents > 0);
}

export async function directoryWaitingCents(db: SupabaseClient, directoryId: string): Promise<number> {
  return (await directoryBalancesByWorkspace(db, directoryId)).reduce((s, r) => s + r.owedCents, 0);
}

/**
 * Move a directory vendor's open balance to their account. One `directory_claim` journal per workspace
 * (DR vendor_dir payable, CR vendor payable; both sides keep the workspace so statements stay per workspace), keyed on
 * (directory, user, workspace, amount): a replay is a no-op and a balance that is already moved posts nothing.
 */
export async function rekeyDirectoryBalances(
  db: SupabaseClient,
  input: { directoryId: string; vendorUserId: string },
): Promise<{ journals: number; movedCents: number }> {
  const directoryId = input.directoryId.trim();
  const vendorUserId = input.vendorUserId.trim();
  if (!directoryId || !vendorUserId) throw new LedgerError(400, "A balance move needs a directory vendor and an account.");
  let journals = 0;
  let movedCents = 0;
  for (const bucket of await directoryBalancesByWorkspace(db, directoryId)) {
    const result = await postJournal(db, {
      workspaceId: bucket.workspaceId,
      kind: "directory_claim",
      key: `directory-claim:${directoryId}:${vendorUserId}:${bucket.workspaceId ?? "-"}:${bucket.owedCents}`,
      sourceType: "vendor_directory",
      sourceId: directoryId,
      detail: { directory_id: directoryId, vendor_user_id: vendorUserId, amount_cents: bucket.owedCents },
      lines: [
        { account: "vendor_payable", party_id: vendorDirectoryParty(directoryId), workspace_id: bucket.workspaceId, amount_cents: bucket.owedCents },
        { account: "vendor_payable", party_id: vendorParty(vendorUserId), workspace_id: bucket.workspaceId, amount_cents: -bucket.owedCents },
      ],
    });
    if (result.created) {
      journals += 1;
      movedCents += bucket.owedCents;
    }
  }
  return { journals, movedCents };
}

/**
 * A new vendor account: claim the directory rows that were waiting for it, by PROVEN contact only (a verified email or a
 * verified phone; a typed one proves nothing), link the row to the account and move the open balance. Only rows with money
 * waiting are considered, so the scan is bounded. Returns the directory ids claimed.
 */
export async function claimWaitingDirectoryBalances(
  db: SupabaseClient,
  input: { userId: string; email?: string | null; emailProven?: boolean; phone?: string | null; phoneProven?: boolean },
): Promise<string[]> {
  const userId = input.userId.trim();
  const email = input.emailProven ? str(input.email).toLowerCase() : "";
  const phone = input.phoneProven ? normalizeE164(input.phone) : null;
  if (!userId || (!email && !phone)) return [];
  const { data, error } = await db.from("party_ledger_lines").select("party_id").eq("account", "vendor_payable").like("party_id", "vendor_dir:%").limit(5000);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw new LedgerError(500, "Could not read waiting vendor balances.");
  }
  const ids = [...new Set(((data ?? []) as Array<{ party_id: string | null }>).map((r) => str(r.party_id).slice("vendor_dir:".length)).filter(Boolean))];
  if (ids.length === 0) return [];
  const { data: records, error: recordError } = await db
    .from("manager_vendor_records")
    .select("id, vendor_user_id, row_data")
    .in("id", ids)
    .is("vendor_user_id", null);
  if (recordError) throw new LedgerError(500, "Could not read the vendor directory.");
  const claimed: string[] = [];
  for (const record of (records ?? []) as Array<{ id: string; row_data?: Row | null }>) {
    const row = record.row_data ?? {};
    const emailMatch = Boolean(email) && str(row.email).toLowerCase() === email;
    const phoneMatch = Boolean(phone) && normalizeE164(row.phone) === phone;
    if (!emailMatch && !phoneMatch) continue;
    const { data: linked, error: linkError } = await db
      .from("manager_vendor_records")
      .update({ vendor_user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", record.id)
      .is("vendor_user_id", null)
      .select("id");
    if (linkError) throw new LedgerError(500, "Could not link the vendor.");
    if (!linked || (linked as unknown[]).length === 0) continue; // someone else linked it first
    await rekeyDirectoryBalances(db, { directoryId: record.id, vendorUserId: userId });
    claimed.push(record.id);
  }
  return claimed;
}

/**
 * "You have $X waiting: create your account to get paid." Sent from the workspace's work number to the directory row's own
 * phone, at most once per vendor per Pacific day; never when the vendor already has an account or nothing is waiting. The
 * link is the vendor invite (token) when the row has an email, else the plain vendor sign-up page. Never throws.
 */
export async function textUnclaimedDirectoryBalance(
  db: SupabaseClient,
  input: { directoryId: string; workspaceId: string; now?: Date; origin?: string },
): Promise<boolean> {
  try {
    const { data } = await db.from("manager_vendor_records").select("id, manager_user_id, vendor_user_id, row_data").eq("id", input.directoryId).maybeSingle();
    const record = data as { id: string; manager_user_id: string; vendor_user_id: string | null; row_data?: Row | null } | null;
    if (!record || record.vendor_user_id) return false;
    const row = record.row_data ?? {};
    const phone = normalizeE164(row.phone);
    if (!phone) return false;
    const waiting = await directoryWaitingCents(db, record.id);
    if (waiting < 100) return false;
    const origin = input.origin ?? resolveEmailLinkBaseUrl();
    let link = `${origin}/auth/vendor-register`;
    const email = str(row.email).toLowerCase();
    // Reuse a live invite so a same-day retry never invalidates the link already texted.
    const { data: liveInvite } = await db
      .from("vendor_invites")
      .select("invite_token, expires_at")
      .eq("vendor_directory_id", record.id)
      .eq("status", "pending")
      .gt("expires_at", (input.now ?? new Date()).toISOString())
      .limit(1)
      .maybeSingle();
    const liveToken = str((liveInvite as Row | null)?.invite_token);
    if (liveToken) {
      link = `${origin}/auth/vendor-register?token=${encodeURIComponent(liveToken)}`;
    } else if (email.includes("@")) {
      const { data: manager } = await db.from("profiles").select("full_name").eq("id", record.manager_user_id).maybeSingle();
      const draft = await createVendorInviteDraft(db, {
        managerUserId: record.manager_user_id,
        managerName: str((manager as Row | null)?.full_name) || "Your property manager",
        vendorId: record.id,
        vendorEmail: email,
        vendorName: str(row.name),
        origin,
      }).catch(() => null);
      if (draft?.ok) link = draft.draft.linkUrl;
    }
    const dollars = `$${(waiting / 100).toFixed(waiting % 100 === 0 ? 0 : 2)}`;
    const day = pacificDayKey(input.now ?? new Date());
    return await sendWorkspacePhoneText(db, {
      workspaceId: input.workspaceId,
      phoneKey: phone,
      body: `You have ${dollars} waiting from PropLane. Create your account to get paid: ${link}`,
      role: "vendor",
      idempotencyKey: `dir-balance-waiting:${record.id}:${day}`,
    });
  } catch (error) {
    console.error("[directory-vendor] waiting-balance text failed", error instanceof Error ? error.message : "unknown");
    return false;
  }
}
