import "server-only";
import { createHmac, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/twilio";
import { resolveWorkOrderReference } from "@/lib/work-order-reference";
import { resolveVisibleWorkOrderReference } from "@/lib/tools/work-order-reference-resolution";
import { loadVendorDispatchSettings } from "@/lib/vendor-dispatch-settings";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { VendorAgentSessionRow } from "@/lib/agent/vendor-agent.server";
const columns = "id,landlord_id,kind,vendor_user_id,vendor_directory_id,work_order_id,vendor_phone_e164,status,inbox_thread_id";
function codeHash(code: string, directoryId: string) { const secret = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!secret) throw new Error("Verification unavailable."); return createHmac("sha256", secret).update(`${directoryId}:${code}`).digest("hex"); }
export type DirectoryResolution = { kind: "unknown_phone" } | { kind: "blocked"; reply: string; vendorUserId: string | null } | { kind: "session"; session: VendorAgentSessionRow; reference: null };
/** Recognition precedes leasing, session creation follows verified ownership and current job access. */
export async function resolveDirectoryVendorInbound(db: SupabaseClient, managerUserId: string, phone: string, text: string, workspaceId?: string | null): Promise<DirectoryResolution> {
  const { data: directory, error } = await db.from("manager_vendor_records").select("id,vendor_user_id,row_data").eq("manager_user_id", managerUserId);
  if (error) throw new Error("Vendor identity unavailable.");
  const linkedIds = (directory ?? []).map((d) => d.vendor_user_id).filter(Boolean);
  const { data: profiles, error: profileError } = linkedIds.length ? await db.from("profiles").select("id,phone,phone_verified_at").in("id", linkedIds) : { data: [], error: null };
  if (profileError) throw new Error("Vendor identity unavailable.");
  const matches = (directory ?? []).filter((d) => {
    const profile = (profiles ?? []).find((p) => p.id === d.vendor_user_id);
    return normalizeE164(profile?.phone || d.row_data?.phone || "") === phone;
  });
  if (!matches.length) return { kind: "unknown_phone" };
  if (matches.length !== 1) return { kind: "blocked", reply: "This phone matches more than one vendor contact. Ask your manager to correct the contact before continuing.", vendorUserId: null };
  const vendor = matches[0]!;
  const profile = (profiles ?? []).find((p) => p.id === vendor.vendor_user_id);
  const { data: binding, error: bindingError } = await db.from("vendor_coordination_phone_bindings").select("phone_e164,verified_at,revoked_at").eq("manager_user_id", managerUserId).eq("vendor_directory_id", vendor.id).maybeSingle();
  if (bindingError) throw new Error("Vendor verification unavailable.");
  let verified = Boolean(profile?.phone_verified_at && normalizeE164(profile.phone) === phone) || Boolean(binding?.verified_at && !binding.revoked_at && binding.phone_e164 === phone);
  if (profile?.phone_verified_at && normalizeE164(profile.phone) === phone && (!binding?.verified_at || binding.revoked_at || binding.phone_e164 !== phone)) {
    const { error: syncError } = await db.from("vendor_coordination_phone_bindings").upsert({ manager_user_id: managerUserId, vendor_directory_id: vendor.id, vendor_user_id: vendor.vendor_user_id, phone_e164: phone, verified_at: profile.phone_verified_at, revoked_at: null }, { onConflict: "manager_user_id,vendor_directory_id" });
    if (syncError) throw new Error("Phone binding unavailable.");
  }
  const code = /^VERIFY\s+(\d{6})$/i.exec(text.trim());
  if (!verified && code) {
    const { data: challenge } = await db.from("vendor_coordination_phone_challenges").select("id").eq("manager_user_id", managerUserId).eq("vendor_directory_id", vendor.id).eq("phone_e164", phone).is("consumed_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (challenge) { const result = await db.rpc("verify_vendor_coordination_phone_challenge", { p_challenge_id: challenge.id, p_code_hash: codeHash(code[1]!, vendor.id) }); if (result.error) throw new Error("Verification unavailable."); verified = result.data === true; }
    if (!verified) return { kind: "blocked", reply: "That verification code is invalid or expired. Ask for a new code.", vendorUserId: vendor.vendor_user_id };
  }
  if (!verified) {
    const { data: recent } = await db.from("vendor_coordination_phone_challenges").select("id").eq("manager_user_id", managerUserId).eq("vendor_directory_id", vendor.id).is("consumed_at", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle();
    if (recent) return { kind: "blocked", reply: "Reply VERIFY followed by the six-digit code already sent to verify your phone.", vendorUserId: vendor.vendor_user_id };
    const generated = String(randomInt(100000, 1000000));
    const result = await db.rpc("issue_vendor_coordination_phone_challenge", { p_manager_user_id: managerUserId, p_vendor_directory_id: vendor.id, p_phone_e164: phone, p_code_hash: codeHash(generated, vendor.id) });
    if (result.error) throw new Error("Verification unavailable.");
    return { kind: "blocked", reply: `Verify your phone before discussing a service. Reply VERIFY ${generated}. This code expires in 10 minutes.`, vendorUserId: vendor.vendor_user_id };
  }
  const settings = await loadVendorDispatchSettings(db, managerUserId);
  if (!settings.agentMessagingEnabled && !settings.quoteSourcingEnabled) return { kind: "blocked", reply: "Your manager has not enabled AI service coordination. Message your manager directly.", vendorUserId: vendor.vendor_user_id };
  const { data: works, error: worksError } = await db.from("portal_work_order_records").select("id,property_id,assigned_property_id,row_data").eq("manager_user_id", managerUserId);
  const { data: offers, error: offersError } = await db.from("work_order_vendor_offers").select("work_order_id,expires_at").eq("manager_user_id", managerUserId).eq("vendor_directory_id", vendor.id).eq("status", "sent");
  if (worksError || offersError) throw new Error("Vendor services unavailable.");
  let scopedWorks = works ?? [];
  const workspace = workspaceId?.trim();
  if (workspace && scopedWorks.length) {
    // Match the canonical work-order house precedence; a bound line cannot
    // create a fresh session for a job whose workspace cannot be established.
    const propertyFor = (w: typeof scopedWorks[number]) => String(w.assigned_property_id ?? w.property_id ?? w.row_data?.propertyId ?? "").trim();
    const propertyIds = [...new Set(scopedWorks.map(propertyFor).filter(Boolean))];
    const { data: properties, error: propertiesError } = propertyIds.length
      ? await db.from("manager_property_records").select("id,workspace_id").eq("manager_user_id", managerUserId).in("id", propertyIds)
      : { data: [], error: null };
    if (propertiesError) throw new Error("Vendor workspace unavailable.");
    const propertyWorkspaces = new Map((properties ?? []).map((p) => [String(p.id), String(p.workspace_id ?? "").trim()]));
    scopedWorks = scopedWorks.filter((w) => propertyWorkspaces.get(propertyFor(w)) === workspace);
  }
  const eligible = scopedWorks.filter((w) => !["completed", "cancelled"].includes(w.row_data?.bucket) && ((w.row_data?.vendorId === vendor.id && !w.row_data?.selfAssigned) || (offers ?? []).some((o) => o.work_order_id === w.id && o.expires_at && Date.parse(o.expires_at) > Date.now())));
  if (!eligible.length) return { kind: "blocked", reply: "There is no active service assigned or offered to you with this manager.", vendorUserId: vendor.vendor_user_id };
  let chosen = eligible.length === 1 ? eligible[0] : undefined;
  if (resolveWorkOrderReference(text).length) { const resolved = resolveVisibleWorkOrderReference(text, eligible.map((w) => ({ ...w.row_data, id: w.id } as DemoManagerWorkOrderRow))); chosen = resolved.kind === "resolved" ? eligible.find((w) => w.id === resolved.candidates[0]?.id) : undefined; }
  if (!chosen) return { kind: "blocked", reply: `Which service? Reply with its reference: ${eligible.map((w) => `${w.row_data?.reference || w.id} (${w.row_data?.title || "Service"})`).join(", ")}`, vendorUserId: vendor.vendor_user_id };
  const { data: session, error: sessionError } = await db.from("agent_sessions").upsert({ landlord_id: managerUserId, user_id: vendor.vendor_user_id, kind: "vendor_work_order", vendor_user_id: vendor.vendor_user_id, vendor_directory_id: vendor.id, work_order_id: chosen.id, vendor_phone_e164: phone, status: "active", updated_at: new Date().toISOString() }, { onConflict: "work_order_id,vendor_directory_id" }).select(columns).single();
  if (sessionError) throw new Error("Vendor conversation unavailable.");
  return { kind: "session", session: session as VendorAgentSessionRow, reference: null };
}
