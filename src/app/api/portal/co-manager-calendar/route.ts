import { NextResponse } from "next/server";
import { managerHasCalendarAccessForProperty } from "@/lib/auth/manager-lease-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { expectedManagerScheduleRecordIds } from "@/lib/portal-schedule-record-scope";
import {
  resolveAuthenticatedBusinessAccess,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";
import { coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import { readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";

export const runtime = "nodejs";

type ScheduleRecordRow = {
  id: string | null;
  manager_user_id: string | null;
  property_id: string | null;
  record_type: string | null;
  row_data: unknown;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value.trim() : "";
}

function payloadFromRowData(rowData: unknown): unknown {
  const row = asObject(rowData);
  if (!row) return null;
  return row.payload ?? row;
}

function readShareAvailability(rowData: unknown): boolean {
  const payload = payloadFromRowData(rowData);
  const obj = asObject(payload);
  return obj?.shareAvailability === true;
}

function readAvailabilitySlots(rowData: unknown): string[] {
  const payload = payloadFromRowData(rowData);
  if (Array.isArray(payload)) return payload.filter((item): item is string => typeof item === "string");
  return [];
}

function scheduleRecordOwnedByPeer(record: ScheduleRecordRow | undefined, peerId: string): boolean {
  if (!record) return false;
  const ownerId = String(record.manager_user_id ?? "").trim();
  return !ownerId || ownerId === peerId;
}

export async function GET(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim();
    if (!propertyId) return NextResponse.json({ error: "propertyId required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const businessAccess = await resolveAuthenticatedBusinessAccess(user.id, db);
    if (businessAccess.kind === "denied") {
      return NextResponse.json({ error: "Calendar access is unavailable for this account." }, { status: 403 });
    }

    const peers = new Map<string, { label: string; isSelf: boolean }>();

    let propertyQuery = db
      .from("manager_property_records")
      .select("manager_user_id, property_data, test_workspace_id")
      .eq("id", propertyId);
    propertyQuery = businessAccess.kind === "test"
      ? propertyQuery.eq("test_workspace_id", businessAccess.workspaceId)
      : propertyQuery.is("test_workspace_id", null);
    const { data: propertyRow, error: propertyError } = await propertyQuery.maybeSingle();
    if (propertyError) return NextResponse.json({ error: propertyError.message }, { status: 500 });
    if (!propertyRow) {
      return NextResponse.json({ error: "You do not have calendar access to this property." }, { status: 403 });
    }

    const ownerId = String(propertyRow?.manager_user_id ?? "").trim();
    if (ownerId) {
      peers.set(ownerId, {
        label: ownerId === user.id ? "You" : "Primary manager",
        isSelf: ownerId === user.id,
      });
    }

    let linkQuery = db
      .from("account_link_invites")
      .select(
        "inviter_user_id, invitee_user_id, inviter_axis_id, invitee_axis_id, inviter_display_name, invitee_display_name, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, house_scope, team_role, status, test_workspace_id",
      )
      .eq("status", "accepted")
      .or(`inviter_user_id.eq.${user.id},invitee_user_id.eq.${user.id}`);
    linkQuery = businessAccess.kind === "test"
      ? linkQuery.eq("test_workspace_id", businessAccess.workspaceId)
      : linkQuery.is("test_workspace_id", null);
    const { data: linkRows, error: linkError } = await linkQuery;

    if (linkError && !String(linkError.message ?? "").toLowerCase().includes("account_link_invites")) {
      return NextResponse.json({ error: linkError.message }, { status: 500 });
    }

    for (const raw of linkRows ?? []) {
      const row = raw as Record<string, unknown>;
      const assigned = Array.isArray(row.assigned_property_ids)
        ? row.assigned_property_ids.filter((item): item is string => typeof item === "string")
        : [];
      if (!assigned.includes(propertyId)) continue;
      const inviterId = textField(row, "inviter_user_id");
      const inviteeId = textField(row, "invitee_user_id");
      const actorIsOwner = ownerId === user.id;
      const actorIsGrantedInvitee = inviteeId === user.id && inviterId === ownerId;
      if (!actorIsOwner && !actorIsGrantedInvitee) continue;
      const permissions = readPropertyPermissionsFromRow({
        assigned_property_ids: assigned,
        property_co_manager_permissions: row.property_co_manager_permissions,
        co_manager_permissions: row.co_manager_permissions,
        house_scope: row.house_scope as string | null | undefined,
        team_role: row.team_role as string | null | undefined,
      });
      if (!actorIsOwner && !coManagerModuleAllowed(permissions, propertyId, "calendar", "read")) continue;

      if (inviterId) {
        peers.set(inviterId, {
          label: inviterId === user.id ? "You" : textField(row, "inviter_display_name") || textField(row, "inviter_axis_id") || inviterId,
          isSelf: inviterId === user.id,
        });
      }
      if (inviteeId) {
        peers.set(inviteeId, {
          label: inviteeId === user.id ? "You" : textField(row, "invitee_display_name") || textField(row, "invitee_axis_id") || inviteeId,
          isSelf: inviteeId === user.id,
        });
      }
    }

    const hasAccess = businessAccess.kind === "test"
      ? ownerId === user.id || peers.has(user.id)
      : await managerHasCalendarAccessForProperty(db, user.id, propertyId);
    if (!hasAccess) {
      return NextResponse.json({ error: "You do not have calendar access to this property." }, { status: 403 });
    }

    if (!peers.has(user.id)) {
      return NextResponse.json({ error: "You do not have calendar access to this property." }, { status: 403 });
    }

    const peerIds: string[] = [];
    for (const peerId of peers.keys()) {
      const classification = await resolveTestWorkspaceClassification(peerId, db);
      const compatible = businessAccess.kind === "test"
        ? classification.kind === "classified" && classification.workspaceId === businessAccess.workspaceId && classification.state === "active"
        : classification.kind === "normal";
      if (compatible) peerIds.push(peerId);
    }
    if (!peerIds.includes(user.id)) {
      return NextResponse.json({ error: "You do not have calendar access to this property." }, { status: 403 });
    }
    const recordIds = peerIds.flatMap((peerId) => {
      const { shareKey, availKey } = expectedManagerScheduleRecordIds(peerId, propertyId);
      return [shareKey, availKey];
    });

    let scheduleQuery = db
      .from("portal_schedule_records")
      .select("id, manager_user_id, property_id, record_type, row_data, test_workspace_id")
      .in("id", recordIds.length > 0 ? recordIds : ["__none__"]);
    scheduleQuery = businessAccess.kind === "test"
      ? scheduleQuery.eq("test_workspace_id", businessAccess.workspaceId)
      : scheduleQuery.is("test_workspace_id", null);
    const { data: scheduleRows, error: scheduleError } = await scheduleQuery;

    if (scheduleError) return NextResponse.json({ error: scheduleError.message }, { status: 500 });

    const recordsById = new Map<string, ScheduleRecordRow>();
    for (const row of (scheduleRows ?? []) as ScheduleRecordRow[]) {
      if (row.id) recordsById.set(row.id, row);
    }

    const result = peerIds.map((peerId) => {
      const meta = peers.get(peerId)!;
      const { shareKey, availKey } = expectedManagerScheduleRecordIds(peerId, propertyId);
      const shareRecord = recordsById.get(shareKey);
      const availRecord = recordsById.get(availKey);
      const sharesAvailability =
        scheduleRecordOwnedByPeer(shareRecord, peerId) &&
        readShareAvailability(shareRecord?.row_data ?? null);

      let slots: string[] = [];
      if (meta.isSelf || sharesAvailability) {
        if (scheduleRecordOwnedByPeer(availRecord, peerId)) {
          slots = readAvailabilitySlots(availRecord?.row_data ?? null);
        }
      }

      return {
        userId: peerId,
        label: meta.label,
        isSelf: meta.isSelf,
        sharesAvailability,
        slots,
      };
    });

    return NextResponse.json({ peers: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load co-manager calendar.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
