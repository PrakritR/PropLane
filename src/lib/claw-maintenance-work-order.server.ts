/**
 * Detect maintenance intent in resident SMS and create a PropLane work order.
 */

import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  inferMaintenanceCategoryLabel,
  inferMaintenancePriority,
  inferMaintenanceTitle,
  looksLikeMaintenanceRequest,
} from "@/lib/claw-maintenance-detect";
import { notifyManagerOfResidentFiledItem } from "@/lib/work-order-notification.server";
import { prepareDispatch } from "@/lib/work-order-dispatch.server";
import { workOrderCategoryForResidentLabel } from "@/lib/work-order-taxonomy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { residentPortalUrl } from "@/lib/claw-resident-links";

export {
  inferMaintenanceCategoryLabel,
  inferMaintenancePriority,
  inferMaintenanceTitle,
  looksLikeMaintenanceRequest,
} from "@/lib/claw-maintenance-detect";

const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

export type CreateWorkOrderFromResidentSmsResult =
  | {
      created: true;
      workOrderId: string;
      title: string;
      category: string;
      alreadyOpen?: false;
    }
  | {
      created: false;
      workOrderId: string;
      title: string;
      category: string;
      alreadyOpen: true;
    }
  | { created: false; error: string };

async function resolveResidentContext(
  db: SupabaseClient,
  args: { residentUserId?: string | null; residentEmail: string; managerUserId: string },
): Promise<{
  residentName: string;
  propertyId: string | null;
  propertyName: string;
  propertyAddress?: string;
  unit: string;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
}> {
  const email = args.residentEmail.trim().toLowerCase();
  let residentName = "Resident";
  if (args.residentUserId) {
    const { data: profile } = await db
      .from("profiles")
      .select("full_name")
      .eq("id", args.residentUserId)
      .maybeSingle();
    residentName = String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim() || residentName;
  }

  const { data: app } = await db
    .from("manager_application_records")
    .select("row_data, property_id")
    .eq("manager_user_id", args.managerUserId)
    .eq("resident_email", email)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const rowData = ((app as { row_data?: Record<string, unknown> } | null)?.row_data ?? {}) as Record<
    string,
    unknown
  >;
  const application = (rowData.application ?? {}) as Record<string, unknown>;
  const propertyId =
    String(rowData.assignedPropertyId ?? rowData.propertyId ?? application.propertyId ?? "").trim() ||
    String((app as { property_id?: unknown } | null)?.property_id ?? "").trim() ||
    null;
  const propertyName =
    String(rowData.property ?? "").trim() ||
    String(application.property ?? "").trim() ||
    "Assigned property";
  const unit =
    String(rowData.assignedRoomChoice ?? application.roomChoice1 ?? "").trim() || "—";
  const assignedPropertyId = String(rowData.assignedPropertyId ?? "").trim() || propertyId || undefined;
  const assignedRoomChoice = String(rowData.assignedRoomChoice ?? "").trim() || undefined;

  let propertyAddress: string | undefined;
  let resolvedName = propertyName;
  if (propertyId) {
    const { data: prop } = await db
      .from("manager_property_records")
      .select("property_data")
      .eq("id", propertyId)
      .maybeSingle();
    const pd = ((prop as { property_data?: Record<string, unknown> } | null)?.property_data ??
      {}) as Record<string, unknown>;
    propertyAddress = String(pd.address ?? "").trim() || undefined;
    resolvedName =
      String(pd.buildingName ?? pd.title ?? "").trim() ||
      propertyAddress?.split(",")[0]?.trim() ||
      propertyName;
  }

  if (residentName === "Resident" && String(rowData.name ?? "").trim()) {
    residentName = String(rowData.name).trim();
  }

  return {
    residentName,
    propertyId,
    propertyName: resolvedName,
    propertyAddress,
    unit,
    assignedPropertyId,
    assignedRoomChoice,
  };
}

/**
 * Create a portal work order from a resident SMS maintenance request.
 * Idempotent within a short window for near-duplicate texts.
 */
