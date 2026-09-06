import "server-only";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { managerOwnedPropertyIdSet } from "@/lib/auth/manager-application-access";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { writeAuditLog, updateAuditResult } from "@/lib/tools/audit";
import { track } from "@/lib/analytics/posthog";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import {
  applyInspectionObservations, createInspectionSchema,
  InspectionError, transitionInspection,
  type InspectionDetail, type InspectionDocument, type InspectionRecord,
  type InspectionResidency, type InspectionSummary,
} from "./model";

import { createRoomInspectionDocument, inspectionRoomListing, resolveInspectionRoom } from "./room-template";
import { roomInspectionRequirements } from "./requirements";

export type InspectionActor = { role: "manager"; context: AgentContext } | { role: "resident"; context: ResidentAgentContext };
const TABLE = "resident_inspections";
export const INSPECTION_BUCKET = "inspection-evidence";
const summaryColumns = "id,application_id,manager_user_id,property_id,resident_name,property_label,room_label,kind,status,inspection_date,baseline_id,revision,created_at,updated_at";
type Scope = { owners: Set<string>; properties: Set<string> };

// One request resolves read and edit scope at most once each: every entry point below asks
// for scope, and each resolution costs two portfolio queries. The cache is keyed on the
// per-request context object, so it cannot outlive the request or leak across actors.
const scopeCache = new WeakMap<object, Map<string, Promise<Scope>>>();

function scopeFor(actor: InspectionActor, level: "read" | "edit" = "read"): Promise<Scope> {
  const key = actor.context as unknown as object;
  const byLevel = scopeCache.get(key) ?? new Map<string, Promise<Scope>>();
  scopeCache.set(key, byLevel);
  const cached = byLevel.get(level);
  if (cached) return cached;
  const pending = resolveScope(actor, level).catch((error) => {
    byLevel.delete(level);
    throw error;
  });
  byLevel.set(level, pending);
  return pending;
}

async function resolveScope(actor: InspectionActor, level: "read" | "edit"): Promise<Scope> {
  if (actor.role === "resident") {
    if (actor.context.phase !== "approved") throw new InspectionError("Inspections become available after your lease is ready.", 403);
    return { owners: new Set(), properties: new Set() };
  }
  // This service is a portal capability. Do not widen a delegated SMS turn.
  if (actor.context.managerSmsAccess?.mode === "delegated") throw new InspectionError("Open the portal to manage inspections.", 403);
  const { db, userId } = actor.context;
  const [owned, linked] = await Promise.all([
    managerOwnedPropertyIdSet(db, userId), linkedOwnerScopeForModule(db, userId, "residents", level),
  ]);
  return { owners: new Set([userId]), properties: new Set([...owned, ...linked.propertyIds]) };
}

function residentMatches(actor: InspectionActor, row: { resident_email: string; resident_user_id?: string | null; manager_user_id: string }) {
  if (actor.role !== "resident") return false;
  const ctx = actor.context;
  return Boolean(ctx.email) && row.resident_email.trim().toLowerCase() === ctx.email &&
    (!row.resident_user_id || row.resident_user_id === ctx.userId) &&
    (!ctx.activeManagerId || ctx.activeManagerId === row.manager_user_id);
}

function authorized(actor: InspectionActor, scope: Scope, row: { resident_email: string; resident_user_id?: string | null; manager_user_id: string; property_id: string }) {
  return actor.role === "resident" ? residentMatches(actor, row) :
    scope.owners.has(row.manager_user_id) || scope.properties.has(row.property_id);
}

export async function getInspection(actor: InspectionActor, id: string, level: "read" | "edit" = "read"): Promise<InspectionRecord> {
  const scope = await scopeFor(actor, level);
  const data = (await scopedRows(actor, TABLE, scope, "*", id))[0] as unknown as InspectionRecord | undefined;
  if (!data || !authorized(actor, scope, data)) throw new InspectionError("Inspection not found.", 404);
  return data as InspectionRecord;
}

