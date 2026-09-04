import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import {
  buildLeadInviteLinkUrl,
  leadInviteAppOrigin,
  leadInviteEmailConfigured,
  sendLeadInvite,
  type LeadInviteKind,
} from "@/lib/lead-invite.server";
import { getShareablePropertyForUser } from "@/lib/manager-property-share-access";
import { assertManagerPropertyListingQuota } from "@/lib/manager-property-quota.server";
import { acceptedPaymentMethodsForListing } from "@/lib/payment-policy";
import { leaseTemplateObjectPath, legacyLeaseTemplateObjectPath } from "@/lib/lease-template-storage";
import { copyListingMediaBetweenSubmissions } from "@/lib/listing-media-copy";
import {
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  draftFieldsFromLeaseSource,
  propertyLeaseSourceLabel,
  resolvePropertyLeaseSource,
  type PropertyLeaseSource,
} from "@/lib/property-lease-source";
import {
  readPropertyLeaseTemplates,
  syncLegacyLeaseFieldsFromTemplates,
  updatePropertyLeaseTemplate,
  type PropertyLeaseTemplateKind,
} from "@/lib/property-lease-templates";
import {
  applyPropertyLeaseTemplateSectionEdit,
  findPropertyLeaseTemplate,
  propertyLeaseTemplateSectionIsEditable,
  readPropertyLeaseTemplateSections,
  resolvePropertyLeaseTemplateHtml,
} from "@/lib/property-lease-template-html";
import { sectionSourceFromHtml } from "@/lib/lease-section-text";
import { smsAccessAllowsPropertyRecord, smsDataOwnerIds } from "@/lib/sms/manager-sms-access";

/**
 * Property records vary in shape by lifecycle status: `property_data` holds the
 * published listing for live/review rows, `row_data` holds the submission for
 * everything else. We read both and project a small, safe set of display fields
 * defensively, so the tool works regardless of which stage a property is in.
 */