export async function createWorkOrderFromResidentSms(args: {
  managerUserId: string;
  residentPhone: string;
  residentUserId?: string | null;
  residentEmail: string;
  text: string;
  senderUserId?: string | null;
  /**
   * Skip the "does this text look like maintenance?" heuristic. Inbound SMS
   * must keep it (an arbitrary text must not silently open a work order), but
   * an authenticated resident who explicitly confirmed "file this repair" in
   * the portal or the assistant has already stated the intent — the heuristic
   * would only produce false negatives there.
   */
  skipIntentCheck?: boolean;
}): Promise<CreateWorkOrderFromResidentSmsResult> {
  const managerUserId = args.managerUserId.trim();
  const residentEmail = args.residentEmail.trim().toLowerCase();
  const text = args.text.trim();
  if (!managerUserId || !residentEmail || !text) {
    return { created: false, error: "missing_context" };
  }
  if (!args.skipIntentCheck && !looksLikeMaintenanceRequest(text)) {
    return { created: false, error: "not_maintenance" };
  }

  const db = createSupabaseServiceRoleClient();
  const categoryLabel = inferMaintenanceCategoryLabel(text);
  const category = workOrderCategoryForResidentLabel(categoryLabel);
  const title = inferMaintenanceTitle(text);
  const priority = inferMaintenancePriority(text);

  // Dedupe near-identical opens from the same resident.
  const cutoff = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { data: recent } = await db
    .from("portal_work_order_records")
    .select("id, row_data, updated_at")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", residentEmail)
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(8);

  for (const row of recent ?? []) {
    const rd = ((row as { row_data?: DemoManagerWorkOrderRow }).row_data ?? {}) as DemoManagerWorkOrderRow;
    if (rd.bucket && rd.bucket !== "open") continue;
    const prevDesc = String(rd.description ?? "").trim().toLowerCase();
    const prevTitle = String(rd.title ?? "").trim().toLowerCase();
    if (prevDesc === text.toLowerCase() || prevTitle === title.toLowerCase()) {
      return {
        created: false,
        alreadyOpen: true,
        workOrderId: String((row as { id?: string }).id ?? rd.id ?? ""),
        title: rd.title || title,
        category,
      };
    }
  }

  const ctx = await resolveResidentContext(db, {
    managerUserId,
    residentEmail,
    residentUserId: args.residentUserId,
  });

  const id = `REQ-SMS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const row: DemoManagerWorkOrderRow = {
    id,
    propertyName: ctx.propertyName,
    propertyId: ctx.propertyId ?? undefined,
    propertyAddress: ctx.propertyAddress,
    assignedPropertyId: ctx.assignedPropertyId,
    assignedRoomChoice: ctx.assignedRoomChoice,
    unit: ctx.unit,
    title,
    priority,
    status: "Submitted",
    bucket: "open",
    category,
    description: text,
    scheduled: "—",
    cost: "—",
    preferredArrival: "Anytime",
    entryPermission: "call_first",
    managerUserId,
    residentName: ctx.residentName,
    residentEmail,
  };

  const { error } = await db.from("portal_work_order_records").upsert(
    {
      id,
      manager_user_id: managerUserId,
      resident_email: residentEmail,
      property_id: ctx.propertyId,
      assigned_property_id: ctx.assignedPropertyId ?? ctx.propertyId,
      vendor_user_id: null,
      row_data: row,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { created: false, error: error.message };

  const senderUserId = args.senderUserId?.trim() || args.residentUserId?.trim() || "";
  if (senderUserId) {
    await notifyManagerOfResidentFiledItem(db, {
      kind: "work-order",
      senderUserId,
      senderEmail: residentEmail,
      senderName: ctx.residentName,
      managerUserId,
      propertyId: ctx.assignedPropertyId ?? ctx.propertyId ?? undefined,
      title,
      description: text,
      propertyLabel: ctx.propertyName,
    }).catch(() => undefined);
  }

  await prepareDispatch(db, id).catch(() => undefined);

  return { created: true, workOrderId: id, title, category };
}

export function maintenanceWorkOrderResidentAck(result: CreateWorkOrderFromResidentSmsResult): string | null {
  if ("error" in result && !("alreadyOpen" in result)) return null;
  if (!("workOrderId" in result) || !result.workOrderId) return null;
  const services = residentPortalUrl("services_work_orders");
  if ("alreadyOpen" in result && result.alreadyOpen) {
    return [
      `Looks like we already have that open ("${result.title}").`,
      `Your manager's on it — you can check here if you want: ${services}`,
    ].join("\n");
  }
  if (result.created) {
    return [
      `Got it, I put in a service for "${result.title}".`,
      `Your manager will follow up here.`,
    ].join("\n");
  }
  return null;
}