/** Each query is scoped before it runs, and paginated to avoid Supabase's 1,000-row ceiling. */
async function scopedRows(actor: InspectionActor, table: string, scope: Scope, columns = "*", id?: string) {
  const filters: { column: string; values: string[] }[] = actor.role === "resident"
    ? [{ column: "resident_email", values: [actor.context.email] }]
    : [{ column: "manager_user_id", values: [...scope.owners] }, { column: "property_id", values: [...scope.properties] },
      ...(table === "manager_application_records" ? [{ column: "assigned_property_id", values: [...scope.properties] }] : [])];
  const rows = new Map<string, Record<string, unknown>>();
  for (const filter of filters) {
    for (let chunk = 0; chunk < filter.values.length; chunk += 100) {
      for (let offset = 0; ; offset += 500) {
        let query = actor.context.db.from(table).select(columns).in(filter.column, filter.values.slice(chunk, chunk + 100));
        if (id) query = query.eq("id", id);
        const { data, error } = await query.order("id").range(offset, offset + 499);
        if (error) throw new InspectionError("Could not load inspection records. Please try again.", 500);
        for (const row of data ?? []) {
          const value = row as unknown as Record<string, unknown>;
          rows.set(String(value.id), value);
        }
        if ((data ?? []).length < 500) break;
      }
    }
  }
  return [...rows.values()];
}

// An application row's `row_data` is the whole rental application. The inspections list needs
// eight of its fields, so it selects those rather than paging entire applications on every load.
const residencyColumns = "id,manager_user_id,property_id,assigned_property_id,resident_email,"
  + "app_bucket:row_data->>bucket,app_withdrawn_at:row_data->>withdrawnAt,"
  + "app_name:row_data->>name,app_property:row_data->>property,"
  + "app_property_id:row_data->>propertyId,app_assigned_property_id:row_data->>assignedPropertyId,"
  + "app_resident_user_id:row_data->>residentUserId,app_room_choice:row_data->>assignedRoomChoice,"
  + "app_manual_room:row_data->manualResidentDetails->>roomNumber";

type ResidencyView = {
  id: string;
  approved: boolean;
  name: string;
  propertyLabel: string;
  roomLabel: string;
  manualRoom: string;
  identity: { manager_user_id: string; property_id: string; resident_email: string; resident_user_id: string | null };
};

function residencyFromRecord(record: Record<string, unknown>): ResidencyView {
  const text = (alias: string): string => {
    const value = record[alias];
    return value == null ? "" : String(value);
  };
  return {
    id: String(record.id),
    approved: text("app_bucket") === "approved" && !text("app_withdrawn_at"),
    name: text("app_name") || "Resident",
    propertyLabel: text("app_property") || "Property",
    roomLabel: text("app_room_choice") || text("app_manual_room") || "",
    manualRoom: text("app_manual_room"),
    identity: {
      manager_user_id: text("manager_user_id"),
      property_id: text("assigned_property_id") || text("app_assigned_property_id")
        || text("property_id") || text("app_property_id"),
      resident_email: text("resident_email"),
      resident_user_id: text("app_resident_user_id") || null,
    },
  };
}