type RawPropertyRecord = {
  id: string;
  status: string | null;
  row_data: unknown;
  property_data: unknown;
  manager_user_id?: string | null;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(obj: Record<string, unknown> | null, key: string): number | null {
  const v = obj?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function summarizeProperty(rec: RawPropertyRecord) {
  // Prefer the published listing payload, fall back to the raw submission.
  const src = asObject(rec.property_data) ?? asObject(rec.row_data);
  return {
    id: rec.id,
    status: rec.status || null,
    title: str(src, "title") ?? str(src, "buildingName") ?? str(src, "name"),
    address: str(src, "address"),
    neighborhood: str(src, "neighborhood"),
    unit: str(src, "unitLabel"),
    beds: num(src, "beds"),
    baths: num(src, "baths"),
    rent: str(src, "rentLabel"),
    available: str(src, "available"),
  };
}

export const listPropertiesTool = defineTool({
  name: "list_properties",
  description:
    "List the current landlord's own properties/listings with title, address, unit, beds/baths, rent, and lifecycle status (pending, live, review, request_change, unlisted, rejected). Use to answer 'what properties do I manage', 'which listings are live', etc.",
  kind: "read",
  inputSchema: z
    .object({
      status: z
        .string()
        .optional()
        .describe("Optional case-insensitive filter on property status, e.g. 'live' or 'pending'."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const ownerIds = smsDataOwnerIds(ctx);
    const byId = new Map<string, RawPropertyRecord>();
    for (const ownerId of ownerIds) {
      const { data, error } = await ctx.db
        .from("manager_property_records")
        .select("id, status, row_data, property_data, manager_user_id")
        .eq("manager_user_id", ownerId)
        .limit(1000);
      if (error) throw new Error(error.message);
      for (const rec of (data ?? []) as (RawPropertyRecord & { manager_user_id?: string | null })[]) {
        if (!smsAccessAllowsPropertyRecord(ctx, rec)) continue;
        byId.set(rec.id, rec);
      }
    }
    const wantStatus = input.status?.trim().toLowerCase();
    const properties = [...byId.values()]
      .filter((r) => !wantStatus || String(r.status ?? "").toLowerCase() === wantStatus)
      .map(summarizeProperty);
    return { count: properties.length, properties };
  },
});

/** Server-side single-record read, scoped to owned or assigned SMS-accessible properties. */
async function loadOwnedPropertyRecord(ctx: AgentContext, propertyId: string): Promise<RawPropertyRecord | null> {
  const id = propertyId.trim();
  if (!id) return null;
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, status, row_data, property_data, manager_user_id")
    .eq("id", id)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (((data ?? []) as RawPropertyRecord[])[0] as RawPropertyRecord | undefined) ?? null;
  if (!rec) return null;
  if (!smsAccessAllowsPropertyRecord(ctx, rec)) return null;
  return rec;
}

/** The full listing submission for a record (published payload first, then draft). */
function listingSubmissionOf(rec: RawPropertyRecord): Record<string, unknown> | null {
  return (
    asObject(asObject(rec.property_data)?.listingSubmission) ?? asObject(asObject(rec.row_data)?.submission)
  );
}

/**
 * Safe room projection for the listing detail read. Photo/video data URLs,
 * move-in instructions with access codes, and per-room free text are
 * deliberately dropped.
 */
function summarizeRooms(sub: Record<string, unknown> | null) {
  const rooms = Array.isArray(sub?.rooms) ? (sub!.rooms as unknown[]) : [];
  return rooms
    .map((r) => asObject(r))
    .filter((r): r is Record<string, unknown> => r !== null)
    .map((r) => ({
      name: str(r, "name"),
      rent: num(r, "monthlyRent"),
      availability: str(r, "availability"),
      moveInAvailableDate: str(r, "moveInAvailableDate"),
    }));
}

export const getPropertyDetailsTool = defineTool({
  name: "get_property_details",
  description:
    "Get one of the current landlord's properties in detail: title, address, zip, neighborhood, beds/baths, rent, lifecycle status, per-room name/rent/availability/move-in date, and which resident payment methods the listing accepts. Pass a property id from list_properties. Photos and payment contact details (Zelle/Venmo handles) are never returned.",
  kind: "read",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("The property id, from list_properties."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) return { found: false, message: "No property with that id belongs to this landlord." };
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const sub = listingSubmissionOf(rec);
    return {
      found: true,
      property: {
        id: rec.id,
        status: rec.status || null,
        title: str(src, "title") ?? str(src, "buildingName") ?? str(src, "name"),
        address: str(src, "address"),
        zip: str(src, "zip"),
        neighborhood: str(src, "neighborhood"),
        unit: str(src, "unitLabel"),
        beds: num(src, "beds"),
        baths: num(src, "baths"),
        rentLabel: str(src, "rentLabel") ?? (num(src, "monthlyRent") != null ? `$${num(src, "monthlyRent")}/mo` : null),
        petFriendly: src?.petFriendly === true,
        rooms: summarizeRooms(sub),
        acceptedPaymentMethods: sub
          ? acceptedPaymentMethodsForListing(sub as { acceptedPaymentMethods?: ("zelle" | "venmo" | "ach" | "card")[] })
          : null,
      },
    };
  },
});

export type DraftPropertyFields = {
  title: string;
  address: string;
  zip?: string;
  neighborhood?: string;
  beds: number;
  baths: number;
  rentUsd: number;
  description?: string;
  unitLabel?: string;
  petFriendly?: boolean;
};

/**
 * Build the `row_data` payload for a new draft (status "pending") property
 * record, matching the ManagerPendingPropertyRow shape the manager UI submits
 * (see submitManagerPendingProperty in src/lib/demo-property-pipeline.ts).
 * Exported so the create-listing-from-photos flow reuses the exact same draft
 * shape rather than inventing a second one.
 */
export function buildDraftPropertyRowData(fields: DraftPropertyFields, submittedByUserId: string) {
  return {
    id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    submittedAt: new Date().toISOString(),
    submittedByUserId,
    buildingName: fields.title.trim(),
    address: fields.address.trim(),
    zip: fields.zip?.trim() ?? "",
    neighborhood: fields.neighborhood?.trim() ?? "",
    unitLabel: fields.unitLabel?.trim() || "New listing",
    beds: Math.max(0, Math.round(fields.beds)),
    baths: Math.max(0, fields.baths),
    monthlyRent: Math.max(0, Math.round(fields.rentUsd)),
    petFriendly: fields.petFriendly === true,
    tagline: fields.description?.trim() || "Manager-submitted listing",
  };
}

export const createPropertyTool = defineWriteTool({
  name: "create_property",
  description:
    "Create a minimal property stub from basic facts only (no photos or rich marketing copy). Prefer create_listing_draft for the chat-guided full listing flow. Saves status 'pending' for admin review.",
  inputSchema: z
    .object({
      title: z.string().min(1).describe("Listing title / building name."),
      address: z.string().min(1).describe("Street address of the property."),
      zip: z.string().optional().describe("ZIP code."),
      neighborhood: z.string().optional().describe("Neighborhood label shown on the listing."),
      beds: z.number().int().min(0).describe("Number of bedrooms."),
      baths: z.number().min(0).describe("Number of bathrooms."),
      rentUsd: z.number().positive().describe("Monthly rent in US dollars."),
      description: z.string().optional().describe("Short listing description / tagline."),
      unitLabel: z.string().optional().describe("Unit label, e.g. 'Unit B' or '3 rooms'."),
      petFriendly: z.boolean().optional().describe("Whether pets are allowed."),
    })
    .strict(),
  preview: async (_ctx, input) => {
    const lines = [
      { label: "Title", value: input.title.trim() },
      { label: "Address", value: input.address.trim() },
      ...(input.zip?.trim() ? [{ label: "ZIP", value: input.zip.trim() }] : []),
      ...(input.neighborhood?.trim() ? [{ label: "Neighborhood", value: input.neighborhood.trim() }] : []),
      { label: "Beds / Baths", value: `${input.beds} bd / ${input.baths} ba` },
      { label: "Monthly rent", value: `$${Math.round(input.rentUsd)}/mo` },
      ...(input.unitLabel?.trim() ? [{ label: "Unit", value: input.unitLabel.trim() }] : []),
      ...(input.petFriendly !== undefined ? [{ label: "Pet friendly", value: input.petFriendly ? "Yes" : "No" }] : []),
      { label: "After creation", value: "Draft (pending) — an Axis admin reviews it before it can go live" },
    ];
    return {
      kind: "create_property",
      title: "Create draft listing",
      summary: `Create a draft listing "${input.title.trim()}" at ${input.address.trim()} ($${Math.round(input.rentUsd)}/mo). It goes to admin review before publishing.`,
      fields: lines,
      confirmLabel: "Create draft",
    };
  },
  handler: async (ctx, input) => {
    const rowData = buildDraftPropertyRowData(input, ctx.landlordId);
    const normalizedAddress = input.address.trim().toLowerCase().replace(/\s+/g, " ");

    // This insert saves status "pending", which IS a listing slot
    // (LISTING_SLOT_PROPERTY_STATUSES), and it never passes through
    // `POST /api/property-records`, where the cap lives — so without this gate a
    // manager at their plan limit could ask the assistant for the listing the
    // portal's own "+ Add property" refuses. A create has no stored row, so it
    // always charges a slot (`existingStatus: null`). The owner is resolved from
    // the authenticated context, never from model-supplied input. Checked BEFORE
    // the audit log so a refusal does not burn the dedupe key for a listing that
    // was never created.
    const quota = await assertManagerPropertyListingQuota(ctx.db, {
      ownerUserId: ctx.landlordId,
      recordId: rowData.id,
      nextStatus: "pending",
      existingStatus: null,
    });
    // The refusal carries `managerPropertyLimitMessage`, so the manager reads
    // the same sentence here as in the portal.
    if (!quota.ok) throw new Error(quota.error);

    // Record intent first, idempotent per address per day: asking twice in one
    // day must not create two draft records for the same property.
    const dedupeKey = `create_property:${ctx.landlordId}:${normalizedAddress}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "create_property",
      toolName: "create_property",
      inputSummary: { propertyId: rowData.id, beds: rowData.beds, baths: rowData.baths, rentUsd: rowData.monthlyRent },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "A draft listing for this address was already created today — nothing new was added." };
      }
      throw new Error("Could not record the action; no listing was created.");
    }

    const { error } = await ctx.db.from("manager_property_records").insert({
      id: rowData.id,
      manager_user_id: ctx.landlordId,
      status: "pending",
      row_data: rowData,
      property_data: null,
      updated_at: new Date().toISOString(),
    });
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "insert_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { propertyId: rowData.id, status: "pending" });
    return { reply: `Created draft listing "${rowData.buildingName}" at ${rowData.address} ($${rowData.monthlyRent}/mo). It's pending admin review before it can go live.`, resultSummary: { propertyId: rowData.id, status: "pending" } };
  },
});

type UpdatePropertyInput = {
  propertyId: string;
  rentUsd?: number;
  beds?: number;
  baths?: number;
  description?: string;
  status?: "live" | "unlisted";
};

/**
 * Status transitions the manager may make directly: live ↔ unlisted only.
 * Everything else (pending/review/request_change/rejected → live) goes through
 * Axis admin review. Returns an error string, or null when the change is valid.
 */
function validatePropertyStatusChange(rec: RawPropertyRecord, target: "live" | "unlisted"): string | null {
  const current = String(rec.status ?? "").toLowerCase();
  if (target === current) return `This property is already ${target}.`;
  if (target === "live") {
    if (current !== "unlisted") {
      return "Only an unlisted listing can be set back to live here. New or edited listings must go through Axis admin review before publishing — their status stays pending/review until an admin approves them.";
    }
    if (!asObject(rec.property_data)) {
      return "This unlisted listing has no published payload on record, so it can't be relisted from here — relist it from the Properties page (it may need admin review).";
    }
  }
  if (target === "unlisted" && current !== "live") {
    return "Only a live listing can be unlisted.";
  }
  return null;
}

/** Tiny stable hash of the update patch for the idempotency key. */
function patchHash(input: UpdatePropertyInput): string {
  const stable = JSON.stringify([
    input.rentUsd ?? null,
    input.beds ?? null,
    input.baths ?? null,
    input.description ?? null,
    input.status ?? null,
  ]);
  let h = 5381;
  for (let i = 0; i < stable.length; i++) h = ((h << 5) + h + stable.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function hasFieldPatch(input: UpdatePropertyInput): boolean {
  return (
    input.rentUsd !== undefined ||
    input.beds !== undefined ||
    input.baths !== undefined ||
    input.description !== undefined
  );
}

function formatRentLabel(rentUsd: number): string {
  return `$${Math.round(rentUsd).toLocaleString("en-US")}/mo`;
}

/**
 * Minimal AdminPropertyRow payload synthesized from the live listing so an
 * unlisted record still renders on the manager's Unlisted tab (mirrors
 * mockToAdminRow in src/lib/demo-admin-property-inventory.ts). Keeps the
 * submission so the listing can be relisted with its content intact.
 */
function adminRowFromLiveProperty(recordId: string, prop: Record<string, unknown>, managerUserId: string) {
  const rentLabel = str(prop, "rentLabel") ?? "";
  const rentMatch = rentLabel.match(/[\d,]+(?:\.\d+)?/);
  return {
    adminRefId: recordId,
    buildingName: str(prop, "buildingName") ?? str(prop, "title") ?? "",
    unitLabel: str(prop, "unitLabel") ?? "",
    address: str(prop, "address") ?? "",
    zip: str(prop, "zip") ?? "",
    neighborhood: str(prop, "neighborhood") ?? "",
    beds: num(prop, "beds") ?? 0,
    baths: num(prop, "baths") ?? 0,
    monthlyRent: rentMatch ? Number(rentMatch[0].replace(/,/g, "")) : 0,
    petFriendly: prop.petFriendly === true,
    tagline: str(prop, "tagline") ?? "",
    listingId: str(prop, "id") ?? recordId,
    managerUserId,
    submission: asObject(prop.listingSubmission) ?? undefined,
  };
}

export const updatePropertyTool = defineWriteTool({
  name: "update_property",
  description:
    "Update one of the current landlord's properties: monthly rent, beds, baths, description, or toggle a listing between live and unlisted. Pass a property id from list_properties. Cannot publish a pending/in-review listing — that requires Axis admin review.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("The property id, from list_properties."),
      rentUsd: z.number().positive().optional().describe("New monthly rent in US dollars."),
      beds: z.number().int().min(0).optional().describe("New bedroom count."),
      baths: z.number().min(0).optional().describe("New bathroom count."),
      description: z.string().optional().describe("New listing description / tagline."),
      status: z
        .enum(["live", "unlisted"])
        .optional()
        .describe("Toggle a live listing to unlisted or an unlisted one back to live."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) {
      throw new Error("No property with that id belongs to this landlord. Use list_properties to get valid ids.");
    }
    if (!hasFieldPatch(input) && !input.status) {
      throw new Error("Nothing to update — pass at least one of rentUsd, beds, baths, description, or status.");
    }
    if (input.status) {
      const statusError = validatePropertyStatusChange(rec, input.status);
      if (statusError) throw new Error(statusError);
    }

    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "title") ?? str(src, "buildingName") ?? rec.id;
    const oldRent = str(src, "rentLabel") ?? (num(src, "monthlyRent") != null ? `$${num(src, "monthlyRent")}/mo` : "—");
    const lines: { label: string; value: string }[] = [{ label: "Property", value: title }];
    if (input.rentUsd !== undefined) lines.push({ label: "Monthly rent", value: `${oldRent} → ${formatRentLabel(input.rentUsd)}` });
    if (input.beds !== undefined) lines.push({ label: "Beds", value: `${num(src, "beds") ?? "—"} → ${input.beds}` });
    if (input.baths !== undefined) lines.push({ label: "Baths", value: `${num(src, "baths") ?? "—"} → ${input.baths}` });
    if (input.description !== undefined) {
      lines.push({ label: "Description", value: `${str(src, "tagline") ?? "—"} → ${input.description.trim() || "—"}` });
    }
    if (input.status) lines.push({ label: "Status", value: `${String(rec.status ?? "—")} → ${input.status}` });

    return {
      kind: "update_property",
      title: "Update property",
      summary: `Update ${title}${input.status ? ` (set ${input.status})` : ""}.`,
      fields: lines,
      confirmLabel: "Apply update",
      ...(input.status === "unlisted"
        ? { warnings: ["Unlisting removes this property from the public rental site until you relist it."] }
        : {}),
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve at execute time: the record and its status may have changed
    // since preview, and ownership is never trusted from stored input.
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No property with that id belongs to this landlord.");
    if (!hasFieldPatch(input) && !input.status) throw new Error("Nothing to update.");
    if (input.status) {
      const statusError = validatePropertyStatusChange(rec, input.status);
      if (statusError) throw new Error(statusError);
    }

    // Setting a record live takes it back into a plan listing slot, exactly like
    // publishing a new one — and this write never passes through
    // `POST /api/property-records`, where the cap lives. Without this gate a
    // manager at their limit could ask the assistant for the relist the portal's
    // own button refuses. Checked BEFORE the audit log so a refusal does not
    // burn the dedupe key for an update that never happened.
    if (input.status) {
      const quota = await assertManagerPropertyListingQuota(ctx.db, {
        ownerUserId: ctx.landlordId,
        recordId: rec.id,
        nextStatus: input.status,
        existingStatus: rec.status,
      });
      // The refusal carries `managerPropertyLimitMessage`, so the manager reads
      // the same sentence here as in the portal.
      if (!quota.ok) throw new Error(quota.error);
    }

    const changedFields = (["rentUsd", "beds", "baths", "description", "status"] as const).filter(
      (k) => input[k] !== undefined,
    );
    const dedupeKey = `update_property:${ctx.landlordId}:${rec.id}:${patchHash(input)}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_property",
      toolName: "update_property",
      inputSummary: { propertyId: rec.id, fields: changedFields, status: input.status ?? null },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That exact update was already applied to this property." };
      throw new Error("Could not record the action; nothing was updated.");
    }

    // Read-merge-write BOTH payloads: `property_data` drives the published
    // listing, `row_data` drives the draft/unlisted views — patch whichever is
    // present, never construct either from scratch.
    const rowData = asObject(rec.row_data);
    const propertyData = asObject(rec.property_data);
    let nextRow = rowData ? { ...rowData } : null;
    const nextProp = propertyData ? { ...propertyData } : null;

    if (nextRow) {
      if (input.rentUsd !== undefined) {
        nextRow.monthlyRent = Math.max(0, Math.round(input.rentUsd));
        // The formatted range label (derived from room rents) would go stale;
        // dropping it makes the UI fall back to the plain monthlyRent price.
        delete nextRow.rentRangeLabel;
      }
      if (input.beds !== undefined) nextRow.beds = input.beds;
      if (input.baths !== undefined) nextRow.baths = input.baths;
      if (input.description !== undefined) nextRow.tagline = input.description.trim();
    }
    if (nextProp) {
      if (input.rentUsd !== undefined) nextProp.rentLabel = formatRentLabel(input.rentUsd);
      if (input.beds !== undefined) nextProp.beds = input.beds;
      if (input.baths !== undefined) nextProp.baths = input.baths;
      if (input.description !== undefined) nextProp.tagline = input.description.trim();
    }

    let nextStatus = rec.status;
    if (input.status === "unlisted" && nextProp) {
      nextStatus = "unlisted";
      // The Unlisted tab renders row_data in the AdminPropertyRow shape — the
      // same conversion the client-side unlist flow does via mockToAdminRow.
      nextRow = adminRowFromLiveProperty(rec.id, nextProp, ctx.landlordId);
    } else if (input.status === "live" && nextProp) {
      nextStatus = "live";
      nextProp.adminPublishLive = true;
    }

    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        status: nextStatus,
        row_data: nextRow,
        property_data: nextProp,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { propertyId: rec.id, fields: changedFields, status: nextStatus });
    const src = nextProp ?? nextRow;
    const title = str(src, "title") ?? str(src, "buildingName") ?? rec.id;
    const parts: string[] = [];
    if (input.rentUsd !== undefined) parts.push(`rent to ${formatRentLabel(input.rentUsd)}`);
    if (input.beds !== undefined) parts.push(`beds to ${input.beds}`);
    if (input.baths !== undefined) parts.push(`baths to ${input.baths}`);
    if (input.description !== undefined) parts.push("the description");
    if (input.status) parts.push(`status to ${input.status}`);
    return { reply: `Updated ${title}: ${parts.join(", ")}.`, resultSummary: { propertyId: rec.id, fields: changedFields, status: nextStatus } };
  },
});

/**
 * A submission room matched by NAME, the only handle a manager (or the model)
 * has in conversation — room ids are internal. Case- and space-insensitive so
 * "room 2" finds "Room 2"; an exact match wins over a loose one so two rooms
 * whose names differ only in case cannot silently swap.
 */
function findSubmissionRoomByName(
  submission: ManagerListingSubmissionV1,
  roomName: string,
): { room: ManagerListingSubmissionV1["rooms"][number]; index: number } | null {
  const wanted = roomName.trim();
  if (!wanted) return null;
  const exact = submission.rooms.findIndex((room) => room.name.trim() === wanted);
  const index =
    exact >= 0
      ? exact
      : submission.rooms.findIndex(
          (room) => room.name.trim().toLowerCase().replace(/\s+/g, " ") === wanted.toLowerCase().replace(/\s+/g, " "),
        );
  if (index < 0) return null;
  return { room: submission.rooms[index]!, index };
}

function listingSubmissionFromRecord(rec: RawPropertyRecord): ManagerListingSubmissionV1 | null {
  const raw = listingSubmissionOf(rec);
  if (!raw) return null;
  return normalizeManagerListingSubmissionV1(raw as ManagerListingSubmissionV1);
}

function writeSubmissionToRecordPayloads(
  rec: RawPropertyRecord,
  submission: ManagerListingSubmissionV1,
): { row_data: unknown; property_data: unknown } {
  const normalized = normalizeManagerListingSubmissionV1(submission);
  const rowData = asObject(rec.row_data);
  const propertyData = asObject(rec.property_data);
  const nextRow: Record<string, unknown> | null = rowData ? { ...rowData } : null;
  const nextProp: Record<string, unknown> | null = propertyData ? { ...propertyData } : null;
  if (nextRow) {
    if (asObject(nextRow.submission) || "submission" in nextRow) {
      nextRow.submission = normalized;
    }
  }
  if (nextProp) {
    nextProp.listingSubmission = normalized;
  }
  return { row_data: nextRow ?? rec.row_data, property_data: nextProp ?? rec.property_data };
}

/**
 * Per-room rent, which `update_property` deliberately cannot touch — it writes
 * the LISTING-level monthly rent, and a by-room listing prices each bedroom
 * separately inside its submission. The assistant used to answer "I can't set
 * per-room rent from here" and send the manager to the Properties tab (AXI-148);
 * per AGENTS.md the answer to a missing capability is a tool, not a workaround.
 */
export const updateRoomRentTool = defineWriteTool({
  name: "update_room_rent",
  description:
    "Set the monthly rent for ONE room on a by-room listing (e.g. \"change Room 2 to $700\"). Use update_property for the listing-level rent instead. Pass a property id from list_properties and the room's name as it appears on the listing.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("The property id, from list_properties."),
      roomName: z.string().min(1).describe("The room's name on the listing, e.g. \"Room 2\"."),
      rentUsd: z.number().positive().describe("New monthly rent for that room, in US dollars."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) {
      throw new Error("No property with that id belongs to this landlord. Use list_properties to get valid ids.");
    }
    const submission = listingSubmissionFromRecord(rec);
    if (!submission) throw new Error("That property has no listing details to edit yet.");
    const match = findSubmissionRoomByName(submission, input.roomName);
    if (!match) {
      const names = submission.rooms.map((r) => r.name).filter(Boolean);
      throw new Error(
        names.length > 0
          ? `That listing has no room named "${input.roomName}". Its rooms are: ${names.join(", ")}.`
          : "That listing has no rooms, so there is no per-room rent to set. Use update_property for the listing rent.",
      );
    }
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "title") ?? str(src, "buildingName") ?? rec.id;
    const previous = match.room.monthlyRent > 0 ? formatRentLabel(match.room.monthlyRent) : "not set";
    return {
      kind: "update_room_rent",
      title: "Update room rent",
      summary: `Set ${match.room.name} at ${title} to ${formatRentLabel(input.rentUsd)}.`,
      fields: [
        { label: "Property", value: title },
        { label: "Room", value: match.room.name },
        { label: "Monthly rent", value: `${previous} → ${formatRentLabel(input.rentUsd)}` },
      ],
      confirmLabel: "Update rent",
    };
  },
  handler: async (ctx, input) => {
    // Re-resolve everything at execute time — the listing may have changed since
    // the preview, and ownership is never trusted from stored input.
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No property with that id belongs to this landlord.");
    const submission = listingSubmissionFromRecord(rec);
    if (!submission) throw new Error("That property has no listing details to edit yet.");
    const match = findSubmissionRoomByName(submission, input.roomName);
    if (!match) throw new Error(`That listing no longer has a room named "${input.roomName}".`);

    const nextRent = Math.max(0, Math.round(input.rentUsd));
    const dedupeKey = `update_room_rent:${ctx.landlordId}:${rec.id}:${match.room.id}:${nextRent}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_room_rent",
      toolName: "update_room_rent",
      inputSummary: { propertyId: rec.id, roomId: match.room.id, rentUsd: nextRent },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That room rent was already set to this amount." };
      throw new Error("Could not record the action; nothing was updated.");
    }

    const nextSubmission = {
      ...submission,
      rooms: submission.rooms.map((room, index) =>
        index === match.index ? { ...room, monthlyRent: nextRent } : room,
      ),
    };
    const payloads = writeSubmissionToRecordPayloads(rec, nextSubmission);
    // The listing's own rent LABEL is derived from the room rents, so a stale
    // range would keep advertising the old price. Dropping it makes the UI
    // recompute rather than show a number no room charges any more.
    const nextRow = asObject(payloads.row_data);
    if (nextRow && "rentRangeLabel" in nextRow) delete nextRow.rentRangeLabel;

    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        row_data: nextRow ?? payloads.row_data,
        property_data: payloads.property_data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { propertyId: rec.id, roomId: match.room.id, rentUsd: nextRent });
    return {
      reply: `Updated ${match.room.name} to ${formatRentLabel(nextRent)}.`,
      resultSummary: { propertyId: rec.id, roomId: match.room.id, rentUsd: nextRent },
    };
  },
});

export const copyListingPhotosTool = defineWriteTool({
  name: "copy_listing_photos",
  description:
    "Copy uploaded listing photos and videos from one of the landlord's properties to another (house gallery, room photos, bathroom and shared-space photos, floor plans, and house video). Both listings must belong to this landlord. Use list_properties to resolve ids by address or title. Does not change rent, text, or publish status.",
  inputSchema: z
    .object({
      sourcePropertyId: z.string().min(1).describe("Property id to copy media from (list_properties)."),
      targetPropertyId: z.string().min(1).describe("Property id to copy media onto (list_properties)."),
    })
    .strict(),
  preview: async (ctx, input) => {
    if (input.sourcePropertyId.trim() === input.targetPropertyId.trim()) {
      throw new Error("sourcePropertyId and targetPropertyId must be different properties.");
    }
    const [sourceRec, targetRec] = await Promise.all([
      loadOwnedPropertyRecord(ctx, input.sourcePropertyId),
      loadOwnedPropertyRecord(ctx, input.targetPropertyId),
    ]);
    if (!sourceRec) throw new Error("Source property not found for this landlord.");
    if (!targetRec) throw new Error("Target property not found for this landlord.");
    const sourceSub = listingSubmissionFromRecord(sourceRec);
    const targetSub = listingSubmissionFromRecord(targetRec);
    if (!sourceSub) throw new Error("The source property has no listing media on file.");
    if (!targetSub) throw new Error("The target property has no listing submission to update.");

    const { summary } = copyListingMediaBetweenSubmissions(sourceSub, targetSub);
    const srcLabel =
      str(asObject(sourceRec.property_data) ?? asObject(sourceRec.row_data), "buildingName") ??
      str(asObject(sourceRec.property_data) ?? asObject(sourceRec.row_data), "address") ??
      sourceRec.id;
    const tgtLabel =
      str(asObject(targetRec.property_data) ?? asObject(targetRec.row_data), "buildingName") ??
      str(asObject(targetRec.property_data) ?? asObject(targetRec.row_data), "address") ??
      targetRec.id;

    return {
      kind: "copy_listing_photos",
      title: "Copy listing photos",
      summary: `Copy photos from ${srcLabel} onto ${tgtLabel}.`,
      fields: [
        { label: "From", value: srcLabel },
        { label: "To", value: tgtLabel },
        { label: "House photos", value: String(summary.housePhotos) },
        { label: "Rooms updated", value: String(summary.roomsUpdated) },
        { label: "Bathrooms updated", value: String(summary.bathroomsUpdated) },
        { label: "Shared spaces updated", value: String(summary.sharedSpacesUpdated) },
      ],
      confirmLabel: "Copy photos",
      warnings: ["This overwrites the target listing's current photos and videos with the source listing's media."],
    };
  },
  handler: async (ctx, input) => {
    if (input.sourcePropertyId.trim() === input.targetPropertyId.trim()) {
      throw new Error("sourcePropertyId and targetPropertyId must be different properties.");
    }
    const [sourceRec, targetRec] = await Promise.all([
      loadOwnedPropertyRecord(ctx, input.sourcePropertyId),
      loadOwnedPropertyRecord(ctx, input.targetPropertyId),
    ]);
    if (!sourceRec || !targetRec) throw new Error("One or both properties were not found.");

    const sourceSub = listingSubmissionFromRecord(sourceRec);
    const targetSub = listingSubmissionFromRecord(targetRec);
    if (!sourceSub || !targetSub) throw new Error("Could not load listing submissions for both properties.");

    const dedupeKey = `copy_listing_photos:${ctx.landlordId}:${sourceRec.id}:${targetRec.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "copy_listing_photos",
      toolName: "copy_listing_photos",
      inputSummary: { sourcePropertyId: sourceRec.id, targetPropertyId: targetRec.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those listing photos were already copied by this action." };
      throw new Error("Could not record the action; photos were not copied.");
    }

    const { submission, summary } = copyListingMediaBetweenSubmissions(sourceSub, targetSub);
    const payloads = writeSubmissionToRecordPayloads(targetRec, submission);
    // No plan-quota gate: this patches only `row_data` / `property_data` and
    // never writes `status`, so it cannot move a record into a listing slot.
    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        row_data: payloads.row_data,
        property_data: payloads.property_data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", targetRec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { error: "update_failed" }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { targetPropertyId: targetRec.id, summary });
    const tgtLabel =
      str(asObject(targetRec.property_data) ?? asObject(targetRec.row_data), "buildingName") ??
      str(asObject(targetRec.property_data) ?? asObject(targetRec.row_data), "address") ??
      targetRec.id;
    return {
      reply: `Copied listing media onto ${tgtLabel} (${summary.housePhotos} house photo${summary.housePhotos === 1 ? "" : "s"}, ${summary.roomsUpdated} room${summary.roomsUpdated === 1 ? "" : "s"}, ${summary.bathroomsUpdated} bath${summary.bathroomsUpdated === 1 ? "" : "s"}, ${summary.sharedSpacesUpdated} shared space${summary.sharedSpacesUpdated === 1 ? "" : "s"}).`,
      resultSummary: { targetPropertyId: targetRec.id, ...summary },
    };
  },
});

// Domain is matched as dot-separated labels (no char class overlaps the "." delimiter)
// so there is exactly one way to parse a match — avoids polynomial backtracking on
// attacker-controlled input.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

const SHARE_KIND_LABELS: Record<LeadInviteKind, string> = {
  apply: "Application invite",
  tour: "Tour-scheduling invite",
  listing: "Listing details (with apply + tour links)",
};

export const sharePropertyLinkTool = defineWriteTool({
  name: "share_property_link",
  description:
    "Email a prospect an apply link, tour-scheduling link, or full listing details for one of the landlord's LIVE listings. Pass a property id from list_properties (status 'live') and the prospect's email. Only live listings the landlord owns (or co-manages) can be shared.",
  inputSchema: z
    .object({
      kind: z
        .enum(["apply", "tour", "listing"])
        .describe("What to send: an application link, a tour-scheduling link, or the listing details."),
      propertyId: z.string().min(1).describe("The live property id, from list_properties."),
      toEmail: z.string().min(3).describe("The prospect's email address."),
      prospectName: z.string().optional().describe("Optional prospect name used in the email greeting."),
      note: z.string().optional().describe("Optional short note from the manager included in the email."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const toEmail = input.toEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(toEmail)) {
      throw new Error("A valid recipient email is required.");
    }
    // Server-side share authorization against the live Supabase record — the
    // model-supplied propertyId proves nothing.
    const property = await getShareablePropertyForUser(ctx.landlordId, input.propertyId);
    if (!property) {
      throw new Error("This property can't be shared by you — only live listings you own (or co-manage) are shareable. Use list_properties with status 'live' to find one.");
    }
    const title = (property.title || property.buildingName || property.address || input.propertyId).trim();
    const linkUrl = buildLeadInviteLinkUrl(leadInviteAppOrigin(), input.kind, input.propertyId);
    const emailConfigured = leadInviteEmailConfigured();
    return {
      confirmedInput: { ...input, toEmail },
      kind: "share_property_link",
      title: "Share property link",
      summary: `Email ${toEmail} ${input.kind === "listing" ? "the listing details" : `a ${input.kind} link`} for ${title}.`,
      fields: [
          { label: "Property", value: title },
          { label: "Send to", value: input.prospectName?.trim() ? `${input.prospectName.trim()} <${toEmail}>` : toEmail },
          { label: "Invite", value: SHARE_KIND_LABELS[input.kind] },
          { label: "Link", value: linkUrl },
          {
            label: "Email delivery",
            value: emailConfigured
              ? "Configured — the invite will be emailed"
              : "NOT configured on this deployment — you'll get the link to send yourself",
          },
        ],
      confirmLabel: "Send invite",
    };
  },
  handler: async (ctx, input) => {
    const toEmail = input.toEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(toEmail)) throw new Error("A valid recipient email is required.");
    // Re-verify sharability at execute time (listing may have been unlisted
    // since preview; ownership is never trusted from stored input).
    const property = await getShareablePropertyForUser(ctx.landlordId, input.propertyId);
    if (!property) throw new Error("This property is no longer shareable by you.");
    const title = (property.title || property.buildingName || property.address || input.propertyId).trim();

    // Record intent first, idempotent per prospect/property/kind per day.
    const dedupeKey = `share_property_link:${ctx.landlordId}:${input.propertyId}:${toEmail}:${input.kind}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "share_property_link",
      toolName: "share_property_link",
      inputSummary: { propertyId: input.propertyId, kind: input.kind },
      resultSummary: { toEmail },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `A ${input.kind} invite for ${title} was already sent to ${toEmail} today.` };
      }
      throw new Error("Could not record the action; no invite was sent.");
    }

    const result = await sendLeadInvite(ctx.db, { userId: ctx.landlordId }, {
      kind: input.kind,
      to: toEmail,
      prospectName: input.prospectName?.trim() || undefined,
      propertyId: input.propertyId,
      note: input.note?.trim() || undefined,
      origin: leadInviteAppOrigin(),
    });

    if (result.ok) {
      await updateAuditResult(ctx, dedupeKey, { toEmail, delivery: "emailed" });
      return { reply: `Emailed the ${input.kind} invite for ${title} to ${toEmail}. Link: ${result.linkUrl}`, resultSummary: { delivery: "emailed", propertyId: input.propertyId } };
    }
    if (result.status === 503) {
      // Honest fallback: nothing was emailed, but the link itself is valid —
      // hand it to the manager to send manually.
      await updateAuditResult(ctx, dedupeKey, { toEmail, delivery: "link_only" });
      return { reply: `Email isn't configured on this deployment, so nothing was emailed. Share this ${input.kind} link with ${toEmail} yourself: ${result.linkUrl}`, resultSummary: { delivery: "link_only", propertyId: input.propertyId } };
    }
    await updateAuditResult(ctx, dedupeKey, { toEmail, delivery: "failed" }, { clearDedupeKey: true });
    throw new Error(`The invite email could not be sent: ${result.error}`);
  },
});

