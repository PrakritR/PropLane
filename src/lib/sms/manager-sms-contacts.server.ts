import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  coerceCounterpartyRole,
  type SmsCounterpartyRole,
} from "@/lib/sms-conversation-identity";

export type ManagerSmsContact = {
  managerUserId: string;
  phoneE164: string;
  counterpartyRole: SmsCounterpartyRole;
  displayName: string | null;
  lastInboundAt: string | null;
};

export function managerSmsContactKey(
  managerUserId: string,
  phone: string | null | undefined,
  role: SmsCounterpartyRole,
): string {
  const normalized = normalizeE164(String(phone ?? ""));
  return normalized ? `${managerUserId.trim()}|${normalized}|${role}` : "";
}

export async function loadManagerSmsContactMap(
  db: SupabaseClient,
  managerUserIds: string[],
): Promise<Map<string, ManagerSmsContact>> {
  const owners = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (owners.length === 0) return new Map();
  const { data, error } = await db
    .from("manager_sms_contacts")
    .select("manager_user_id, phone_e164, counterparty_role, display_name, last_inbound_at")
    .in("manager_user_id", owners)
    .limit(5000);
  if (error) {
    // Additive rollout: inbox reads remain available while the migration lands.
    console.error("manager SMS contacts read failed", error.message);
    return new Map();
  }
  const out = new Map<string, ManagerSmsContact>();
  for (const row of data ?? []) {
    const managerUserId = String(row.manager_user_id ?? "").trim();
    const phoneE164 = normalizeE164(String(row.phone_e164 ?? ""));
    const role = coerceCounterpartyRole(row.counterparty_role);
    if (!managerUserId || !phoneE164) continue;
    const contact: ManagerSmsContact = {
      managerUserId,
      phoneE164,
      counterpartyRole: role,
      displayName: String(row.display_name ?? "").trim() || null,
      lastInboundAt: row.last_inbound_at ? String(row.last_inbound_at) : null,
    };
    out.set(managerSmsContactKey(managerUserId, phoneE164, role), contact);
  }
  return out;
}

export async function upsertManagerSmsContact(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    phone: string;
    counterpartyRole: SmsCounterpartyRole;
    displayName?: string | null;
    lastInboundAt?: string | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const managerUserId = args.managerUserId.trim();
  const phoneE164 = normalizeE164(args.phone);
  const displayName = args.displayName == null ? undefined : args.displayName.trim();
  if (!managerUserId || !phoneE164) return { ok: false, error: "invalid_contact" };
  if (displayName !== undefined && (displayName.length < 1 || displayName.length > 80)) {
    return { ok: false, error: "invalid_display_name" };
  }
  const now = new Date().toISOString();
  const row = {
    manager_user_id: managerUserId,
    phone_e164: phoneE164,
    counterparty_role: args.counterpartyRole,
    ...(displayName !== undefined ? { display_name: displayName } : {}),
    ...(args.lastInboundAt ? { last_inbound_at: args.lastInboundAt } : {}),
    updated_at: now,
  };
  const { error } = await db.from("manager_sms_contacts").upsert(row, {
    onConflict: "manager_user_id,phone_e164,counterparty_role",
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function deleteManagerSmsContactName(
  db: SupabaseClient,
  args: { managerUserId: string; phone: string; counterpartyRole: SmsCounterpartyRole },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const phoneE164 = normalizeE164(args.phone);
  if (!args.managerUserId.trim() || !phoneE164) return { ok: false, error: "invalid_contact" };
  const { error } = await db
    .from("manager_sms_contacts")
    .update({ display_name: null, updated_at: new Date().toISOString() })
    .eq("manager_user_id", args.managerUserId.trim())
    .eq("phone_e164", phoneE164)
    .eq("counterparty_role", args.counterpartyRole);
  return error ? { ok: false, error: error.message } : { ok: true };
}