export async function listInspectionResidencies(actor: InspectionActor): Promise<InspectionResidency[]> {
  const [scope, editScope] = await Promise.all([scopeFor(actor), scopeFor(actor, "edit")]);
  const records = await scopedRows(actor, "manager_application_records", scope, residencyColumns);
  const visible = records.map(residencyFromRecord).filter(residency => residency.approved &&
    residency.identity.property_id && residency.identity.resident_email && authorized(actor, scope, residency.identity));
  const propertyIds = [...new Set(visible.map(r => r.identity.property_id))];
  const properties = new Map<string, unknown>();
  for (let offset = 0; offset < propertyIds.length; offset += 100) {
    const { data, error } = await actor.context.db.from("manager_property_records")
      .select("id,rooms:property_data->listingSubmission->rooms,legacy_rooms:row_data->submission->rooms")
      .in("id", propertyIds.slice(offset, offset + 100));
    if (error) throw new InspectionError("Could not load room inspection requirements.", 500);
    for (const property of data ?? []) properties.set(property.id, property.rooms ?? property.legacy_rooms);
  }
  return visible.flatMap(residency => {
    const identity = residency.identity;
    if (!residency.approved) return [];
    if (!identity.property_id || !identity.resident_email || !authorized(actor, scope, identity)) return [];
    return [{ id: residency.id, name: residency.name, property: residency.propertyLabel,
      room: residency.roomLabel, requiredKinds: roomInspectionRequirements(identity.property_id, residency.roomLabel, properties.get(identity.property_id)),
      canCreate: Boolean(residency.roomLabel && residency.roomLabel !== identity.property_id) && authorized(actor, editScope, identity) }];
  });
}

