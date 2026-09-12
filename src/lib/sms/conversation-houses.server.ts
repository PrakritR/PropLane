import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which house(s) a Communication thread is about.
 *
 * One work number is shared by the whole workspace; what each member SEES is
 * decided per thread by the houses they hold, so every thread has to carry its
 * house(s). A tag only ever comes from a record (residency, tour,
 * application), an explicit leasing-agent match, an outbound sent from a house
 * context, or a human — never a guess: a wrong tag puts a prospect in front of
 * the wrong member. `manual` outranks everything and is the only source that
 * removes tags.
 */
export type ConversationHouseSource =
  | "residency"
  | "leasing"
  | "tour"
  | "application"
  | "outbound"
  | "manual";

export type ConversationHouseTag = {
  propertyId: string;
  source: ConversationHouseSource;
};

const TABLE = "manager_sms_conversation_houses";

/** Add one house to a thread. Additive and idempotent; a manual tag on the same house wins. */
export async function tagConversationHouse(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    conversationKey: string;
    propertyId: string;
    source: ConversationHouseSource;
    taggedByUserId?: string | null;
  },
): Promise<boolean> {
  const managerUserId = args.managerUserId.trim();
  const conversationKey = args.conversationKey.trim();
  const propertyId = args.propertyId.trim();
  if (!managerUserId || !conversationKey || !propertyId) return false;
  const { error } = await db.from(TABLE).upsert(
    {
      manager_user_id: managerUserId,
      conversation_key: conversationKey,
      property_id: propertyId,
      source: args.source,
      tagged_by_user_id: args.taggedByUserId ?? null,
    },
    // An existing tag is never downgraded by a later automatic one (a manual
    // tag in particular); only a manual write may replace what is there.
    { onConflict: "conversation_key,property_id", ignoreDuplicates: args.source !== "manual" },
  );
  return !error;
}

/**
 * Replace a thread's houses by hand. Empty `propertyIds` clears the thread
 * back to untagged (it then waits for full-access members only, see the
 * visibility rule in `sms-visibility.server.ts`).
 */
export async function setConversationHousesManually(
  db: SupabaseClient,
  args: { managerUserId: string; conversationKey: string; propertyIds: string[]; taggedByUserId: string },
): Promise<boolean> {
  const conversationKey = args.conversationKey.trim();
  const managerUserId = args.managerUserId.trim();
  if (!conversationKey || !managerUserId) return false;
  const wanted = [...new Set(args.propertyIds.map((id) => id.trim()).filter(Boolean))];
  const { error: clearError } = await db
    .from(TABLE)
    .delete()
    .eq("conversation_key", conversationKey)
    .eq("manager_user_id", managerUserId);
  if (clearError) return false;
  if (wanted.length === 0) return true;
  const { error } = await db.from(TABLE).insert(
    wanted.map((propertyId) => ({
      manager_user_id: managerUserId,
      conversation_key: conversationKey,
      property_id: propertyId,
      source: "manual" as const,
      tagged_by_user_id: args.taggedByUserId,
    })),
  );
  return !error;
}

/** Every tag on every thread owned by these managers, keyed by conversation key. */
export async function loadConversationHouses(
  db: SupabaseClient,
  managerUserIds: string[],
): Promise<Map<string, ConversationHouseTag[]>> {
  const out = new Map<string, ConversationHouseTag[]>();
  const owners = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (owners.length === 0) return out;
  const { data, error } = await db
    .from(TABLE)
    .select("conversation_key, property_id, source")
    .in("manager_user_id", owners)
    .limit(10000);
  if (error) {
    console.error("loadConversationHouses failed", error.message);
    return out;
  }
  for (const row of data ?? []) {
    const key = String(row.conversation_key ?? "").trim();
    const propertyId = String(row.property_id ?? "").trim();
    if (!key || !propertyId) continue;
    const list = out.get(key) ?? [];
    list.push({ propertyId, source: (row.source as ConversationHouseSource) ?? "outbound" });
    out.set(key, list);
  }
  return out;
}

/**
 * Tag a texting prospect's thread from inside an agent tool.
 *
 * Runs only when the agent is acting for a phone prospect (an emailed prospect
 * has no SMS thread) and the house is the workspace owner's — on the shared
 * Claw line a tool can resolve another manager's listing, and that thread is
 * not ours to tag. Never throws: tagging is a side effect of the tool doing
 * its job and must not fail the reply.
 */
export async function tagProspectThreadFromAgent(
  db: SupabaseClient,
  args: {
    landlordId: string;
    prospectPhoneE164: string | null | undefined;
    /**
     * A voice call and a text from the same prospect share one thread — the
     * conversation is keyed on the phone, not the channel — so voice tags the
     * same thread SMS does. Only email has no phone-keyed thread to tag.
     */
    channel?: "sms" | "voice" | "email" | null;
    propertyId: string;
    propertyOwnerUserId: string | null | undefined;
    source: Extract<ConversationHouseSource, "leasing" | "tour" | "application">;
  },
): Promise<void> {
  const phone = String(args.prospectPhoneE164 ?? "").trim();
  if (!phone || args.channel === "email") return;
  const owner = String(args.propertyOwnerUserId ?? "").trim();
  if (owner && owner !== args.landlordId) return;
  const { buildConversationKey } = await import("@/lib/sms-conversation-identity");
  await tagConversationHouse(db, {
    managerUserId: args.landlordId,
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.landlordId,
      role: "prospect",
      counterpartyUserId: null,
      counterpartyPhone: phone,
    }),
    propertyId: args.propertyId,
    source: args.source,
  }).catch(() => false);
}