const LEASE_SOURCE_INPUT = z.enum(["axis_default", "custom_comments", "custom_format"]);

function leaseSourceInputLabel(source: z.infer<typeof LEASE_SOURCE_INPUT>): string {
  if (source === "axis_default") return propertyLeaseSourceLabel("axis_default");
  if (source === "custom_format") return propertyLeaseSourceLabel("custom_format");
  return propertyLeaseSourceLabel("custom_comments");
}

function validateLeaseConfigInput(input: {
  leaseSource: z.infer<typeof LEASE_SOURCE_INPUT>;
  customLeaseTerms?: string;
  leaseTemplateDocUrl?: string;
}): string | null {
  if (input.leaseSource === "custom_comments") {
    return input.customLeaseTerms?.trim()
      ? null
      : "customLeaseTerms is required when leaseSource is custom_comments.";
  }
  if (input.leaseSource === "custom_format") {
    const url = input.leaseTemplateDocUrl?.trim();
    if (!url) {
      return "leaseTemplateDocUrl is required when leaseSource is custom_format (upload a PDF in chat or use the modal).";
    }
    // Only a template already in storage is accepted: the private bucket, or a
    // legacy `listing-photos` object from before the split, which a property may
    // still legitimately carry and re-apply. The model can otherwise be steered
    // by prompt-injected applicant text into proposing a third-party URL or a
    // base64 `data:` PDF behind a benign label, substituting the document
    // residents sign — and the preview shows the file NAME, so the human at the
    // confirm gate would never see it.
    return leaseTemplateObjectPath(url) || legacyLeaseTemplateObjectPath(url)
      ? null
      : "leaseTemplateDocUrl must be a lease template already uploaded through the Lease modal.";
  }
  return null;
}

