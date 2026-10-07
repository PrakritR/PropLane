import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveSmsConversationRef, workspaceIdForWorkLine } from "@/lib/communication/conversation-key.server";
import {
  loadLinkedSmsConversations,
  loadResidentCounterparties,
  loadResidentPhoneIdentity,
  readProjectionCandidates,
  type ResidentPhoneIdentity,
} from "@/lib/communication/resident-conversations.server";
import {
  VENDOR_SMS_ROW_PREFIX,
  mergeResidentSmsConversations,
  stampCounterparties,
  type ResidentPhoneState,
  type ResidentSmsConversation,
} from "@/lib/communication/resident-conversation";
import { decideVendorSmsLink } from "@/lib/communication/vendor-conversation";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

/**
 * The SERVER side of a vendor's Communication: which text conversations are
 * theirs, who each is with, and what verifying a phone links. Every function
 * takes the AUTHENTICATED vendor id from the route (never a body); a failed
 * read returns "nothing", never a guess.
 */

type Db = SupabaseClient;
type Row = Record<string, unknown>;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The vendor's verified phone and whether anyone else verified it too (the identity rules are role-agnostic). */
export const loadVendorPhoneIdentity = loadResidentPhoneIdentity;

/** The text conversations that are this vendor's, ONE per manager workspace (the line's workspace, never a stamp). */
export async function loadVendorSmsConversations(
  db: Db,
  vendorId: string,
  preloaded?: ResidentPhoneIdentity,
): Promise<{ conversations: ResidentSmsConversation[]; phone: ResidentPhoneState }> {
  const id = clean(vendorId);
  if (!id) return { conversations: [], phone: { hasPhone: false, verified: false, ambiguous: false } };
  const identity = preloaded ?? (await loadVendorPhoneIdentity(db, id));
  return loadLinkedSmsConversations(db, identity, (row) =>
    decideVendorSmsLink({
      vendorId: id,
      verifiedPhone: identity.verifiedPhone,
      phoneVerifierIds: identity.phoneVerifierIds,
      row: { role: row.role, counterpartyUserId: row.userId, counterpartyPhone: row.phone },
    }),
  );
}

/**
 * The vendor's list, ready to return: every workspace-keyed row names who it is
 * with and the texts that are THEIRS are folded into the SAME conversation.
 * Linked history is not behind `SMS_COMM_UI_ENABLED`: the flag hides the
 * manager's text compose, never a vendor's own earlier conversation.
 */
export async function applyVendorConversationExtras(
  db: Db,
  vendor: { id: string; name?: string | null; mayReadVendorTexts: boolean },
  rows: PersistedInboxThread[],
): Promise<{ rows: PersistedInboxThread[]; phone: ResidentPhoneState }> {
  let phone: ResidentPhoneState = { hasPhone: false, verified: false, ambiguous: false };
  let sms: ResidentSmsConversation[] = [];
  if (vendor.mayReadVendorTexts) {
    const loaded = await loadVendorSmsConversations(db, vendor.id);
    sms = loaded.conversations;
    phone = loaded.phone;
  }
  const keyedWorkspaces = rows
    .filter((row) => String(row.conversationKey ?? "").startsWith("ws:"))
    .map((row) => String(row.conversationKey).slice(3));
  // Only workspaces this vendor really works with are named: a workspace key on
  // a stored row is a claim, a workspace a verified-phone conversation came from
  // is linked by construction.
  const linkedKeyed = await loadVendorLinkedWorkspaceIds(db, vendor.id, keyedWorkspaces);
  const identities = await loadResidentCounterparties(db, [...linkedKeyed, ...sms.map((entry) => entry.workspaceId)]);
  const stamped = stampCounterparties(rows, identities);
  return {
    rows: mergeResidentSmsConversations(stamped, sms, clean(vendor.name) || "You", { rowIdPrefix: VENDOR_SMS_ROW_PREFIX }),
    phone,
  };
}

