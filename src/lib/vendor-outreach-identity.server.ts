import "server-only";
import type { SenderPolicyReadContext } from "@/lib/one-number/sender-policy-read.server";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VendorQuoteSenderIdentity } from "@/lib/vendor-quote-contract";
import { resolveWorkspaceWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveWorkspaceSenderTransport } from "@/lib/sms/workspace-send-readiness.server";

export type VendorOutreachMode = "software" | "managed";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolve the current, persisted sender. Missing configuration always means software. */
export async function resolveVendorOutreachIdentity(
  db: SupabaseClient,
  managerUserId: string,
  workOrderId?: string,
  channel: "email" | "sms" = "email",
  context?: SenderPolicyReadContext,
): Promise<VendorQuoteSenderIdentity | null> {
  const [{ data: modeRow, error: modeError }, { data: profile, error: profileError }] = await Promise.all([
    db.from("vendor_outreach_workspace_profiles")
      .select("mode,version,managed_display_name,managed_legal_name,managed_email,managed_work_phone,managed_messaging_service_sid")
      .eq("manager_user_id", managerUserId)
      .maybeSingle(),
    db.from("profiles").select("id,full_name").eq("id", managerUserId).maybeSingle(),
  ]);
  if (context && (modeError || profileError)) throw new Error("Sender legal identity unreadable.");
  if (modeError || profileError || !profile || !workOrderId) return null;

  const { data: work, error: workError } = await db.from("portal_work_order_records")
    .select("assigned_property_id,property_id,row_data,manager_user_id").eq("id", workOrderId).maybeSingle();
  if (context && workError) throw new Error("Sender service ownership unreadable.");
  const propertyId = [work?.assigned_property_id, work?.property_id, work?.row_data?.propertyId].find((value) => typeof value === "string" && value.trim())?.trim();
  if (workError || !work || work.manager_user_id !== managerUserId || !propertyId) return null;
  const { data: property, error: propertyError } = await db.from("manager_property_records")
    .select("workspace_id,manager_user_id").eq("id", propertyId).maybeSingle();
  if (context && propertyError) throw new Error("Sender property ownership unreadable.");
  if (propertyError || !property || property.manager_user_id !== managerUserId || !property.workspace_id) return null;
  const workspaceId = String(property.workspace_id);
  if (context) context.workspaceId = workspaceId;
  const [email, transport] = await Promise.all([
    resolveWorkspaceWorkEmail(db, managerUserId, workspaceId, context),
    resolveWorkspaceSenderTransport({ db, ownerUserId: managerUserId, workspaceId, requiredCents: 0, policyRead: context,
      now: context ? new Date(context.nowMs) : undefined }),
  ]);
  if (context && !transport.canSend && transport.reason === "control_plane_unreadable") throw new Error("Sender transport authority unreadable.");
  const line = transport.canSend ? transport.numberRow : null;
  const transportIdentity = {
    transportKind: transport.canSend ? (transport.viaSharedLine ? "shared" : line?.manager_user_id !== managerUserId ? "service_number" : "workspace_number") : null,
    selectedLineId: transport.canSend && !transport.viaSharedLine ? line?.id ?? null : null,
    providerMessagingServiceSid: transport.canSend ? transport.providerMessagingServiceSid ?? transport.messagingServiceSid : null,
  } as const;
  const emailAddress = String(email?.address ?? "").trim().toLowerCase();
  const emailIsReady = Boolean(emailAddress && EMAIL.test(emailAddress) && email?.workspaceId === workspaceId);
  if (channel === "email" && !emailIsReady) return null;
  const lineIsActive = Boolean(transport.canSend && line?.phone_number && line.messaging_service_sid);

  const mode = modeRow?.mode === "managed" ? "managed" : "software";
  if (mode === "managed") {
    const email = String(modeRow?.managed_email ?? "").trim().toLowerCase();
    if (!emailIsReady || !email || !modeRow?.managed_display_name || !modeRow?.managed_legal_name || !lineIsActive ||
      email !== emailAddress ||
      String(modeRow?.managed_work_phone ?? "") !== String(line?.phone_number) ||
      String(modeRow?.managed_messaging_service_sid ?? "") !== String(line?.messaging_service_sid)) return null;
    return {
      mode,
      managerUserId,
      displayName: String(modeRow.managed_display_name).trim(),
      legalName: String(modeRow.managed_legal_name).trim(),
      email: emailAddress,
      workPhone: String(line?.phone_number),
      messagingServiceSid: String(line?.messaging_service_sid),
      version: Number(modeRow.version) || 1,
      workspaceId,
      ...transportIdentity,
    };
  }

  return {
    mode,
    managerUserId,
    displayName: String(profile.full_name ?? "").trim() || "Property manager",
    legalName: String(profile.full_name ?? "").trim() || "Property manager",
    email: emailIsReady ? emailAddress : "",
    workPhone: lineIsActive ? String(line?.phone_number) : null,
    messagingServiceSid: lineIsActive ? String(line?.messaging_service_sid) : null,
    version: Number(modeRow?.version) || 1,
    workspaceId,
    ...transportIdentity,
  };
}