function applyLeaseConfigToSubmission(
  sub: ManagerListingSubmissionV1,
  input: {
    leaseSource: z.infer<typeof LEASE_SOURCE_INPUT>;
    customLeaseTerms?: string;
    leaseTemplateDocUrl?: string;
    leaseTemplateDocName?: string;
  },
): ManagerListingSubmissionV1 {
  const source: PropertyLeaseSource =
    input.leaseSource === "axis_default"
      ? "axis_default"
      : input.leaseSource === "custom_format"
        ? "custom_format"
        : "custom_comments";
  const modeFields = draftFieldsFromLeaseSource(source);
  return normalizeManagerListingSubmissionV1({
    ...sub,
    ...modeFields,
    customLeaseTerms: source === "custom_comments" ? (input.customLeaseTerms?.trim() ?? "") : "",
    leaseTemplateDocUrl: source === "custom_format" ? (input.leaseTemplateDocUrl?.trim() ?? null) : null,
    leaseTemplateDocName:
      source === "custom_format" ? (input.leaseTemplateDocName?.trim() ?? "Lease template.pdf") : "",
  });
}

export const updatePropertyLeaseConfigTool = defineWriteTool({
  name: "update_property_lease_config",
  description:
    "Update per-property lease document settings for a listing: PropLane standard lease (axis_default), custom manager terms addendum (custom_comments + customLeaseTerms), or a manager-uploaded PDF template (custom_format + leaseTemplateDocUrl). Use in the Lease modal when propertyId is in context, or after list_properties resolves the id. Does not create or sign resident lease packets — those live on the Leases page.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1).describe("Property id from list_properties or the Lease modal context."),
      leaseSource: LEASE_SOURCE_INPUT.describe(
        "axis_default = PropLane-generated lease; custom_comments = addendum text; custom_format = uploaded PDF template.",
      ),
      customLeaseTerms: z
        .string()
        .optional()
        .describe("Required when leaseSource is custom_comments — clauses to append to the generated lease."),
      leaseTemplateDocUrl: z
        .string()
        .optional()
        .describe("Required when leaseSource is custom_format — URL or data URL of the PDF template."),
      leaseTemplateDocName: z.string().optional().describe("Optional display name for the PDF template."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const validationError = validateLeaseConfigInput(input);
    if (validationError) throw new Error(validationError);
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) {
      throw new Error("No property with that id belongs to this landlord. Use list_properties to get valid ids.");
    }
    const existingSub = listingSubmissionFromRecord(rec);
    if (!existingSub) {
      throw new Error("This property has no listing submission to update — open it in Properties first.");
    }
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "title") ?? str(src, "buildingName") ?? rec.id;
    const current = resolvePropertyLeaseSource(existingSub as ManagerListingSubmissionV1);
    const nextLabel = leaseSourceInputLabel(input.leaseSource);
    const lines = [
      { label: "Property", value: title },
      { label: "Lease source", value: `${propertyLeaseSourceLabel(current)} → ${nextLabel}` },
    ];
    if (input.leaseSource === "custom_comments" && input.customLeaseTerms?.trim()) {
      lines.push({
        label: "Custom terms",
        value: input.customLeaseTerms.trim().slice(0, 200) + (input.customLeaseTerms.length > 200 ? "…" : ""),
      });
    }
    if (input.leaseSource === "custom_format") {
      lines.push({ label: "PDF template", value: input.leaseTemplateDocName?.trim() || "Uploaded template" });
      // The document itself, not just its label — a name is manager-supplied
      // text and cannot tell the approver which file they are about to attach.
      const path =
        leaseTemplateObjectPath(input.leaseTemplateDocUrl) ?? legacyLeaseTemplateObjectPath(input.leaseTemplateDocUrl);
      if (path) lines.push({ label: "Stored file", value: path });
    }
    return {
      kind: "update_property_lease_config",
      title: "Update lease settings",
      summary: `Update lease document settings for ${title}.`,
      fields: lines,
      confirmLabel: "Save lease settings",
    };
  },
  handler: async (ctx, input) => {
    const validationError = validateLeaseConfigInput(input);
    if (validationError) throw new Error(validationError);
    const rec = await loadOwnedPropertyRecord(ctx, input.propertyId);
    if (!rec) throw new Error("No property with that id belongs to this landlord.");
    const existingSub = listingSubmissionFromRecord(rec);
    if (!existingSub) throw new Error("This property has no listing submission to update.");

    const dedupeKey = `update_property_lease_config:${ctx.landlordId}:${rec.id}:${input.leaseSource}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_property_lease_config",
      toolName: "update_property_lease_config",
      inputSummary: { propertyId: rec.id, leaseSource: input.leaseSource },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those lease settings were already saved for this property today." };
      throw new Error("Could not record the action; lease settings were not saved.");
    }

    const merged = applyLeaseConfigToSubmission(
      normalizeManagerListingSubmissionV1(existingSub as ManagerListingSubmissionV1),
      input,
    );
    const payloads = writeSubmissionToRecordPayloads(rec, merged);
    // No plan-quota gate: lease settings patch only `row_data` /
    // `property_data` and never write `status`, so this cannot move a record
    // into a listing slot.
    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        row_data: payloads.row_data,
        property_data: payloads.property_data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { saved: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }

    await updateAuditResult(ctx, dedupeKey, { saved: true, propertyId: rec.id, leaseSource: input.leaseSource });
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "title") ?? str(src, "buildingName") ?? rec.id;
    return {
      reply: `Saved lease settings for ${title} (${leaseSourceInputLabel(input.leaseSource)}). Residents signing after this change use the updated lease document.`,
      resultSummary: { propertyId: rec.id, leaseSource: input.leaseSource },
    };
  },
});

const PROPERTY_LEASE_TEMPLATE_KIND = z.enum(["short-term", "long-term"]);

async function loadPropertyLeaseTemplateForKind(
  ctx: AgentContext,
  propertyId: string,
  templateKind: PropertyLeaseTemplateKind,
): Promise<{ rec: RawPropertyRecord; sub: ManagerListingSubmissionV1; template: NonNullable<ReturnType<typeof findPropertyLeaseTemplate>> }> {
  const rec = await loadOwnedPropertyRecord(ctx, propertyId);
  if (!rec) throw new Error("No property with that id belongs to this landlord. Use list_properties to get valid ids.");
  const sub = listingSubmissionFromRecord(rec);
  if (!sub) throw new Error("This property has no listing submission to update — open it in Properties first.");
  const normalized = normalizeManagerListingSubmissionV1(sub);
  const template = findPropertyLeaseTemplate(normalized, templateKind);
  if (!template) {
    throw new Error(
      `No ${templateKind} lease template exists on this property. Add it in Properties → Lease first.`,
    );
  }
  return { rec, sub: normalized, template };
}

export const listPropertyLeaseTemplateSectionsTool = defineTool({
  name: "list_property_lease_template_sections",
  description:
    "List editable sections of a property's lease template (long-term or short-term) while the manager is in the Lease modal. Use before propose_property_lease_template_section_edit.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1),
      templateKind: PROPERTY_LEASE_TEMPLATE_KIND,
    })
    .strict(),
  handler: async (ctx, input) => {
    const { template, sub } = await loadPropertyLeaseTemplateForKind(ctx, input.propertyId, input.templateKind);
    const html = resolvePropertyLeaseTemplateHtml({ sub, template });
    const sections = readPropertyLeaseTemplateSections(html).map((section) => ({
      id: section.id,
      title: section.title,
      editable: propertyLeaseTemplateSectionIsEditable(section),
    }));
    return {
      reply:
        sections.length === 0
          ? "No sections found on this lease template."
          : `Lease sections (${input.templateKind}): ${sections.map((s) => `${s.id} (${s.title}${s.editable ? "" : ", locked"})`).join("; ")}`,
      resultSummary: { propertyId: input.propertyId, templateKind: input.templateKind, sections },
    };
  },
});

export const proposePropertyLeaseTemplateSectionEditTool = defineWriteTool({
  name: "propose_property_lease_template_section_edit",
  description:
    "Propose a text edit to one section of a property lease template (PropLane default long-term or short-term). Use list_property_lease_template_sections first. Applies immediately after the manager confirms and updates the open Lease modal.",
  inputSchema: z
    .object({
      propertyId: z.string().min(1),
      templateKind: PROPERTY_LEASE_TEMPLATE_KIND,
      sectionId: z.string().min(1),
      value: z.string().max(20_000).describe("Replacement section body as plain text paragraphs, not HTML."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const { rec, template, sub } = await loadPropertyLeaseTemplateForKind(ctx, input.propertyId, input.templateKind);
    const html = resolvePropertyLeaseTemplateHtml({ sub, template });
    const section = readPropertyLeaseTemplateSections(html).find((candidate) => candidate.id === input.sectionId);
    if (!section) throw new Error("That section does not exist. Use list_property_lease_template_sections first.");
    if (!propertyLeaseTemplateSectionIsEditable(section)) {
      throw new Error("That section is required or derived and cannot be edited.");
    }
    const before = sectionSourceFromHtml(section.bodyHtml);
    const src = asObject(rec.property_data) ?? asObject(rec.row_data);
    const title = str(src, "title") ?? str(src, "buildingName") ?? input.propertyId;
    return {
      kind: "property_lease_template_section_edit",
      title: `Edit ${section.title}`,
      summary: `Update the ${input.templateKind} lease template for ${title}.`,
      fields: [
        { label: "Template", value: input.templateKind },
        { label: "Section", value: section.title },
        { label: "Before", value: before || "(empty)" },
        { label: "After", value: input.value || "(empty)" },
      ],
      confirmLabel: "Apply to lease",
      confirmedInput: input,
    };
  },
  handler: async (ctx, input) => {
    const { rec, sub, template } = await loadPropertyLeaseTemplateForKind(ctx, input.propertyId, input.templateKind);
    const html = resolvePropertyLeaseTemplateHtml({ sub, template });
    const section = readPropertyLeaseTemplateSections(html).find((candidate) => candidate.id === input.sectionId);
    if (!section || !propertyLeaseTemplateSectionIsEditable(section)) {
      throw new Error("That section is not editable.");
    }
    const escaped = input.value
      .trim()
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
      .join("\n");
    const nextHtml = applyPropertyLeaseTemplateSectionEdit(html, section.id, escaped || "");
    const templates = readPropertyLeaseTemplates(sub);
    const nextTemplates = updatePropertyLeaseTemplate(templates, template.id, {
      leaseTemplateHtmlOverride: nextHtml,
    });
    const merged = syncLegacyLeaseFieldsFromTemplates(sub, nextTemplates);
    const dedupeKey = `property_lease_template_section_edit:${ctx.landlordId}:${rec.id}:${template.id}:${input.sectionId}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "propose_property_lease_template_section_edit",
      toolName: "propose_property_lease_template_section_edit",
      inputSummary: { propertyId: rec.id, templateKind: input.templateKind, sectionId: input.sectionId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That lease section edit was already saved today." };
      throw new Error("Could not record the action; the lease was not updated.");
    }
    const payloads = writeSubmissionToRecordPayloads(rec, merged);
    const { error } = await ctx.db
      .from("manager_property_records")
      .update({
        row_data: payloads.row_data,
        property_data: payloads.property_data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", rec.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { saved: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { saved: true, propertyId: rec.id, sectionId: input.sectionId });
    return {
      reply: `Updated "${section.title}" on the ${input.templateKind} lease template. The Lease modal preview refreshes automatically.`,
      resultSummary: { propertyId: rec.id, templateKind: input.templateKind, sectionId: input.sectionId },
    };
  },
});
