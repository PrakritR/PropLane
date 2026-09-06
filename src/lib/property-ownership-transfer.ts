import "server-only";

import {
  normalizeCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  prunePropertyCoManagerPermissions,
  type CoManagerPermissions,
} from "@/lib/co-manager-permissions";
import {
  notifyDemotedToCoManager,
  notifyPromotedToMainManager,
} from "@/lib/co-manager-notification.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { asStringArray } from "@/lib/account-link-invite-row";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

function looksLikeMissingTable(err: { message?: string } | null | undefined): boolean {
  const m = (err?.message ?? "").toLowerCase();
  return m.includes("does not exist") || m.includes("schema cache") || (m.includes("relation") && m.includes("not"));
}

async function updateManagerUserIdForProperty(
  db: Db,
  table: string,
  propertyId: string,
  fromUserId: string,
  toUserId: string,
  propertyColumn = "property_id",
): Promise<void> {
  if (fromUserId === toUserId) return;
  const { error } = await db
    .from(table)
    .update({ manager_user_id: toUserId })
    .eq("manager_user_id", fromUserId)
    .eq(propertyColumn, propertyId);
  if (error && !looksLikeMissingTable(error)) throw new Error(error.message);
}

async function updateAssignedPropertyIdForProperty(
  db: Db,
  table: string,
  propertyId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  if (fromUserId === toUserId) return;
  const { error } = await db
    .from(table)
    .update({ manager_user_id: toUserId })
    .eq("manager_user_id", fromUserId)
    .eq("assigned_property_id", propertyId);
  if (error && !looksLikeMissingTable(error)) throw new Error(error.message);
}

function propertyLabelFromRow(row: { property_data?: unknown; row_data?: unknown; id?: string }): string {
  const pd = (row.property_data ?? row.row_data ?? {}) as Record<string, unknown>;
  const building = String(pd.buildingName ?? pd.title ?? "").trim();
  const unit = String(pd.unitLabel ?? "").trim();
  return [building, unit].filter(Boolean).join(" · ") || String(row.id ?? "Property");
}

export type TransferPropertyOwnershipInput = {
  propertyId: string;
  currentOwnerUserId: string;
  newManagerUserId: string;
  formerOwnerPermissions: CoManagerPermissions;
};

export type TransferPropertyOwnershipResult =
  | { ok: true; propertyLabel: string }
  | { ok: false; error: string; status: number };

