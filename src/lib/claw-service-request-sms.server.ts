/**
 * Create a pending amenity / custom add-on service request from resident SMS.
 */

import type { ServiceRequest } from "@/lib/service-requests-storage";
import { CUSTOM_SERVICE_REQUEST_OFFER_ID } from "@/lib/service-requests-storage";
import { notifyManagerOfResidentFiledItem } from "@/lib/work-order-notification.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { residentPortalUrl } from "@/lib/claw-resident-links";

function inferOfferName(text: string): string {
  const t = text.toLowerCase();
  if (/\bparking\b/.test(t)) return "Parking request";
  if (/\bclean/.test(t)) return "Cleaning request";
  if (/\bstorage\b/.test(t)) return "Storage request";
  if (/\bpet\b/.test(t)) return "Pet-related request";
  const first = text.trim().replace(/\s+/g, " ").split(/[.!?\n]/)[0]?.trim() || "Custom request";
  return first.length > 72 ? `${first.slice(0, 69)}…` : first;
}

export type CreateServiceRequestFromSmsResult =
  | { created: true; requestId: string; title: string }
  | { created: false; requestId: string; title: string; alreadyOpen: true }
  | { created: false; error: string };

export async function createServiceRequestFromResidentSms(args: {
  managerUserId: string;
  residentEmail: string;
  residentUserId?: string | null;
  residentName?: string | null;
  text: string;
  propertyId?: string | null;
}): Promise<CreateServiceRequestFromSmsResult> {
  const managerUserId = args.managerUserId.trim();
  const residentEmail = args.residentEmail.trim().toLowerCase();
  const text = args.text.trim();
  if (!managerUserId || !residentEmail || !text) {
    return { created: false, error: "missing_context" };
  }

  const db = createSupabaseServiceRoleClient();
  const title = inferOfferName(text);
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from("portal_service_request_records")
    .select("id, row_data, updated_at")
    .eq("manager_user_id", managerUserId)
    .eq("resident_email", residentEmail)
    .gte("updated_at", cutoff)
    .order("updated_at", { ascending: false })
    .limit(5);

  for (const row of recent ?? []) {
    const rd = ((row as { row_data?: ServiceRequest }).row_data ?? {}) as ServiceRequest;
    if (rd.status && rd.status !== "pending") continue;
    if (String(rd.notes ?? "").trim().toLowerCase() === text.toLowerCase()) {
      return {
        created: false,
        alreadyOpen: true,
        requestId: String((row as { id?: string }).id ?? rd.id ?? ""),
        title: rd.offerName || title,
      };
    }
  }

  let propertyId = args.propertyId?.trim() || "";
  let residentName = args.residentName?.trim() || "Resident";
  if (!propertyId) {
    const { data: app } = await db
      .from("manager_application_records")
      .select("row_data, property_id, assigned_property_id")
      .eq("manager_user_id", managerUserId)
      .eq("resident_email", residentEmail)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rowData = ((app as { row_data?: Record<string, unknown> } | null)?.row_data ?? {}) as Record<
      string,
      unknown
    >;
    propertyId =
      String(rowData.assignedPropertyId ?? rowData.propertyId ?? "").trim() ||
      String((app as { assigned_property_id?: unknown } | null)?.assigned_property_id ?? "").trim() ||
      String((app as { property_id?: unknown } | null)?.property_id ?? "").trim();
    if (String(rowData.name ?? "").trim()) residentName = String(rowData.name).trim();
  }

  if (args.residentUserId && residentName === "Resident") {
    const { data: profile } = await db
      .from("profiles")
      .select("full_name")
      .eq("id", args.residentUserId)
      .maybeSingle();
    residentName = String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim() || residentName;
  }

  const id = `SR-SMS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const row: ServiceRequest = {
    id,
    offerId: CUSTOM_SERVICE_REQUEST_OFFER_ID,
    offerName: title,
    offerDescription: text,
    price: "",
    priceLimit: "",
    deposit: "",
    residentEmail,
    residentName,
    managerUserId,
    propertyId,
    returnByDate: "",
    notes: text,
    requestedAt: new Date().toISOString(),
    status: "pending",
    servicePaid: false,
    depositPaid: false,
  };

  const { error } = await db.from("portal_service_request_records").upsert(
    {
      id,
      manager_user_id: managerUserId,
      resident_email: residentEmail,
      property_id: propertyId || null,
      status: "pending",
      row_data: row,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { created: false, error: error.message };

  const senderUserId = args.residentUserId?.trim();
  if (senderUserId) {
    await notifyManagerOfResidentFiledItem(db, {
      kind: "service-request",
      senderUserId,
      senderEmail: residentEmail,
      senderName: residentName,
      managerUserId,
      propertyId: propertyId || undefined,
      title,
      description: text,
    }).catch(() => undefined);
  }

  return { created: true, requestId: id, title };
}

export function serviceRequestResidentAck(result: CreateServiceRequestFromSmsResult): string | null {
  if ("error" in result && !("alreadyOpen" in result)) return null;
  if (!("requestId" in result) || !result.requestId) return null;
  const track = residentPortalUrl("services");
  if ("alreadyOpen" in result && result.alreadyOpen) {
    return [
      `You already have one pending for "${result.title}".`,
      `Manager will confirm the price — details here if you need: ${track}`,
    ].join("\n");
  }
  if (result.created) {
    return [
      `Cool — put in a request for "${result.title}".`,
      `Your manager will confirm the price before anything is final.`,
    ].join("\n");
  }
  return null;
}
