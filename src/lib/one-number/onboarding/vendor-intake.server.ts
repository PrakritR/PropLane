import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { redactLeadBody } from "@/lib/one-number/lead-redact";
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import {
  applyVendorText,
  nextVendorStep,
  VENDOR_COPY,
  vendorQuestion,
  type VendorProfile,
} from "@/lib/one-number/onboarding/vendor-intake";

/**
 * A vendor texting PropLane for the first time (`sms_vendor_leads`). PropLane admin approves; nothing
 * here touches a workspace, a dispatch rule or a real vendor row. The reply is a fixed template.
 */
type Row = Record<string, unknown>;
type StoredProfile = VendorProfile & { lastSid?: string; lastReply?: string };

export type VendorLead = { id: string; phoneKey: string; status: "collecting" | "pending" | "approved" | "declined"; profile: StoredProfile; createdAt: string };

const COLUMNS = "id, phone_key, status, profile, created_at";

function toLead(row: Row): VendorLead {
  const status = ["collecting", "pending", "approved", "declined"].includes(String(row.status)) ? (String(row.status) as VendorLead["status"]) : "collecting";
  const profile = row.profile && typeof row.profile === "object" && !Array.isArray(row.profile) ? (row.profile as StoredProfile) : {};
  return { id: String(row.id ?? ""), phoneKey: String(row.phone_key ?? ""), status, profile, createdAt: String(row.created_at ?? "") };
}

async function findLiveLead(db: SupabaseClient, phoneKey: string): Promise<VendorLead | null> {
  const { data, error } = await db.from("sms_vendor_leads").select(COLUMNS).eq("phone_key", phoneKey).in("status", ["collecting", "pending"]).maybeSingle();
  if (error || !data) return null;
  return toLead(data as Row);
}

async function findOrCreateLead(db: SupabaseClient, phoneKey: string, seed: StoredProfile): Promise<{ lead: VendorLead; created: boolean } | null> {
  const existing = await findLiveLead(db, phoneKey);
  if (existing) return { lead: existing, created: false };
  const inserted = await db.from("sms_vendor_leads").insert({ phone_key: phoneKey, status: "collecting", profile: seed }).select(COLUMNS).maybeSingle();
  if (inserted.data) return { lead: toLead(inserted.data as Row), created: true };
  if (inserted.error?.code === "23505") {
    const again = await findLiveLead(db, phoneKey);
    return again ? { lead: again, created: false } : null;
  }
  if (inserted.error && !isMissingSchemaError(inserted.error)) console.error("vendor lead create failed", inserted.error.code ?? "unknown");
  return null;
}

export type VendorIntakeTurn = { leadId: string | null; reply: string | null };

export async function handleVendorIntake(
  db: SupabaseClient,
  input: { phoneKey: string; body: string; messageSid: string; firstReply: boolean },
  deps: { now?: () => Date; origin?: string } = {},
): Promise<VendorIntakeTurn> {
  try {
    const now = (deps.now ?? (() => new Date()))();
    const body = redactLeadBody(input.body);
    const found = await findOrCreateLead(db, input.phoneKey, {});
    if (!found) return { leadId: null, reply: null };
    const { lead } = found;
    // A webhook retry says exactly what it said the first time.
    if (input.messageSid && lead.profile.lastSid === input.messageSid && lead.profile.lastReply) return { leadId: lead.id, reply: lead.profile.lastReply };

    const welcome = input.firstReply || found.created ? `${VENDOR_COPY.welcome} ` : "";
    const finish = async (lead: VendorLead, lead_text: string): Promise<string> => {
      const minted = await mintSetupLink(db, { kind: "vendor", phoneKey: input.phoneKey, context: { source: "direct", vendorLeadId: lead.id }, origin: deps.origin, now });
      return minted.ok ? `${lead_text} ${minted.url}` : lead_text.replace(/ ?(Finish your profile here:|Your profile link:)$/, "");
    };

    let reply: string;
    let profile: StoredProfile = lead.profile;
    let status: VendorLead["status"] = lead.status;
    if (lead.status === "pending") {
      reply = await finish(lead, VENDOR_COPY.pending);
    } else {
      const applied = applyVendorText({ ...lead.profile }, body);
      profile = { ...applied.profile };
      const step = nextVendorStep(profile);
      if (!step) {
        status = "pending";
        profile.asked = null;
        reply = await finish(lead, VENDOR_COPY.done);
      } else {
        profile.asked = step;
        const retry = !applied.changed && !found.created && lead.profile.asked ? `${VENDOR_COPY.retry} ` : "";
        reply = `${welcome}${retry}${vendorQuestion(step)}`;
      }
    }
    reply = toGsm7(reply);
    await db
      .from("sms_vendor_leads")
      .update({ status, profile: { ...profile, lastSid: input.messageSid, lastReply: reply }, updated_at: now.toISOString() })
      .eq("id", lead.id);
    return { leadId: lead.id, reply };
  } catch (error) {
    console.error("vendor intake failed", error instanceof Error ? error.name : "unknown");
    return { leadId: null, reply: null };
  }
}

// ---------------------------------------------------------------------------
// The admin queue (platform only)
// ---------------------------------------------------------------------------

export type VendorLeadListItem = { id: string; phoneMasked: string; trade: string | null; area: string | null; rates: string | null; insurance: string | null; status: VendorLead["status"]; createdAt: string };

export async function listVendorLeads(db: SupabaseClient, opts: { status?: VendorLead["status"]; limit?: number } = {}): Promise<VendorLeadListItem[]> {
  const { data, error } = await db
    .from("sms_vendor_leads")
    .select(COLUMNS)
    .eq("status", opts.status ?? "pending")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 100));
  if (error) return [];
  return ((data ?? []) as Row[]).map((row) => {
    const lead = toLead(row);
    const digits = lead.phoneKey.replace(/\D/g, "");
    return {
      id: lead.id,
      phoneMasked: digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••",
      trade: lead.profile.trade ?? null,
      area: lead.profile.area ?? null,
      rates: lead.profile.rates ?? null,
      insurance: lead.profile.insurance ?? null,
      status: lead.status,
      createdAt: lead.createdAt,
    };
  });
}

export async function setVendorLeadStatus(db: SupabaseClient, id: string, status: "approved" | "declined"): Promise<boolean> {
  const { data, error } = await db
    .from("sms_vendor_leads")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  return !error && Boolean(data?.length);
}
