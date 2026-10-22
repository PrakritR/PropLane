import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSubscriberPopulation } from "@/lib/admin/admin-subscribers.server";
import { adminAccountKey } from "@/lib/admin/admin-account-keys";
import { loadProfilesByIdChunks } from "@/lib/auth/admin-portal-manager-ids.server";
import { setVendorLeadStatus } from "@/lib/one-number/onboarding/vendor-intake.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { addServiceVendor, type AddServiceVendorResult } from "@/lib/service/service-vendors.server";
import type { NetworkFreeManager } from "@/lib/service/service-network";

/**
 * Admin > Service > Network. Free-tier managers (the Subscribers "Free" bucket, so one definition of free) and the vendor lead
 * conversion. Both are admin-only: the routes start with `requireAdminRoute()` / `requirePlatformAdmin()`.
 */

export const FREE_MANAGER_LIMIT = 200;
const IN_CHUNK = 100;

async function inChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error("network read failed");
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/** Newest free managers first, with their houses, joined date and city. Throws when a read fails (the route says so). */
export async function listFreeManagers(db: SupabaseClient): Promise<NetworkFreeManager[]> {
  const population = await loadSubscriberPopulation(db);
  const free = population.rows
    .filter((row) => row.bucket === "free")
    .sort((a, b) => String(b.since ?? "").localeCompare(String(a.since ?? "")))
    .slice(0, FREE_MANAGER_LIMIT);
  if (free.length === 0) return [];
  const ids = free.map((row) => row.id);

  const [profiles, houses, workspaces] = await Promise.all([
    loadProfilesByIdChunks<{ id: string; manager_id: string | null }>(db, ids, "id, manager_id"),
    inChunks<{ manager_user_id: string }>(ids, (chunk) => db.from("manager_property_records").select("manager_user_id").in("manager_user_id", chunk)),
    inChunks<{ owner_user_id: string; city: string | null }>(ids, (chunk) => db.from("portal_workspaces").select("owner_user_id, city").in("owner_user_id", chunk)),
  ]);
  const proplaneId = new Map(profiles.map((p) => [p.id, String(p.manager_id ?? "")]));
  const houseCount = new Map<string, number>();
  for (const h of houses) houseCount.set(h.manager_user_id, (houseCount.get(h.manager_user_id) ?? 0) + 1);
  const city = new Map<string, string>();
  for (const w of workspaces) {
    const c = String(w.city ?? "").trim();
    if (c && !city.has(w.owner_user_id)) city.set(w.owner_user_id, c);
  }
  return free.map((row) => ({
    id: row.id,
    accountKey: adminAccountKey("manager", row.id),
    name: row.name || row.email,
    email: row.email,
    proplaneId: proplaneId.get(row.id) ?? "",
    houseCount: houseCount.get(row.id) ?? 0,
    joinedAt: row.since,
    city: city.get(row.id) ?? null,
  }));
}

export type ConvertVendorLeadResult =
  | {
      ok: true;
      intro: Extract<AddServiceVendorResult, { ok: true }>["intro"];
      /** False when the roster write landed but the lead could not be marked approved (it is still pending). */
      leadApproved: boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * Add a vendor lead to the service roster: the roster rules apply unchanged (`addServiceVendor`: one entry per phone, one
 * intro text as the service owner, a STOPped number is never texted). Only after the roster write succeeds is the lead marked
 * approved, so a failed add leaves the lead pending. The phone comes from the lead row, never from the request.
 *
 * The status write is reported, never discarded: the roster add cannot be retried (one entry per phone), so a lead left
 * pending has to be visible to the operator rather than looking like an ordinary success.
 */
export async function convertVendorLead(
  db: SupabaseClient,
  adminUserId: string,
  leadId: string,
  input: { name?: unknown; trades?: unknown; area?: unknown },
): Promise<ConvertVendorLeadResult> {
  const { data, error } = await db.from("sms_vendor_leads").select("id, phone_key, status").eq("id", leadId).maybeSingle();
  if (error) return { ok: false, status: 503, error: "Could not read the lead. Please retry." };
  const lead = data as { id?: unknown; phone_key?: unknown; status?: unknown } | null;
  if (!lead) return { ok: false, status: 404, error: "Not found." };
  if (lead.status !== "pending") return { ok: false, status: 409, error: "That lead was already handled." };
  const phone = normalizeE164(String(lead.phone_key ?? ""));
  if (!phone) return { ok: false, status: 400, error: "That lead has no usable phone number." };
  const added = await addServiceVendor(db, adminUserId, { name: input.name, phone, trades: input.trades, area: input.area });
  if (!added.ok) return { ok: false, status: added.status, error: added.error };
  const leadApproved = await setVendorLeadStatus(db, leadId, "approved");
  if (!leadApproved) console.error("[service-network] vendor added but the lead stayed pending", { leadId });
  return { ok: true, intro: added.intro, leadApproved };
}