export async function transferPropertyOwnership(
  db: Db,
  input: TransferPropertyOwnershipInput,
): Promise<TransferPropertyOwnershipResult> {
  const propertyId = input.propertyId.trim();
  const currentOwnerUserId = input.currentOwnerUserId.trim();
  const newManagerUserId = input.newManagerUserId.trim();
  const formerOwnerPermissions = normalizeCoManagerPermissions(input.formerOwnerPermissions);

  if (!propertyId || !currentOwnerUserId || !newManagerUserId) {
    return { ok: false, error: "Missing required fields.", status: 400 };
  }
  if (currentOwnerUserId === newManagerUserId) {
    return { ok: false, error: "Choose a different manager to transfer to.", status: 400 };
  }

  const { data: propertyRow, error: propertyErr } = await db
    .from("manager_property_records")
    .select("id, manager_user_id, property_data, row_data")
    .eq("id", propertyId)
    .maybeSingle();

  if (propertyErr) return { ok: false, error: propertyErr.message, status: 500 };
  if (!propertyRow?.id) return { ok: false, error: "Property not found.", status: 404 };
  if (propertyRow.manager_user_id !== currentOwnerUserId) {
    return { ok: false, error: "Only the main manager can transfer ownership.", status: 403 };
  }

  const { data: linkRow, error: linkErr } = await db
    .from("account_link_invites")
    .select("*")
    .eq("status", "accepted")
    .or(
      `and(inviter_user_id.eq.${currentOwnerUserId},invitee_user_id.eq.${newManagerUserId}),and(inviter_user_id.eq.${newManagerUserId},invitee_user_id.eq.${currentOwnerUserId})`,
    )
    .maybeSingle();

  if (linkErr && !looksLikeMissingTable(linkErr)) {
    return { ok: false, error: linkErr.message, status: 500 };
  }
  if (!linkRow?.id) {
    return { ok: false, error: "That manager must be a linked co-manager first.", status: 400 };
  }

  const assigned = asStringArray(linkRow.assigned_property_ids);
  if (!assigned.includes(propertyId)) {
    return { ok: false, error: "That co-manager is not assigned to this property.", status: 400 };
  }

  const propertyLabel = propertyLabelFromRow(propertyRow);

  const { error: ownerUpdateErr } = await db
    .from("manager_property_records")
    .update({ manager_user_id: newManagerUserId, updated_at: new Date().toISOString() })
    .eq("id", propertyId)
    .eq("manager_user_id", currentOwnerUserId);

  if (ownerUpdateErr) return { ok: false, error: ownerUpdateErr.message, status: 500 };

  const propertyTables = [
    "manager_application_records",
    "portal_lease_pipeline_records",
    "portal_household_charge_records",
    "portal_recurring_rent_profile_records",
    "portal_work_order_records",
    "portal_schedule_records",
    "screening_orders",
    "cosigner_submission_records",
    "ledger_entries",
    "manager_expense_entries",
    "portal_scheduled_inbox_message_records",
    "payment_automation_settings",
  ] as const;

  for (const table of propertyTables) {
    await updateManagerUserIdForProperty(db, table, propertyId, currentOwnerUserId, newManagerUserId);
  }

  await updateAssignedPropertyIdForProperty(
    db,
    "manager_application_records",
    propertyId,
    currentOwnerUserId,
    newManagerUserId,
  );
  await updateAssignedPropertyIdForProperty(
    db,
    "portal_work_order_records",
    propertyId,
    currentOwnerUserId,
    newManagerUserId,
  );

  const [{ data: ownerProfile }, { data: newManagerProfile }] = await Promise.all([
    db.from("profiles").select("manager_id, full_name, email").eq("id", currentOwnerUserId).maybeSingle(),
    db.from("profiles").select("manager_id, full_name, email").eq("id", newManagerUserId).maybeSingle(),
  ]);

  const ownerAxisId = String(ownerProfile?.manager_id ?? "").trim();
  const newManagerAxisId = String(newManagerProfile?.manager_id ?? "").trim();
  const ownerName =
    ownerProfile?.full_name?.trim() || ownerProfile?.email?.trim() || "Former manager";
  const newManagerName =
    newManagerProfile?.full_name?.trim() || newManagerProfile?.email?.trim() || "New manager";

  const formerOwnerPropertyPerms = normalizePropertyCoManagerPermissions(
    { [propertyId]: formerOwnerPermissions },
    [propertyId],
  );

  const existingPerms = normalizePropertyCoManagerPermissions(
    (linkRow as { property_co_manager_permissions?: unknown }).property_co_manager_permissions ??
      (linkRow as { co_manager_permissions?: unknown }).co_manager_permissions,
    assigned,
  );

  const newManagerAssigned = assigned.filter((id) => id !== propertyId);
  const formerOwnerAssigned = [...new Set([...assigned.filter((id) => id === propertyId), propertyId])];

  const newManagerPerms = prunePropertyCoManagerPermissions(
    Object.fromEntries(Object.entries(existingPerms).filter(([id]) => id !== propertyId)),
    newManagerAssigned.length > 0 ? newManagerAssigned : [],
  );

  const formerOwnerPerms = prunePropertyCoManagerPermissions(
    {
      ...Object.fromEntries(Object.entries(existingPerms).filter(([id]) => id === propertyId)),
      ...formerOwnerPropertyPerms,
    },
    [propertyId],
  );

  await db
    .from("account_link_invites")
    .update({
      status: "cancelled",
      responded_at: new Date().toISOString(),
    })
    .eq("id", linkRow.id);

  if (newManagerAssigned.length > 0) {
    await db.from("account_link_invites").insert({
      inviter_user_id: currentOwnerUserId,
      invitee_user_id: newManagerUserId,
      tab_kind: "manager",
      inviter_axis_id: ownerAxisId,
      invitee_axis_id: newManagerAxisId,
      inviter_display_name: ownerName,
      invitee_display_name: newManagerName,
      assigned_property_ids: newManagerAssigned,
      payout_percent_for_manager: Number(linkRow.payout_percent_for_manager ?? 15),
      property_co_manager_permissions: newManagerPerms,
      status: "accepted",
      responded_at: new Date().toISOString(),
    });
  }

  const { data: reverseLink } = await db
    .from("account_link_invites")
    .select("id, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, payout_percent_for_manager")
    .eq("status", "accepted")
    .eq("inviter_user_id", newManagerUserId)
    .eq("invitee_user_id", currentOwnerUserId)
    .maybeSingle();

  if (reverseLink?.id) {
    const reverseAssigned = [...new Set([...asStringArray(reverseLink.assigned_property_ids), propertyId])];
    const reversePerms = normalizePropertyCoManagerPermissions(
      (reverseLink as { property_co_manager_permissions?: unknown }).property_co_manager_permissions ??
        (reverseLink as { co_manager_permissions?: unknown }).co_manager_permissions,
      asStringArray(reverseLink.assigned_property_ids),
    );
    reversePerms[propertyId] = formerOwnerPerms[propertyId] ?? formerOwnerPermissions;
    await db
      .from("account_link_invites")
      .update({
        assigned_property_ids: reverseAssigned,
        property_co_manager_permissions: prunePropertyCoManagerPermissions(reversePerms, reverseAssigned),
        payout_percent_for_manager: Number(reverseLink.payout_percent_for_manager ?? 15),
      })
      .eq("id", reverseLink.id);
  } else {
    await db.from("account_link_invites").insert({
      inviter_user_id: newManagerUserId,
      invitee_user_id: currentOwnerUserId,
      tab_kind: "manager",
      inviter_axis_id: newManagerAxisId,
      invitee_axis_id: ownerAxisId,
      inviter_display_name: newManagerName,
      invitee_display_name: ownerName,
      assigned_property_ids: [propertyId],
      payout_percent_for_manager: Number(linkRow.payout_percent_for_manager ?? 15),
      property_co_manager_permissions: formerOwnerPerms,
      status: "accepted",
      responded_at: new Date().toISOString(),
    });
  }

  void notifyPromotedToMainManager({
    newManagerUserId,
    formerOwnerUserId: currentOwnerUserId,
    formerOwnerName: ownerName,
    propertyLabel,
  });
  void notifyDemotedToCoManager({
    formerOwnerUserId: currentOwnerUserId,
    newManagerUserId,
    newManagerName,
    propertyLabel,
  });

  return { ok: true, propertyLabel };
}