/** The workspaces (among `workspaceIds`) whose owner has this vendor on their roster, linked by account. */
export async function loadVendorLinkedWorkspaceIds(
  db: Db,
  vendorId: string,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  const linked = new Set<string>();
  const ids = [...new Set(workspaceIds.map(clean).filter(Boolean))];
  if (!clean(vendorId) || ids.length === 0) return linked;
  try {
    const { data: workspaces } = await db.from("portal_workspaces").select("id, owner_user_id").in("id", ids);
    const ownerByWorkspace = new Map(((workspaces ?? []) as Row[]).map((row) => [clean(row.id), clean(row.owner_user_id)]));
    const owners = [...new Set([...ownerByWorkspace.values()].filter(Boolean))];
    if (owners.length === 0) return linked;
    const { data: roster } = await db
      .from("manager_vendor_records")
      .select("manager_user_id")
      .eq("vendor_user_id", vendorId)
      .in("manager_user_id", owners);
    const rosterOwners = new Set(((roster ?? []) as Row[]).map((row) => clean(row.manager_user_id)));
    for (const [workspaceId, owner] of ownerByWorkspace) if (rosterOwners.has(owner)) linked.add(workspaceId);
  } catch {
    return new Set();
  }
  return linked;
}

export type VendorPhoneLinkResult = {
  /** Roster rows that now carry this vendor's account (their saved phone IS the verified phone). */
  rosterLinked: number;
  /** Text conversations that now carry the vendor's conversation key. */
  stamped: number;
  skipped: "ambiguous" | "unverified" | null;
};

/**
 * Verifying a phone links what was already there. Best-effort and idempotent:
 * a failure never fails the verification that triggered it.
 *
 *   1. Only a VERIFIED phone, and only when no other account verified it too.
 *   2. A manager's roster row is linked (`vendor_user_id`) ONLY when the row's own
 *      saved phone equals the verified phone - never from a typed
 *      `vendor_business_profiles.work_phone`, never by name or email.
 *   3. The vendor's `vendor` text conversations on that number are re-keyed through
 *      the one resolver in the workspace that owns each work line (work line + epoch).
 */
export async function linkVerifiedVendorPhoneHistory(db: Db, vendorId: string): Promise<VendorPhoneLinkResult> {
  const id = clean(vendorId);
  const identity = await loadVendorPhoneIdentity(db, id);
  if (!identity.verifiedPhone) return { rosterLinked: 0, stamped: 0, skipped: "unverified" };
  if (identity.state.ambiguous) return { rosterLinked: 0, stamped: 0, skipped: "ambiguous" };
  let rosterLinked = 0;
  let stamped = 0;
  try {
    // Narrow by the number's last four digits (any saved format carries them) and
    // then require the EXACT normalized phone: the filter is a read bound, never the test.
    const { data: unlinked } = await db
      .from("manager_vendor_records")
      .select("id, manager_user_id, row_data")
      .is("vendor_user_id", null)
      .ilike("row_data->>phone", `%${identity.verifiedPhone.slice(-4)}%`)
      .limit(2000);
    for (const record of (unlinked ?? []) as Row[]) {
      const row = (record.row_data ?? null) as Row | null;
      if (!row || row.active === false || normalizeE164(row.phone) !== identity.verifiedPhone) continue;
      const { error } = await db
        .from("manager_vendor_records")
        .update({ vendor_user_id: id, row_data: { ...row, vendorUserId: id }, updated_at: new Date().toISOString() })
        .eq("id", clean(record.id))
        .is("vendor_user_id", null);
      if (!error) rosterLinked += 1;
    }

    const candidates = await readProjectionCandidates(db, identity);
    for (const row of candidates) {
      const link = decideVendorSmsLink({
        vendorId: id,
        verifiedPhone: identity.verifiedPhone,
        phoneVerifierIds: identity.phoneVerifierIds,
        row: { role: row.role, counterpartyUserId: row.userId, counterpartyPhone: row.phone },
      });
      if (!link || !row.workLineId) continue;
      const workspaceId = (await workspaceIdForWorkLine(db, row.workLineId)) ?? null;
      if (!workspaceId) continue;
      const ref = await resolveSmsConversationRef(db, {
        ownerManagerUserId: row.owner,
        workLineId: row.workLineId,
        workspaceId,
        counterpartyUserId: row.userId,
        counterpartyPhone: row.phone,
      });
      if (!ref || ref.flagged) continue;
      const { data, error } = await db.rpc("stamp_sms_projection_conversation", {
        p_conversation_id: row.id,
        p_workspace: ref.workspaceId,
        p_key: ref.key,
      });
      if (!error && data === true) stamped += 1;
    }
  } catch {
    // The vendor's own read path derives the same answer without the stamp.
  }
  return { rosterLinked, stamped, skipped: null };
}
