import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { findResidentCandidates } from "@/lib/one-number/router-lookups.server";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/phone-e164";
import { recordConsent, recordOptOut, loadSettings } from "./store.server";

export { HOUSE_CHAT_CONSENT_WORDING, HOUSE_CHAT_CONSENT_VERSION } from "./consent";

type Target = { workspaceId: string; propertyId: string | null };

async function residentTargets(db: SupabaseClient, userId: string): Promise<{ phoneKey: string; targets: Target[] } | null> {
  const { data } = await db.from("profiles").select("phone, phone_verified_at").eq("id", userId).maybeSingle();
  const row = data as { phone?: unknown; phone_verified_at?: unknown } | null;
  const e164 = normalizeE164(row?.phone == null ? "" : String(row.phone));
  if (!row?.phone_verified_at || !e164) return null;
  const config = await loadSharedLineConfig(db);
  const found = await findResidentCandidates(db, e164).catch(() => []);
  const targets = found
    .filter((f) => workspaceOnSharedLine(config, f.workspaceId))
    .map((f) => ({ workspaceId: f.workspaceId, propertyId: f.propertyId }));
  return targets.length > 0 ? { phoneKey: normalizeConsentPhone(e164), targets } : null;
}

/** Is the house chat offer worth showing this resident: shared line on, chat enabled for their team, verified phone. */
export async function houseChatOfferAvailable(db: SupabaseClient, userId: string): Promise<boolean> {
  const resolved = await residentTargets(db, userId);
  if (!resolved) return false;
  for (const t of resolved.targets) if ((await loadSettings(db, t.workspaceId)).enabled) return true;
  return false;
}

/**
 * Record a resident's yes / no to the house chat. Server-owned: the phone and the workspaces come from
 * the signed-in account, never the request. A yes is `consent_at` + source `lease_signature`; a no is
 * the same "leave group" state a text would set.
 */
export async function recordResidentHouseChatChoice(
  db: SupabaseClient,
  userId: string,
  consent: boolean,
): Promise<{ ok: boolean; workspaces: Target[] }> {
  const resolved = await residentTargets(db, userId);
  if (!resolved) return { ok: false, workspaces: [] };
  const seen = new Set<string>();
  let ok = true;
  for (const t of resolved.targets) {
    if (seen.has(t.workspaceId)) continue;
    seen.add(t.workspaceId);
    ok = (consent ? await recordConsent(db, t.workspaceId, resolved.phoneKey, "lease_signature") : await recordOptOut(db, t.workspaceId, resolved.phoneKey)) && ok;
  }
  return { ok, workspaces: resolved.targets };
}