/** The RPC re-derives staff authority from profile_roles and audits the assignment. */
export async function assignVendorOutreachMode(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    mode: VendorOutreachMode;
    staffActorUserId: string;
    managed?: { displayName: string; legalName: string; email: string; workPhone: string; messagingServiceSid: string };
  },
): Promise<{ mode: VendorOutreachMode; version: number }> {
  const managed = input.managed;
  const { data, error } = await db.rpc("assign_vendor_outreach_mode", {
    p_manager_user_id: input.managerUserId,
    p_mode: input.mode,
    p_admin_user_id: input.staffActorUserId,
    p_display_name: managed?.displayName ?? null,
    p_legal_name: managed?.legalName ?? null,
    p_email: managed?.email ?? null,
    p_work_phone: managed?.workPhone ?? null,
    p_messaging_service_sid: managed?.messagingServiceSid ?? null,
  });
  if (error || !data) throw new Error("Vendor sender assignment could not be saved.");
  const row = Array.isArray(data) ? data[0] : data;
  return { mode: input.mode, version: Number((row as { version?: unknown }).version) || 1 };
}

/** Canonical sender binding shared by capabilities and provider authorization. */
export const vendorQuoteSenderKey = (sender: VendorQuoteSenderIdentity) => createHash("sha256").update([
  sender.managerUserId, sender.workspaceId, sender.mode, sender.version, sender.email.trim().toLowerCase(),
  sender.displayName, sender.legalName, sender.workPhone ?? "", sender.messagingServiceSid ?? "",
  sender.transportKind ?? "", sender.selectedLineId ?? "", sender.providerMessagingServiceSid ?? "",
].join("|")).digest("hex");

/** Exact identity disclosed by a page grant. Legacy non-page SMS uses its own line scope. */
export function vendorQuoteSenderMatches(current: VendorQuoteSenderIdentity | null, snapshot: VendorQuoteSenderIdentity | null | undefined): boolean {
  return Boolean(current && snapshot && current.managerUserId === snapshot.managerUserId &&
    current.workspaceId === snapshot.workspaceId && current.mode === snapshot.mode && current.version === snapshot.version &&
    current.email.trim().toLowerCase() === snapshot.email?.trim().toLowerCase() &&
    current.displayName === snapshot.displayName && current.legalName === snapshot.legalName &&
    current.workPhone === snapshot.workPhone && current.messagingServiceSid === snapshot.messagingServiceSid &&
    (current.transportKind ?? null) === (snapshot.transportKind ?? null) &&
    (current.selectedLineId ?? null) === (snapshot.selectedLineId ?? null) &&
    (current.providerMessagingServiceSid ?? null) === (snapshot.providerMessagingServiceSid ?? null));
}