export async function listInspections(actor: InspectionActor, applicationId?: string): Promise<InspectionSummary[]> {
  const scope = await scopeFor(actor);
  const rows = await scopedRows(actor, TABLE, scope, `${summaryColumns},resident_email,resident_user_id`);
  return rows.filter(raw => {
    const row = raw as unknown as InspectionRecord;
    return authorized(actor, scope, row) && (!applicationId || row.application_id === applicationId);
  }).map(raw => {
    const summary = { ...raw };
    delete summary.resident_email; delete summary.resident_user_id;
    return summary as InspectionSummary;
  }).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function prepareInspection(actor: InspectionActor, raw: unknown) {
  const input = createInspectionSchema.parse(raw);
  const scope = await scopeFor(actor, "edit");
  const data = (await scopedRows(actor, "manager_application_records", scope, residencyColumns, input.applicationId))[0];
  if (!data) throw new InspectionError("Residency not found.", 404);
  const residency = residencyFromRecord(data);
  const identity = { ...residency.identity, resident_email: residency.identity.resident_email.trim().toLowerCase() };
  if (!authorized(actor, scope, identity)) throw new InspectionError("Residency not found.", 404);
  if (!residency.approved || !identity.property_id || !identity.resident_email) throw new InspectionError("Choose an approved resident with a property placement.");
  // The actual property's owner, rather than a caller-supplied or stale owner stamp.
  const { data: property, error: propertyError } = await actor.context.db.from("manager_property_records").select("manager_user_id,listing_rooms:property_data->listingSubmission->rooms,listing_bathrooms:property_data->listingSubmission->bathrooms,legacy_rooms:row_data->submission->rooms,legacy_bathrooms:row_data->submission->bathrooms").eq("id", identity.property_id).maybeSingle();
  if (propertyError || !property?.manager_user_id) throw new InspectionError("The resident's property could not be found.");
  identity.manager_user_id = String(property.manager_user_id);
  if (!authorized(actor, scope, identity)) throw new InspectionError("Residency not found.", 404);
  const submission = inspectionRoomListing(property.listing_rooms ?? property.legacy_rooms, property.listing_bathrooms ?? property.legacy_bathrooms);
  const room = resolveInspectionRoom(identity.property_id, residency.roomLabel, residency.manualRoom, submission);
  let baseline: InspectionRecord | null = null;
  if (input.baselineId) {
    baseline = await getInspection(actor, input.baselineId);
    if (input.kind !== "move-out" || baseline.kind !== "move-in" || baseline.status !== "completed" ||
      baseline.application_id !== input.applicationId || baseline.property_id !== identity.property_id ||
      (baseline.document.roomScope ? baseline.document.roomScope.assignment !== room.assignment : baseline.room_label !== residency.roomLabel && baseline.room_label !== room.label) ||
      baseline.manager_user_id !== identity.manager_user_id || baseline.inspection_date > input.inspectionDate) {
      throw new InspectionError("Choose a completed move-in report from this residency dated before the move-out.");
    }
  }
  return { input, identity, residency, room, baseline };
}

export async function createInspection(actor: InspectionActor, raw: unknown): Promise<InspectionRecord> {
  const { input, identity, residency, room, baseline } = await prepareInspection(actor, raw);
  const auditKey = await auditInspectionWrite(actor, "create", { application_id: input.applicationId, kind: input.kind });
  const now = new Date().toISOString();
  const document = createRoomInspectionDocument(room);
  document.history.push({ action: "create", role: actor.role, userId: actor.context.userId, at: now });
  const { data: created, error: insertError } = await actor.context.db.from(TABLE).insert({
    ...identity, application_id: input.applicationId, resident_name: residency.name,
    property_label: residency.propertyLabel, room_label: room.label,
    kind: input.kind, inspection_date: input.inspectionDate, baseline_id: baseline?.id ?? null, document,
  }).select("*").single();
  await updateAuditResult(actor.context, auditKey, { status: insertError ? "failed" : "success", inspection_id: created?.id ?? null });
  if (insertError?.code === "23505") throw new InspectionError("An unfinished report already exists for this residency and inspection type. Open that report to continue.", 409);
  if (insertError || !created) throw new InspectionError("Could not create the inspection.", 500);
  track("inspection_created", actor.context.userId, { inspection_id: created.id, kind: input.kind, portal: actor.role });
  return created as InspectionRecord;
}

async function auditInspectionWrite(actor: InspectionActor, action: string, summary: Record<string, unknown>) {
  const dedupeKey = `inspection:${randomUUID()}`;
  const result = await writeAuditLog(actor.context, { action: `inspection_${action}`, toolName: "inspections", inputSummary: summary, dedupeKey });
  if (!result.recorded) throw new InspectionError("Could not record the inspection audit. Please try again.", 500);
  return dedupeKey;
}

async function updateInspection(actor: InspectionActor, report: InspectionRecord, document: InspectionDocument, status = report.status): Promise<InspectionRecord> {
  const auditKey = await auditInspectionWrite(actor, document.history.at(-1)?.action ?? "update", { inspection_id: report.id, revision: report.revision });
  const { data, error } = await actor.context.db.from(TABLE).update({ document, status,
    revision: report.revision + 1, updated_at: new Date().toISOString() })
    .eq("id", report.id).eq("revision", report.revision).eq("status", report.status).select("*").maybeSingle();
  await updateAuditResult(actor.context, auditKey, { status: error || !data ? "failed" : "success", revision: data?.revision ?? null });
  if (error) throw new InspectionError("Could not save the inspection.", 500);
  if (!data) throw new InspectionError("Someone updated this report. Your changes were not saved; reload the latest report before trying again.", 409);
  return data as InspectionRecord;
}

export async function saveInspection(actor: InspectionActor, id: string, raw: unknown) {
  const report = await getInspection(actor, id, "edit");
  const document = applyInspectionObservations(report, actor.role, raw);
  document.history.push({ action: "save", role: actor.role, userId: actor.context.userId, at: new Date().toISOString() });
  return updateInspection(actor, report, document);
}

export async function changeInspectionStatus(actor: InspectionActor, id: string, raw: unknown) {
  const report = await getInspection(actor, id, "edit");
  const next = transitionInspection(report, actor.role, actor.context.userId, raw);
  const saved = await updateInspection(actor, report, next.document, next.status);
  if (saved.status !== report.status && saved.status !== "draft") {
    track(saved.status === "completed" ? "inspection_completed" : "inspection_submitted", actor.context.userId,
      { inspection_id: id, kind: report.kind, portal: actor.role });
  }
  return saved;
}

async function signPhotos(actor: InspectionActor, report: InspectionRecord) {
  const copy = structuredClone(report);
  const photos = copy.document.areas.flatMap(area => area.items.flatMap(item => [...item.manager.photos, ...item.resident.photos]));
  if (photos.length) {
    const { data, error } = await actor.context.db.storage.from(INSPECTION_BUCKET).createSignedUrls(photos.map(p => p.path), 900);
    if (error) throw new InspectionError("Could not load inspection photos.", 500);
    const urls = new Map((data ?? []).map(p => [p.path, p.signedUrl]));
    photos.forEach(p => { p.url = urls.get(p.path) ?? undefined; });
  }
  return copy;
}

export async function inspectionDetail(actor: InspectionActor, id: string): Promise<InspectionDetail> {
  const report = await getInspection(actor, id);
  const editScope = await scopeFor(actor, "edit");
  const baseline = report.baseline_id ? await getInspection(actor, report.baseline_id) : null;
  return { report: await signPhotos(actor, report), baseline: baseline ? await signPhotos(actor, baseline) : null,
    canEdit: authorized(actor, editScope, report) };
}

export async function addInspectionPhoto(actor: InspectionActor, id: string, itemId: string, revision: number, file: File, sourceRef?: string) {
  const report = await getInspection(actor, id, "edit");
  if (report.status !== "draft" || report.revision !== revision) throw new InspectionError("Reload the current draft before adding photos.", 409);
  const document = structuredClone(report.document);
  const items = document.areas.flatMap(a => a.items);
  const item = items.find(i => i.id === itemId);
  if (!item) throw new InspectionError("Checklist item not found.");
  if (sourceRef && item[actor.role].photos.some(p => p.sourceRef === sourceRef && p.uploadedBy === actor.context.userId)) return report;
  if (items.flatMap(i => [...i.manager.photos, ...i.resident.photos]).length >= 60) throw new InspectionError("This report has reached its 60-photo limit.");
  if (!file.size || file.size > 5 * 1024 * 1024) throw new InspectionError("Choose a photo smaller than 5 MB.");
  const source = Buffer.from(await file.arrayBuffer());
  let image: Buffer;
  try {
    const metadata = await sharp(source, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "")) throw new Error("unsupported image");
    // Re-encode to remove metadata, including GPS, and keep download costs bounded.
    image = await sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch { throw new InspectionError("Choose a valid JPEG, PNG or WebP photo."); }
  const photoId = randomUUID();
  const path = `${report.manager_user_id}/${id}/${photoId}.jpg`;
  const storage = actor.context.db.storage.from(INSPECTION_BUCKET);
  const { error } = await storage.upload(path, image, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
  if (error) throw new InspectionError("Could not upload the photo.", 500);
  item[actor.role].photos.push({ id: photoId, path, uploadedBy: actor.context.userId, uploadedAt: new Date().toISOString(), ...(sourceRef ? { sourceRef } : {}) });
  document.history.push({ action: "photo-added", role: actor.role, userId: actor.context.userId, at: new Date().toISOString() });
  try { return await updateInspection(actor, report, document); }
  catch (error) { await storage.remove([path]); throw error; }
}

export async function removeInspectionPhoto(actor: InspectionActor, id: string, photoId: string, revision: number) {
  const report = await getInspection(actor, id, "edit");
  if (report.status !== "draft" || report.revision !== revision) throw new InspectionError("Reload the current draft before removing photos.", 409);
  const document = structuredClone(report.document);
  let found = false;
  for (const item of document.areas.flatMap(a => a.items)) {
    item[actor.role].photos = item[actor.role].photos.filter(photo => {
      if (photo.id !== photoId) return true;
      if (photo.uploadedBy !== actor.context.userId) throw new InspectionError("Only the uploader can remove this photo.", 403);
      found = true;
      return false;
    });
  }
  if (!found) throw new InspectionError("Photo not found.", 404);
  document.history.push({ action: "photo-removed", role: actor.role, userId: actor.context.userId, at: new Date().toISOString() });
  // Retain the private object for audit retention. It is no longer accessible through report APIs.
  return updateInspection(actor, report, document);
}
