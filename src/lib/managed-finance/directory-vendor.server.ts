import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { pacificDayKey } from "@/lib/house-groups/time";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { createVendorInviteDraft } from "@/lib/vendor-invite.server";
import { LedgerError, postJournal, readLedgerPages, vendorDirectoryParty, vendorParty } from "@/lib/managed-finance/ledger.server";
import { postgrestFilterValue } from "@/lib/supabase/or-filter";

/**
 * A vendor dispatched by text may have no PropLane login: the manager's directory row is all there is. On a managed workspace
 * the bill still posts (the payable sits under `vendor_dir:<directory id>`); this module (1) tells that vendor, once a day, that
 * money is waiting and how to create the account, and (2) when the account exists, moves the waiting balance to the vendor's
 * own party in one balanced, idempotent `directory_claim` journal per workspace, so the weekly batch and a manual withdrawal
 * can pay it. docs/agents/owner-management.md § Vendors without a login.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

type DirectoryBatch = { workspaceId: string | null; owedCents: number; digest: string };

/**
 * What the directory party is owed per workspace, with a DIGEST of the exact lines that make up the balance. The read is
 * paged in a stable order: a bare `.limit()` returned an arbitrary subset of a long ledger, which summed a directory's
 * waiting balance short.
 */
async function directoryBatches(db: SupabaseClient, directoryId: string): Promise<DirectoryBatch[]> {
  const partyId = vendorDirectoryParty(directoryId);
  const rows = await readLedgerPages<{ id?: string | null; workspace_id: string | null; amount_cents: number | string; created_at?: string | null }>(
    (from, to) =>
      db
        .from("party_ledger_lines")
        .select("id, workspace_id, amount_cents, created_at")
        .eq("account", "vendor_payable")
        .eq("party_id", partyId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
  ).catch((error: unknown) => {
    if (error instanceof LedgerError) throw new LedgerError(500, "Could not read the vendor's waiting balance.");
    throw error;
  });
  if (rows === "missing_schema") return [];
  const byWorkspace = new Map<string, { sum: number; parts: string[] }>();
  for (const row of rows) {
    const key = row.workspace_id ?? "";
    const bucket = byWorkspace.get(key) ?? { sum: 0, parts: [] };
    bucket.sum += Number(row.amount_cents);
    bucket.parts.push(`${String(row.id ?? "")}:${String(row.amount_cents)}`);
    byWorkspace.set(key, bucket);
  }
  return [...byWorkspace.entries()]
    .map(([workspaceId, bucket]) => ({
      workspaceId: workspaceId || null,
      owedCents: -bucket.sum,
      // The lines that make up THIS balance: a later batch of the same size gets its own key rather than replaying.
      digest: createHash("sha256").update(bucket.parts.sort().join("|")).digest("hex").slice(0, 24),
    }))
    .filter((r) => Number.isSafeInteger(r.owedCents) && r.owedCents > 0);
}

/** What the directory party is owed per workspace (positive = owed), from the ledger lines. */
export async function directoryBalancesByWorkspace(db: SupabaseClient, directoryId: string): Promise<Array<{ workspaceId: string | null; owedCents: number }>> {
  return (await directoryBatches(db, directoryId)).map(({ workspaceId, owedCents }) => ({ workspaceId, owedCents }));
}

export async function directoryWaitingCents(db: SupabaseClient, directoryId: string): Promise<number> {
  return (await directoryBalancesByWorkspace(db, directoryId)).reduce((s, r) => s + r.owedCents, 0);
}

/**
 * Move a directory vendor's open balance to their account. One `directory_claim` journal per workspace
 * (DR vendor_dir payable, CR vendor payable; both sides keep the workspace so statements stay per workspace), keyed on
 * (directory, user, workspace, the lines moved): a replay is a no-op, and a LATER batch for the same party posts its own
 * journal even when it totals the same cents.
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
  for (const bucket of await directoryBatches(db, directoryId)) {
    const result = await postJournal(db, {
      workspaceId: bucket.workspaceId,
      kind: "directory_claim",
      // Keyed on the LINES moved, not the amount: a second batch that happened to total the same cents as an
      // already-claimed one replayed as "created: false" and left the new balance stuck on the directory party.
      key: `directory-claim:${directoryId}:${vendorUserId}:${bucket.workspaceId ?? "-"}:${bucket.digest}`,
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

type DirectoryRecord = { id: string; vendor_user_id?: string | null; row_data?: Row | null };

/**
 * The directory rows that could be THIS vendor's, by proven contact.
 *
 * One narrow query, never a platform-wide scan: the email matches case-insensitively, and the phone is matched on its
 * last four digits (contiguous in every format a row can hold - "+12065550100", "(206) 555-0100", "206.555.0100"),
 * with the exact comparison done here against the normalized number. Scanning the whole `vendor_dir:%` ledger to
 * discover candidates read every vendor_payable line on the platform and then fed every id it found into one `.in()`.
 */
async function directoryRecordsForContact(
  db: SupabaseClient,
  input: { email: string; phone: string | null },
): Promise<DirectoryRecord[]> {
  const clauses: string[] = [];
  if (input.email) clauses.push(`row_data->>email.ilike.${postgrestFilterValue(input.email)}`);
  if (input.phone) clauses.push(`row_data->>phone.like.*${input.phone.slice(-4)}`);
  if (clauses.length === 0) return [];
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, vendor_user_id, row_data")
    .or(clauses.join(","))
    .limit(500);
  if (error) throw new LedgerError(500, "Could not read the vendor directory.");
  return ((data ?? []) as DirectoryRecord[]).filter((record) => {
    const row = record.row_data ?? {};
    if (input.email && str(row.email).toLowerCase() === input.email) return true;
    return Boolean(input.phone) && normalizeE164(row.phone) === input.phone;
  });
}

/**
 * A new vendor account: claim the directory rows that were waiting for it, by PROVEN contact only (a verified email or a
 * verified phone; a typed one proves nothing), link the row to the account and move the open balance. Only rows with money
 * waiting are considered, and only this vendor's own rows are read. Returns the directory ids claimed.
 */
export async function claimWaitingDirectoryBalances(
  db: SupabaseClient,
  input: { userId: string; email?: string | null; emailProven?: boolean; phone?: string | null; phoneProven?: boolean },
): Promise<string[]> {
  const userId = input.userId.trim();
  const email = input.emailProven ? str(input.email).toLowerCase() : "";
  const phone = input.phoneProven ? normalizeE164(input.phone) : null;
  if (!userId || (!email && !phone)) return [];
  const records = await directoryRecordsForContact(db, { email, phone });
  if (records.length === 0) return [];
  const claimed: string[] = [];
  for (const record of records) {
    const linkedTo = str(record.vendor_user_id);
    if (linkedTo && linkedTo !== userId) continue;
    // Already ours but money still on the directory party (an earlier re-key failed, or a bill posted after the
    // link): sweep it over. Nothing else looks for a stranded directory payable.
    if (linkedTo === userId) {
      const moved = await rekeyDirectoryBalances(db, { directoryId: record.id, vendorUserId: userId }).catch(() => null);
      if (moved && moved.journals > 0) claimed.push(record.id);
      continue;
    }
    // A row with nothing waiting is not this function's business: linking it is the directory's own job.
    if ((await directoryWaitingCents(db, record.id).catch(() => 0)) <= 0) continue;
    const { data: linked, error: linkError } = await db
      .from("manager_vendor_records")
      .update({ vendor_user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", record.id)
      .is("vendor_user_id", null)
      .select("id");
    if (linkError) throw new LedgerError(500, "Could not link the vendor.");
    if (!linked || (linked as unknown[]).length === 0) continue; // someone else linked it first
    try {
      await rekeyDirectoryBalances(db, { directoryId: record.id, vendorUserId: userId });
    } catch (error) {
      // The link must never outlive a failed move: a linked row is skipped by the contact match above, so the
      // payable would sit on `vendor_dir:` with nothing left to claim it. Give the row back and let a retry run.
      await db
        .from("manager_vendor_records")
        .update({ vendor_user_id: null, updated_at: new Date().toISOString() })
        .eq("id", record.id)
        .eq("vendor_user_id", userId)
        .then(undefined, () => undefined);
      throw error;
    }
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
      // An unclaimed directory vendor has no login yet: the text rides the vendor-conversation consent basis.
      basis: { kind: "vendor_notice", recipientUserId: null },
    });
  } catch (error) {
    console.error("[directory-vendor] waiting-balance text failed", error instanceof Error ? error.message : "unknown");
    return false;
  }
}
