import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { after } from "next/server";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerSectionAllowedForTier } from "@/lib/manager-access";
import { getManagerPortalNavSubscriptionTier } from "@/lib/manager-access-server";
import { managerOwnedPropertyIdSet } from "@/lib/auth/manager-application-access";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";
import { writeAuditLog, updateAuditResult } from "@/lib/tools/audit";
import { track } from "@/lib/analytics/posthog";
import { rateLimit } from "@/lib/rate-limit";
import { completeOpenLinkedFormRequestByForm } from "@/lib/application-linked-form-requests.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { LEASE_TEMPLATE_BUCKET, LEASE_TEMPLATE_MAX_BYTES } from "@/lib/lease-template-storage";
import { isLegitimateEmail } from "@/lib/email-address";
import { isCompletePhoneNumber } from "@/lib/phone-number-field";
import { isCustomFieldHiddenByCondition } from "@/lib/rental-application/custom-fields";
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import type { RentalCustomFieldAnswer } from "@/lib/rental-application/types";
import { normalizeLeaseTemplateKind } from "@/lib/property-lease-templates";
import type { AgentContext } from "@/lib/tools/context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { MAX_FILES_PER_FORM, MAX_FILES_PER_QUESTION, MAX_SIGNATURES_PER_QUESTION, MAX_UPLOAD_REQUEST_BYTES } from "./limits";
import { emailManagerOfMoveInFormSubmission, emitMoveInFormEvent } from "./move-in-form-events.server";
import {
  MOVE_IN_FORM_ID_PATTERN, moveInFormDefaultKindOfId, moveInFormDueFor, readMoveInFormSettings, readMoveInFormTemplates,
  moveInLeaseKindOf, normalizeMoveInFormQuestions, templateAppliesToRoom, templateLeaseTypeAdmits, templateLinkMatches,
} from "./templates";
import { MOVE_IN_FORM_BLOCKS, resolveMoveInFormBlocks } from "./types";
import type {
  MoveInFormAnswer, MoveInFormKind, MoveInFormQuestion, MoveInFormRecord, MoveInFormStatus, MoveInFormSummary, MoveInFormTemplate,
  MoveInFormTrigger,
} from "./types";

export type MoveInFormActor =
  | { role: "manager"; context: AgentContext }
  | { role: "resident"; context: ResidentAgentContext };

export class MoveInFormError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MoveInFormError";
  }
}

/**
 * Move-in is a Pro and Business module: the page paywalls it for a Free manager, and so does the API
 * (the page alone is a button, not a gate). The same tier rule as the sidebar and `subscriptionGated`:
 * a co-manager with no portfolio of their own inherits their best linked owner's plan.
 */
export async function assertMoveInPlan(managerUserId: string): Promise<void> {
  const tier = await getManagerPortalNavSubscriptionTier(managerUserId);
  if (!managerSectionAllowedForTier("move-in", tier)) {
    throw new MoveInFormError("Move-in forms require the Pro or Business plan. Upgrade in Settings > Subscription.", 402);
  }
}

/** The route's gate: every manager call passes it; a resident answers a form already sent to them. */
export async function assertMoveInPlanForActor(actor: MoveInFormActor): Promise<void> {
  if (actor.role === "manager") await assertMoveInPlan(actor.context.userId);
}

const TABLE = "resident_move_in_forms";
export const MOVE_IN_FORM_FILES_BUCKET = "move-in-form-files";
const MAX_IMAGE_BYTES = MAX_UPLOAD_REQUEST_BYTES;
const FILE_URL_SECONDS = 300;
const REMIND_COOLDOWN_MS = 5 * 60_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const FILE_PATH_PATTERN = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,80}\/[0-9a-f-]{36}\.(jpg|png)$/i;
const TEMPLATE_PDF_PATH_PATTERN = /^[A-Za-z0-9-]{1,64}\/move-in-forms\/[A-Za-z0-9_-]{1,120}\/\d+-[0-9a-f-]{36}\.pdf$/i;

type MoveInFormRow = {
  id: string;
  application_id: string;
  manager_user_id: string;
  property_id: string;
  property_label: string;
  room_label: string;
  resident_name: string;
  resident_email: string;
  resident_user_id: string | null;
  form_id: string;
  form_name: string;
  source: "built" | "upload";
  snapshot: MoveInFormRecord["snapshot"];
  status: MoveInFormStatus;
  answers: MoveInFormAnswer[];
  signed_document_sha256: string | null;
  sent_at: string;
  due_at: string | null;
  submitted_at: string | null;
  reminded_at: string | null;
  manager_viewed_at: string | null;
  /** The optimistic-concurrency token a manager edit swaps on. */
  updated_at: string;
};

/* ------------------------------------------------------------------ scope */

type Scope = { owners: Set<string>; properties: Set<string>; workspace: Set<string> | null };

// One request resolves read and edit scope at most once each; keyed on the per-request
// context object so it can neither outlive the request nor leak across actors.
const scopeCache = new WeakMap<object, Map<string, Promise<Scope>>>();

function scopeFor(actor: MoveInFormActor, level: "read" | "edit" = "read"): Promise<Scope> {
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

async function resolveScope(actor: MoveInFormActor, level: "read" | "edit"): Promise<Scope> {
  if (actor.role === "resident") return { owners: new Set(), properties: new Set(), workspace: null };
  // A portal capability: never widen a delegated SMS turn.
  if (actor.context.managerSmsAccess?.mode === "delegated") throw new MoveInFormError("Open the portal to manage move-in forms.", 403);
  const { db, userId } = actor.context;
  const [owned, linked, workspaceIds] = await Promise.all([
    managerOwnedPropertyIdSet(db, userId),
    linkedOwnerScopeForModule(db, userId, "residents", level),
    // A failed read becomes `null`, which means "no workspace narrowing" (the project-wide convention in
    // workspaces/scope.server.ts), not "no access": ownership/grants above remain the authorization.
    activeWorkspacePropertyScope(db, userId).catch(() => null),
  ]);
  return {
    owners: new Set([userId]),
    properties: new Set([...owned, ...linked.propertyIds]),
    workspace: workspaceIds === null ? null : new Set(workspaceIds),
  };
}

type Identity = { resident_email: string; resident_user_id?: string | null; manager_user_id: string; property_id: string };

function authorized(actor: MoveInFormActor, scope: Scope, row: Identity): boolean {
  if (actor.role === "resident") {
    const email = actor.context.email;
    return Boolean(email) && row.resident_email.trim().toLowerCase() === email &&
      (!row.resident_user_id || row.resident_user_id === actor.context.userId);
  }
  if (!(scope.owners.has(row.manager_user_id) || scope.properties.has(row.property_id))) return false;
  return scope.workspace === null || scope.workspace.has(row.property_id);
}

function tableReadError(table: string, error: { code?: string; message?: string }): MoveInFormError {
  const code = error.code ?? "";
  const message = (error.message ?? "").toLowerCase();
  const missing = code === "PGRST205" || code === "42P01" || message.includes("schema cache") ||
    (message.includes("relation") && message.includes("does not exist"));
  if (missing) {
    return new MoveInFormError(`Move-in forms are not set up in this environment yet — the "${table}" table is missing. Apply the pending database migrations to enable them.`, 503);
  }
  return new MoveInFormError("Could not load move-in forms. Please try again.", 500);
}

/** Each query is scoped before it runs, and paginated past Supabase's 1,000-row ceiling. */
type RowFilters = { id?: string; propertyId?: string; applicationId?: string; status?: "sent" | "submitted"; excludeCancelled?: boolean };

async function scopedRows(actor: MoveInFormActor, scope: Scope, only: RowFilters = {}): Promise<MoveInFormRow[]> {
  const filters: { column: string; values: string[] }[] = actor.role === "resident"
    ? [{ column: "resident_email", values: [actor.context.email] }]
    : [{ column: "manager_user_id", values: [...scope.owners] }, { column: "property_id", values: [...scope.properties] }];
  const rows = new Map<string, MoveInFormRow>();
  for (const filter of filters) {
    for (let chunk = 0; chunk < filter.values.length; chunk += 100) {
      for (let offset = 0; ; offset += 500) {
        let query = actor.context.db.from(TABLE).select("*").in(filter.column, filter.values.slice(chunk, chunk + 100));
        if (only.id) query = query.eq("id", only.id);
        if (only.propertyId) query = query.eq("property_id", only.propertyId);
        if (only.applicationId) query = query.eq("application_id", only.applicationId);
        if (only.status) query = query.eq("status", only.status);
        else if (only.excludeCancelled) query = query.neq("status", "cancelled");
        const { data, error } = await query.order("id").range(offset, offset + 499);
        if (error) throw tableReadError(TABLE, error);
        for (const row of (data ?? []) as unknown as MoveInFormRow[]) rows.set(row.id, row);
        if ((data ?? []).length < 500) break;
      }
    }
  }
  return [...rows.values()];
}

/** A foreign or missing id is a 404 either way: never an oracle for which one it was. */
async function getRow(actor: MoveInFormActor, id: string, level: "read" | "edit" = "read"): Promise<MoveInFormRow> {
  const scope = await scopeFor(actor, level);
  const row = (await scopedRows(actor, scope, { id }))[0];
  if (!row || !authorized(actor, scope, row)) throw new MoveInFormError("Form not found.", 404);
  return row;
}

/* ---------------------------------------------------------------- mapping */

function questionsOf(row: MoveInFormRow): MoveInFormQuestion[] {
  return Array.isArray(row.snapshot?.questions) ? row.snapshot.questions : [];
}

function toRecord(row: MoveInFormRow, viewer: "manager" | "resident"): MoveInFormRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    // A resident has no use for the manager's account id.
    ...(viewer === "resident" ? {} : { managerUserId: row.manager_user_id }),
    propertyId: row.property_id,
    propertyLabel: row.property_label,
    roomLabel: row.room_label,
    residentName: row.resident_name,
    residentEmail: row.resident_email,
    formId: row.form_id,
    formName: row.form_name,
    source: row.source,
    snapshot: { questions: questionsOf(row), pdf: row.snapshot?.pdf ?? null, ...(row.snapshot?.kind ? { kind: row.snapshot.kind } : {}), ...(row.snapshot?.blocks ? { blocks: row.snapshot.blocks } : {}) },
    status: row.status,
    answers: Array.isArray(row.answers) ? row.answers : [],
    signedDocumentSha256: row.signed_document_sha256,
    sentAt: row.sent_at,
    dueAt: row.due_at,
    submittedAt: row.submitted_at,
    remindedAt: row.reminded_at,
    managerViewedAt: viewer === "manager" ? row.manager_viewed_at : null,
  };
}

function toSummary(row: MoveInFormRow, viewer: "manager" | "resident"): MoveInFormSummary {
  const { answers, snapshot, ...summary } = toRecord(row, viewer);
  return {
    ...summary,
    kind: snapshot.kind ?? moveInFormDefaultKindOfId(row.form_id) ?? "other",
    blocks: resolveMoveInFormBlocks(snapshot.blocks, snapshot.kind ?? moveInFormDefaultKindOfId(row.form_id) ?? "other"),
    questionCount: snapshot.questions.length,
    photoCount: answers.reduce((total, answer) => total + ("files" in answer ? answer.files.length : 0), 0),
    signed: answers.some((answer) => "signature" in answer),
  };
}

/* ------------------------------------------------------------------ audit */

async function audit(actor: MoveInFormActor, action: string, summary: Record<string, unknown>): Promise<string> {
  const dedupeKey = `move-in-form:${randomUUID()}`;
  const result = await writeAuditLog(actor.context, { action: `move_in_form_${action}`, toolName: "move-in-forms", inputSummary: summary, dedupeKey });
  if (!result.recorded) throw new MoveInFormError("Could not record the audit entry. Please try again.", 500);
  return dedupeKey;
}

/* --------------------------------------------------------------- residency */

// An application row's `row_data` is the whole rental application; send/dispatch need these fields.
const residencyColumns = "id,manager_user_id,property_id,assigned_property_id,resident_email,"
  + "app_bucket:row_data->>bucket,app_withdrawn_at:row_data->>withdrawnAt,"
  + "app_name:row_data->>name,app_property:row_data->>property,"
  + "app_property_id:row_data->>propertyId,app_assigned_property_id:row_data->>assignedPropertyId,"
  + "app_resident_user_id:row_data->>residentUserId,app_room_choice:row_data->>assignedRoomChoice,"
  + "app_manual_room:row_data->manualResidentDetails->>roomNumber,"
  + "app_manual_move_in:row_data->manualResidentDetails->>moveInDate,"
  + "app_lease_start:row_data->application->>leaseStart,"
  + "app_lease_end:row_data->application->>leaseEnd,"
  + "app_template_id:row_data->application->>applicationTemplateId,"
  + "app_rental_type:row_data->application->>rentalType";

type Residency = {
  id: string;
  approved: boolean;
  /** Submitted and not withdrawn or declined: still in play (pending) or already approved. */
  inPlay: boolean;
  /** The application template the applicant filled in (`propertyApplicationTemplates` id), when it recorded one. */
  applicationTemplateId: string;
  /** `standard` / `short_term` as the application recorded it ("" when it did not). */
  rentalType: string;
  leaseEnd: string;
  name: string;
  propertyLabel: string;
  roomChoice: string;
  manualRoom: string;
  moveInDate: string;
  identity: { manager_user_id: string; property_id: string; resident_email: string; resident_user_id: string | null };
};

function isoDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (!trimmed || Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function residencyFromRecord(record: Record<string, unknown>): Residency {
  const text = (alias: string): string => (record[alias] == null ? "" : String(record[alias]));
  return {
    id: String(record.id),
    approved: text("app_bucket") === "approved" && !text("app_withdrawn_at"),
    inPlay: (text("app_bucket") === "approved" || text("app_bucket") === "pending") && !text("app_withdrawn_at"),
    applicationTemplateId: text("app_template_id").trim(),
    rentalType: text("app_rental_type").trim(),
    leaseEnd: isoDate(text("app_lease_end")),
    name: text("app_name") || "Resident",
    propertyLabel: text("app_property") || "Property",
    roomChoice: text("app_room_choice"),
    manualRoom: text("app_manual_room"),
    moveInDate: isoDate(text("app_manual_move_in")) || isoDate(text("app_lease_start")),
    identity: {
      manager_user_id: text("manager_user_id"),
      property_id: text("assigned_property_id") || text("app_assigned_property_id") || text("property_id") || text("app_property_id"),
      resident_email: text("resident_email").trim().toLowerCase(),
      resident_user_id: text("app_resident_user_id") || null,
    },
  };
}

async function readResidency(db: SupabaseClient, applicationId: string): Promise<Residency | null> {
  const { data, error } = await db.from("manager_application_records").select(residencyColumns).eq("id", applicationId).maybeSingle();
  if (error) throw new MoveInFormError("Could not load the residency.", 500);
  return data ? residencyFromRecord(data as unknown as Record<string, unknown>) : null;
}

type PropertyFacts = {
  id: string;
  ownerId: string;
  templates: MoveInFormTemplate[];
  settings: ReturnType<typeof readMoveInFormSettings>;
  rooms: { id: string; name: string }[];
  /** `propertyLeaseTemplates` id -> its kind, for a form's Lease type. */
  leaseKinds: Map<string, string>;
};

async function readProperty(db: SupabaseClient, propertyId: string): Promise<PropertyFacts | null> {
  const { data, error } = await db.from("manager_property_records")
    .select("id,manager_user_id,templates:property_data->listingSubmission->moveInFormTemplates,settings:property_data->listingSubmission->moveInFormSettings,rooms:property_data->listingSubmission->rooms,legacy_rooms:row_data->submission->rooms,lease_kinds:property_data->listingSubmission->propertyLeaseTemplates")
    .eq("id", propertyId).maybeSingle();
  if (error) throw new MoveInFormError("Could not load the property.", 500);
  if (!data?.manager_user_id) return null;
  const record = data as unknown as Record<string, unknown>;
  // `templates` is null both for "never written" and a stored null; only a real array counts as written.
  const submission: Record<string, unknown> = {};
  if (Array.isArray(record.templates)) submission.moveInFormTemplates = record.templates;
  if (record.settings && typeof record.settings === "object") submission.moveInFormSettings = record.settings;
  const storedIds = new Set(
    Array.isArray(record.templates)
      ? (record.templates as unknown[]).flatMap((entry) =>
        entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? [(entry as { id: string }).id] : [])
      : [],
  );
  const rawRooms = Array.isArray(record.rooms) ? record.rooms : Array.isArray(record.legacy_rooms) ? record.legacy_rooms : [];
  const rooms = (rawRooms as unknown[]).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const room = entry as Record<string, unknown>;
    return typeof room.id === "string" && room.id ? [{ id: room.id, name: typeof room.name === "string" ? room.name : "" }] : [];
  });
  const leaseKinds = new Map<string, string>();
  for (const entry of Array.isArray(record.lease_kinds) ? (record.lease_kinds as unknown[]) : []) {
    const lease = entry as { id?: unknown; kind?: unknown } | null;
    if (lease && typeof lease.id === "string" && lease.id) leaseKinds.set(lease.id, normalizeLeaseTemplateKind(typeof lease.kind === "string" ? lease.kind : null));
  }
  return {
    id: String(data.id),
    ownerId: String(data.manager_user_id),
    leaseKinds,
    // Never-saved defaults are suggestions, not the manager's choice: a property that has not saved its
    // move-in forms sends nothing on its own (outward messages need the manager's own save). The same
    // holds per form: a default form the saved list does not actually hold (older data) is read as
    // "Only when I send it" until the manager saves it.
    templates: readMoveInFormTemplates(submission).map((template) =>
      "moveInFormTemplates" in submission && storedIds.has(template.id) ? template : { ...template, trigger: "manual" as const }),
    settings: readMoveInFormSettings(submission),
    rooms,
  };
}

/** The listing room a residency sits in: the pinned id wins, a name match is the fallback. */
function resolveRoom(property: PropertyFacts, residency: Residency): { id: string | null; label: string } {
  const choice = residency.roomChoice.trim();
  const separator = choice.indexOf("::");
  if (separator >= 0 && choice.slice(0, separator) !== property.id) return { id: null, label: "" };
  const roomId = separator >= 0 ? choice.slice(separator + 2) : "";
  const wanted = (residency.manualRoom || choice).trim().toLowerCase();
  const room = roomId
    ? property.rooms.find((entry) => entry.id === roomId)
    : property.rooms.find((entry) => entry.id === choice || (wanted && entry.name.trim().toLowerCase() === wanted));
  const label = room?.name.trim() || residency.manualRoom.trim() || (choice && separator < 0 && choice !== property.id ? choice : "");
  return { id: room?.id ?? null, label };
}

/* --------------------------------------------------------- template + pdf */

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pdfPathTrusted(path: string, ownerId: string, formId: string): boolean {
  return TEMPLATE_PDF_PATH_PATTERN.test(path) && path.startsWith(`${ownerId}/move-in-forms/${formId}/`);
}

type PdfCache = Map<string, { sha256: string } | null>;

/**
 * Whether a storage download failed because the object is not there. A missing PDF is a form the
 * manager has not finished — a quiet skip. Any other download failure is the bucket being
 * unreachable, which is worth retrying and must not read as "nothing to send".
 */
function storageObjectMissing(error: unknown): boolean {
  const detail = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  const status = Number(detail?.status ?? detail?.statusCode ?? NaN);
  if (Number.isFinite(status)) return status === 400 || status === 404;
  return /not ?found|missing|does not exist|no such/i.test(String(detail?.message ?? ""));
}

/**
 * The questions (and PDF fingerprint) a resident will be asked. A template lives in property
 * JSON a client can write, so its PDF path is never trusted: it must sit under the property
 * owner's own move-in-forms prefix, and the fingerprint is recomputed from the stored bytes.
 */
async function buildSnapshot(
  db: SupabaseClient,
  template: MoveInFormTemplate,
  ownerId: string,
  cache: PdfCache = new Map(),
): Promise<MoveInFormRecord["snapshot"] | null> {
  const questions = structuredClone(template.questions);
  const kind: MoveInFormKind = template.kind;
  const blocks = resolveMoveInFormBlocks(template.blocks, kind);
  if (template.source !== "upload") return { questions, pdf: null, kind, blocks };
  const pdf = template.pdf;
  if (!pdf || !pdfPathTrusted(pdf.storagePath, ownerId, template.id)) return null;
  // An uploaded form is read and signed: without a signature question there is nothing to sign.
  if (!questions.some((question) => question.type === "signature")) return null;
  let entry = cache.get(pdf.storagePath);
  if (entry === undefined) {
    const { data, error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).download(pdf.storagePath);
    if (error && !storageObjectMissing(error)) throw new MoveInFormError("Could not read the form's PDF.", 500);
    entry = data ? { sha256: sha256(new Uint8Array(await data.arrayBuffer())) } : null;
    cache.set(pdf.storagePath, entry);
  }
  if (!entry) return null;
  return { questions, pdf: { storagePath: pdf.storagePath, fileName: pdf.fileName, pageCount: pdf.pageCount, sha256: entry.sha256 }, kind, blocks };
}

type NewRow = {
  residency: Residency;
  ownerId: string;
  roomLabel: string;
  template: MoveInFormTemplate;
  snapshot: MoveInFormRecord["snapshot"];
  dueAt: string | null;
};

async function insertRow(db: SupabaseClient, input: NewRow): Promise<{ row: MoveInFormRow; created: true } | { row: null; created: false }> {
  const { residency, ownerId, template } = input;
  const { data, error } = await db.from(TABLE).insert({
    application_id: residency.id,
    manager_user_id: ownerId,
    property_id: residency.identity.property_id,
    property_label: residency.propertyLabel,
    room_label: input.roomLabel,
    resident_name: residency.name,
    resident_email: residency.identity.resident_email,
    resident_user_id: residency.identity.resident_user_id,
    form_id: template.id,
    form_name: template.name || "Move-in form",
    source: template.source,
    snapshot: input.snapshot,
    status: "sent",
    answers: [],
    due_at: input.dueAt,
  }).select("*").single();
  // The partial unique index (one SENT copy per residency and form) makes a concurrent second send a no-op.
  if (error?.code === "23505") return { row: null, created: false };
  if (error || !data) throw new MoveInFormError("Could not send the form.", 500);
  return { row: data as unknown as MoveInFormRow, created: true };
}

/**
 * The form ids a residency already holds a live copy of: sent OR submitted. The unique index only
 * covers a SENT copy (so a manager can send a submitted form again as a fresh copy), which means
 * automatic sends must check this themselves or they would re-send every form a resident finished.
 */
async function liveFormIds(db: SupabaseClient, applicationId: string): Promise<Set<string>> {
  const { data, error } = await db.from(TABLE).select("form_id").eq("application_id", applicationId).neq("status", "cancelled");
  if (error) throw new MoveInFormError("Could not check the forms already sent.", 500);
  return new Set(((data ?? []) as { form_id: string }[]).map((row) => String(row.form_id)));
}

function dueFor(template: MoveInFormTemplate, residency: Residency): string | null {
  return moveInFormDueFor(template.due, { moveInDate: residency.moveInDate, leaseEnd: residency.leaseEnd });
}

/**
 * The lease template a residency is on, for matching a form's linked leases: the lease row's own
 * template (generated or lease-first), else the lease its application template maps to. Read lazily,
 * only when some form actually links to leases. Null = not known yet (no lease, no mapping).
 */
async function residencyLeaseTemplateId(db: SupabaseClient, property: PropertyFacts, residency: Residency): Promise<string | null> {
  const { data } = await db.from("portal_lease_pipeline_records")
    .select("generated:row_data->>leaseGenerationTemplateId,first:row_data->>leaseTemplateId,voided:row_data->>voidedAt")
    .eq("row_data->>axisId", residency.id);
  for (const lease of (data ?? []) as unknown as { generated: string | null; first: string | null; voided: string | null }[]) {
    if (lease.voided) continue;
    const id = (lease.generated || lease.first || "").trim();
    if (id) return id;
  }
  if (!residency.applicationTemplateId) return null;
  const mapped = await db.from("manager_property_records")
    .select("templates:property_data->listingSubmission->propertyApplicationTemplates")
    .eq("id", property.id).maybeSingle();
  for (const entry of Array.isArray((mapped.data as { templates?: unknown } | null)?.templates) ? ((mapped.data as { templates: unknown[] }).templates) : []) {
    const template = entry as { id?: unknown; linkedLeaseTemplateId?: unknown };
    if (template?.id === residency.applicationTemplateId && typeof template.linkedLeaseTemplateId === "string" && template.linkedLeaseTemplateId) {
      return template.linkedLeaseTemplateId;
    }
  }
  return null;
}

/** Whether a form's linked application and lease templates admit this residency (empty list = all). */
async function templateLinksAdmit(db: SupabaseClient, property: PropertyFacts, residency: Residency, template: MoveInFormTemplate): Promise<boolean> {
  if (!templateLinkMatches(template.linkedApplicationTemplateIds, residency.applicationTemplateId)) return false;
  const restrictedType = (template.leaseType ?? "all") !== "all";
  if (template.linkedLeaseTemplateIds.length === 0 && !restrictedType) return true;
  const leaseId = await residencyLeaseTemplateId(db, property, residency);
  if (!templateLinkMatches(template.linkedLeaseTemplateIds, leaseId)) return false;
  // Lease type: Long-term / Short-term forms go only to a signed lease of that type. The lease's own kind
  // decides; with no lease template known, the application's rental type does. An unknown is never guessed in.
  return templateLeaseTypeAdmits(
    template,
    moveInLeaseKindOf({ leaseTemplateKind: leaseId ? property.leaseKinds.get(leaseId) : null, rentalType: residency.rentalType }),
  );
}

/* --------------------------------------------------------------- dispatch */

/**
 * The login whose CONFIRMED email is this address, or null. An application submitted as a guest carries
 * whatever address was typed into it, so a notice to that address could reach a stranger. The in-portal
 * form is always created; only the notice waits for an address a person has proven they own.
 */
async function confirmedAccountFor(db: SupabaseClient, email: string): Promise<{ id: string; email: string } | null> {
  try {
    const wanted = email.trim().toLowerCase();
    if (!wanted) return null;
    const { data: profile } = await db.from("profiles").select("id").ilike("email", wanted.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
    const id = typeof profile?.id === "string" ? profile.id : "";
    if (!id) return null;
    const { data } = await db.auth.admin.getUserById(id);
    const user = data?.user;
    if (!user?.email_confirmed_at || (user.email ?? "").trim().toLowerCase() !== wanted) return null;
    return { id, email: wanted };
  } catch {
    return null;
  }
}

/** What one residency's dispatch did: forms sent, and sends that errored out. */
export type MoveInFormDispatchResult = { sent: number; failed: number };

/**
 * Sends every form whose trigger matches to a residency. Called from server events
 * (lease fully signed, application approved) with an id the SERVER read, never one from a
 * request body. Idempotent (a form the residency already has, waiting or submitted, is skipped),
 * best-effort, and never throws into its caller: a form that fails to go out must not break signing
 * a lease.
 *
 * Because nothing throws, the result carries `failed`: how many sends errored out. A caller that
 * owns a retry (the daily move-out sweep's day claim) needs to tell a quiet pass from a broken one,
 * which a `sent` of zero alone cannot say. A form skipped on purpose — already held, wrong room,
 * links that do not admit it, a PDF the manager never uploaded — is not a failure; a bucket or table
 * that could not be read is.
 */
export async function dispatchMoveInFormsForResidency(
  applicationId: string,
  trigger: Exclude<MoveInFormTrigger, "manual">,
  options: {
    secondaryMember?: boolean;
    db?: SupabaseClient;
    /** `before-move-out` only: days left on the lease. A form goes once its "N days before" has been reached. */
    daysUntilLeaseEnd?: number;
    /**
     * The manager (and property) a caller read from a stored row, when the application id itself came
     * from client-writable JSON (a lease's `axisId`). A residency owned by anyone else is skipped.
     */
    expect?: { managerUserId: string; propertyId?: string | null };
  } = {},
): Promise<MoveInFormDispatchResult> {
  try {
    const db = options.db ?? createSupabaseServiceRoleClient();
    const residency = await readResidency(db, applicationId);
    // An intake form goes out the moment an application is submitted; everything else waits for approval.
    const eligible = trigger === "application-submitted" ? residency?.inPlay : residency?.approved;
    if (!residency || !eligible || !residency.identity.property_id || !residency.identity.resident_email) return { sent: 0, failed: 0 };
    const property = await readProperty(db, residency.identity.property_id);
    if (!property) return { sent: 0, failed: 0 };
    // Automatic sends obey the same plan as the page: a Free owner's forms do not go out on their own.
    if (!managerSectionAllowedForTier("move-in", await getManagerPortalNavSubscriptionTier(property.ownerId))) return { sent: 0, failed: 0 };
    const expected = options.expect;
    if (expected) {
      const propertyId = (expected.propertyId ?? "").trim();
      if (
        residency.identity.manager_user_id !== expected.managerUserId ||
        property.ownerId !== expected.managerUserId ||
        (propertyId && residency.identity.property_id !== propertyId)
      ) return { sent: 0, failed: 0 };
    }
    // The property's actual owner, not a stale stamp on the application.
    const room = resolveRoom(property, residency);
    const dispatchable = property.templates.filter((template) =>
      template.trigger === trigger &&
      (trigger !== "before-move-out" ||
        (options.daysUntilLeaseEnd !== undefined && options.daysUntilLeaseEnd >= 0 && options.daysUntilLeaseEnd <= template.moveOutDaysBefore)) &&
      // A whole-house form is one per lease: the primary signer gets it, roommates do not.
      !(options.secondaryMember && template.audience.kind === "whole-house") &&
      templateAppliesToRoom(template, room.id));
    if (dispatchable.length === 0) return { sent: 0, failed: 0 };
    const cache: PdfCache = new Map();
    const already = await liveFormIds(db, residency.id);
    let sent = 0;
    let failed = 0;
    for (const template of dispatchable) {
      if (already.has(template.id)) continue;
      try {
        if (!(await templateLinksAdmit(db, property, residency, template))) continue;
        const snapshot = await buildSnapshot(db, template, property.ownerId, cache);
        if (!snapshot) continue;
        const result = await insertRow(db, {
          residency, ownerId: property.ownerId, roomLabel: room.label, template, snapshot,
          dueAt: dueFor(template, residency),
        });
        if (!result.created) continue;
        sent++;
        // The Intake form goes out when an application is SUBMITTED, possibly as a guest with an unproven
        // address: notify only an address that belongs to a confirmed login, addressed to that login.
        // Every other trigger follows a manager's decision about a known resident.
        const notice = trigger === "application-submitted"
          ? await confirmedAccountFor(db, result.row.resident_email)
          : { id: result.row.resident_user_id, email: result.row.resident_email };
        if (notice) {
          void emitMoveInFormEvent(db, { row: { ...result.row, resident_user_id: notice.id, resident_email: notice.email }, event: "sent" }).catch(() => undefined);
        }
      } catch (error) {
        failed++;
        console.error("[move-in-forms] dispatch failed for one form", error instanceof Error ? error.name : "unknown");
      }
    }
    return { sent, failed };
  } catch (error) {
    console.error("[move-in-forms] dispatch failed", error instanceof Error ? error.name : "unknown");
    return { sent: 0, failed: 1 };
  }
}

/**
 * The lease-signed seam: a lease names its primary signer's application (`axisId`) and any
 * joint members'. Those ids live in the lease's client-writable `row_data`, so the caller must
 * pass the manager and property the SERVER read from the lease row's own columns: a residency
 * owned by another manager (or on another property) is never dispatched to. With no manager
 * nothing is sent. Best-effort like the dispatch it wraps, so a caller can `void` it.
 */
export async function dispatchMoveInFormsForSignedLease(
  lease: { axisId?: string | null; jointLeaseMembers?: { applicationId?: string | null }[] | null },
  scope: { managerUserId?: string | null; propertyId?: string | null },
): Promise<void> {
  try {
    const managerUserId = (scope.managerUserId ?? "").trim();
    if (!managerUserId) return;
    const expect = { managerUserId, propertyId: scope.propertyId ?? null };
    const primary = lease.axisId?.trim();
    if (primary) await dispatchMoveInFormsForResidency(primary, "lease-signed", { expect });
    for (const member of lease.jointLeaseMembers ?? []) {
      const id = member?.applicationId?.trim();
      if (id && id !== primary) await dispatchMoveInFormsForResidency(id, "lease-signed", { secondaryMember: true, expect });
    }
  } catch {
    // Never break signing a lease.
  }
}

/**
 * Runs best-effort work after the response has gone out (Next's `after()`), so approving an
 * application or saving a lease never waits on template downloads and inserts. Outside a request
 * scope (a script, a unit test) `after` is unavailable and the work simply runs now.
 */
function afterResponse(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

export function dispatchMoveInFormsForResidencyAfterResponse(
  applicationId: string,
  trigger: Exclude<MoveInFormTrigger, "manual">,
): void {
  afterResponse(() => dispatchMoveInFormsForResidency(applicationId, trigger));
}

export function dispatchMoveInFormsForSignedLeaseAfterResponse(
  lease: Parameters<typeof dispatchMoveInFormsForSignedLease>[0],
  scope: Parameters<typeof dispatchMoveInFormsForSignedLease>[1],
): void {
  afterResponse(() => dispatchMoveInFormsForSignedLease(lease, scope));
}

/* ------------------------------------------------------------- manager API */

const sendSchema = z.object({
  applicationId: z.string().min(1).max(120),
  formId: z.string().regex(MOVE_IN_FORM_ID_PATTERN),
  dueAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const sendExistingSchema = z.object({
  propertyId: z.string().min(1).max(120),
  formId: z.string().regex(MOVE_IN_FORM_ID_PATTERN),
}).strict();

function requireManager(actor: MoveInFormActor): asserts actor is Extract<MoveInFormActor, { role: "manager" }> {
  if (actor.role !== "manager") throw new MoveInFormError("Form not found.", 404);
}

export async function listMoveInForms(
  actor: MoveInFormActor,
  filters: { status?: string; propertyId?: string; applicationId?: string } = {},
): Promise<{ forms: MoveInFormSummary[]; unread: number }> {
  const scope = await scopeFor(actor);
  const status = filters.status === "submitted" || filters.status === "sent" ? filters.status : undefined;
  // The filters run in the query, so a single record's tab never pays for the whole move-in history.
  // `unread` therefore counts within the same filters (the nav badge asks with none).
  const rows = (await scopedRows(actor, scope, {
    propertyId: filters.propertyId || undefined,
    applicationId: filters.applicationId || undefined,
    status,
    excludeCancelled: true,
  })).filter((row) => authorized(actor, scope, row) && row.status !== "cancelled");
  const unread = actor.role === "manager" ? rows.filter((row) => row.status === "submitted" && !row.manager_viewed_at).length : 0;
  const forms = rows
    .sort((a, b) => (b.submitted_at ?? b.sent_at).localeCompare(a.submitted_at ?? a.sent_at))
    .map((row) => toSummary(row, actor.role));
  return { forms, unread };
}

export async function moveInFormDetail(actor: MoveInFormActor, id: string): Promise<{ form: MoveInFormRecord }> {
  let row = await getRow(actor, id);
  if (actor.role === "resident" && row.status === "cancelled") throw new MoveInFormError("Form not found.", 404);
  // Opening a submission is what clears it from the sidebar's unread count.
  if (actor.role === "manager" && row.status === "submitted" && !row.manager_viewed_at) {
    const { data } = await actor.context.db.from(TABLE).update({ manager_viewed_at: new Date().toISOString() })
      .eq("id", row.id).is("manager_viewed_at", null).select("*").maybeSingle();
    if (data) row = data as unknown as MoveInFormRow;
  }
  return { form: toRecord(row, actor.role) };
}

export async function sendMoveInForm(actor: MoveInFormActor, raw: unknown): Promise<{ form: MoveInFormSummary }> {
  requireManager(actor);
  const input = sendSchema.parse(raw);
  const { residency, property, template, room } = await prepareSend(actor, input.applicationId, input.formId);
  const cache: PdfCache = new Map();
  const snapshot = await buildSnapshot(actor.context.db, template, property.ownerId, cache);
  if (!snapshot) throw new MoveInFormError("This form is not ready to send. Finish its questions, add a signature, and upload its PDF first.", 409);
  const auditKey = await audit(actor, "send", { application_id: residency.id, form_id: template.id });
  const result = await insertRow(actor.context.db, {
    residency, ownerId: property.ownerId, roomLabel: room.label, template, snapshot,
    dueAt: input.dueAt ?? dueFor(template, residency),
  });
  await updateAuditResult(actor.context, auditKey, { status: result.created ? "success" : "duplicate", form_id: result.row?.id ?? null });
  // Only a copy still waiting on the resident blocks this; a submitted one stays as history and the form goes out again.
  if (!result.created) throw new MoveInFormError("This resident already has this form waiting for them.", 409);
  track("move_in_form_sent", actor.context.userId, { form_id: template.id, trigger: "manual" });
  void emitMoveInFormEvent(actor.context.db, { row: result.row, event: "sent" }).catch(() => undefined);
  return { form: toSummary(result.row, "manager") };
}

/** Loads and authorizes a residency + the template to send, re-deriving every id server-side. */
async function prepareSend(actor: Extract<MoveInFormActor, { role: "manager" }>, applicationId: string, formId: string) {
  const db = actor.context.db;
  const scope = await scopeFor(actor, "edit");
  const residency = await readResidency(db, applicationId);
  if (!residency || !authorized(actor, scope, residency.identity)) throw new MoveInFormError("Residency not found.", 404);
  if (!residency.approved || !residency.identity.property_id || !residency.identity.resident_email) {
    throw new MoveInFormError("Choose an approved resident with a property placement.");
  }
  const property = await readProperty(db, residency.identity.property_id);
  if (!property) throw new MoveInFormError("The resident's property could not be found.");
  // Re-check against the property's actual owner, not the application's stamp.
  if (!authorized(actor, scope, { ...residency.identity, manager_user_id: property.ownerId })) throw new MoveInFormError("Residency not found.", 404);
  const template = property.templates.find((item) => item.id === formId);
  if (!template) throw new MoveInFormError("Form not found.", 404);
  return { residency, property, template, room: resolveRoom(property, residency) };
}

export async function sendMoveInFormToCurrentResidents(actor: MoveInFormActor, raw: unknown): Promise<{ sent: number }> {
  requireManager(actor);
  const input = sendExistingSchema.parse(raw);
  const db = actor.context.db;
  const scope = await scopeFor(actor, "edit");
  const property = await readProperty(db, input.propertyId);
  if (!property || !authorized(actor, scope, { resident_email: "", manager_user_id: property.ownerId, property_id: property.id })) {
    throw new MoveInFormError("Property not found.", 404);
  }
  const template = property.templates.find((item) => item.id === input.formId);
  if (!template) throw new MoveInFormError("Form not found.", 404);
  // The snapshot depends on the form and the property, never on the resident: build it once, before
  // anything is inserted, so an unfinished form fails the whole send instead of half of it.
  const snapshot = await buildSnapshot(db, template, property.ownerId);
  if (!snapshot) throw new MoveInFormError("This form is not ready to send. Finish its questions, add a signature, and upload its PDF first.", 409);
  const { data: leases, error } = await db.from("portal_lease_pipeline_records")
    .select("axis_id:row_data->>axisId,signed:row_data->>fullySignedAt,voided:row_data->>voidedAt,members:row_data->jointLeaseMembers")
    .eq("manager_user_id", property.ownerId).eq("property_id", property.id);
  if (error) throw new MoveInFormError("Could not load the property's leases.", 500);
  const applicationIds = new Map<string, boolean>();
  for (const lease of (leases ?? []) as unknown as { axis_id: string | null; signed: string | null; voided: string | null; members: unknown }[]) {
    if (!lease.signed || lease.voided) continue;
    if (lease.axis_id) applicationIds.set(lease.axis_id, false);
    if (Array.isArray(lease.members)) {
      for (const member of lease.members as { applicationId?: unknown }[]) {
        if (typeof member?.applicationId === "string" && member.applicationId && !applicationIds.has(member.applicationId)) applicationIds.set(member.applicationId, true);
      }
    }
  }
  const auditKey = await audit(actor, "send_existing", { property_id: property.id, form_id: template.id });
  let sent = 0;
  for (const [applicationId, secondary] of applicationIds) {
    const residency = await readResidency(db, applicationId);
    if (!residency?.approved || residency.identity.property_id !== property.id || !residency.identity.resident_email) continue;
    // "Send to current residents" never repeats a form a resident already holds or finished.
    if ((await liveFormIds(db, applicationId)).has(template.id)) continue;
    if (secondary && template.audience.kind === "whole-house") continue;
    const room = resolveRoom(property, residency);
    if (!templateAppliesToRoom(template, room.id)) continue;
    if (!(await templateLinksAdmit(db, property, residency, template))) continue;
    const result = await insertRow(db, {
      residency, ownerId: property.ownerId, roomLabel: room.label, template, snapshot,
      dueAt: dueFor(template, residency),
    });
    if (!result.created) continue;
    sent++;
    void emitMoveInFormEvent(db, { row: result.row, event: "sent" }).catch(() => undefined);
  }
  await updateAuditResult(actor.context, auditKey, { status: "success", sent });
  return { sent };
}

export async function remindMoveInForm(actor: MoveInFormActor, id: string): Promise<{ ok: true }> {
  requireManager(actor);
  const row = await getRow(actor, id, "edit");
  if (row.status !== "sent") throw new MoveInFormError("Only a form still waiting on the resident can be reminded.", 409);
  if (row.reminded_at && Date.now() - new Date(row.reminded_at).getTime() < REMIND_COOLDOWN_MS) {
    throw new MoveInFormError("A reminder was just sent. Try again in a few minutes.", 409);
  }
  const auditKey = await audit(actor, "remind", { form_record_id: row.id });
  const now = new Date().toISOString();
  const { data, error } = await actor.context.db.from(TABLE).update({ reminded_at: now, updated_at: now })
    .eq("id", row.id).eq("status", "sent").select("*").maybeSingle();
  await updateAuditResult(actor.context, auditKey, { status: error || !data ? "failed" : "success" });
  if (error) throw new MoveInFormError("Could not send the reminder.", 500);
  if (!data) throw new MoveInFormError("This form is no longer waiting on the resident.", 409);
  // The row is stamped first, so a delivery failure never re-sends on retry; the inbox is the record.
  await emitMoveInFormEvent(actor.context.db, { row: data as unknown as MoveInFormRow, event: "reminder", nonce: now }).catch(() => undefined);
  return { ok: true };
}

const editSchema = z.object({
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  blocks: z.enum(MOVE_IN_FORM_BLOCKS as unknown as [string, ...string[]]).optional(),
  questions: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
}).strict();

/**
 * A manager edits a form still waiting on the resident: due date, what it blocks, and its questions.
 * Scope is re-derived from the authenticated manager (never a body id), the write is a compare-and-swap
 * on `status = 'sent'`, and a submitted or cancelled copy is locked (409).
 */
export async function editMoveInForm(actor: MoveInFormActor, id: string, raw: unknown): Promise<{ form: MoveInFormRecord }> {
  requireManager(actor);
  const input = editSchema.parse(raw);
  const row = await getRow(actor, id, "edit");
  if (row.status !== "sent") throw new MoveInFormError("Only a form still waiting on the resident can be edited.", 409);
  const previousQuestions = questionsOf(row);
  const snapshot: MoveInFormRow["snapshot"] = { ...row.snapshot, questions: previousQuestions };
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.blocks) snapshot.blocks = input.blocks as MoveInFormRecord["snapshot"]["blocks"];
  if (input.dueAt !== undefined) patch.due_at = input.dueAt;
  let removedQuestions: MoveInFormQuestion[] = [];
  if (input.questions) {
    const questions = normalizeMoveInFormQuestions(input.questions);
    if (questions.length === 0 && row.source !== "upload") throw new MoveInFormError("A form needs at least one question.", 400);
    if (row.source === "upload" && !questions.some((question) => question.type === "signature")) {
      throw new MoveInFormError("An uploaded form needs a signature question.", 400);
    }
    snapshot.questions = questions;
    // A draft answer to a question that no longer exists is dropped, never kept hidden.
    const keys = new Set(questions.map((question) => question.key));
    patch.answers = (Array.isArray(row.answers) ? row.answers : []).filter((answer) => keys.has(answer.key));
    removedQuestions = previousQuestions.filter((question) => !keys.has(question.key));
  }
  patch.snapshot = snapshot;
  const auditKey = await audit(actor, "edit", { form_record_id: row.id, fields: Object.keys(input) });
  // Compare-and-swap on the row as it was READ (`updated_at`), not just its status: a resident's draft
  // save between this read and the write stamps `updated_at`, and the edit's `answers` filter / snapshot
  // were computed from the older row, so it must lose rather than overwrite the resident's save.
  const { data, error } = await actor.context.db.from(TABLE).update(patch)
    .eq("id", row.id).eq("status", "sent").eq("updated_at", row.updated_at).select("*").maybeSingle();
  await updateAuditResult(actor.context, auditKey, { status: error || !data ? "failed" : "success" });
  if (error) throw new MoveInFormError("Could not save the form.", 500);
  if (!data) {
    // Lost the swap: the resident submitted (locked), the form was cancelled, or the resident just saved
    // a draft (reopen and retry). Each refusal names what actually happened — a cancel race used to be
    // reported as a submission.
    const { data: now } = await actor.context.db.from(TABLE).select("status").eq("id", row.id).maybeSingle();
    const status = (now as { status?: string } | null)?.status;
    if (status === "sent") {
      throw new MoveInFormError("The resident just saved; reopen and try again", 409);
    }
    if (status === "cancelled") {
      throw new MoveInFormError("This form was cancelled, so it can no longer be edited.", 409);
    }
    throw new MoveInFormError("This form was already submitted, so it is locked.", 409);
  }
  // Dropping a question drops its answer, so the photo or signature the resident already uploaded for
  // it is now unreferenced. Only the REMOVED questions' prefixes are swept: a surviving question's
  // object may have been uploaded seconds ago and not yet be in a saved draft answer, and deleting it
  // here would break the resident's own submit.
  if (removedQuestions.length > 0) {
    await pruneUnreferencedFiles(
      actor.context.db.storage.from(MOVE_IN_FORM_FILES_BUCKET),
      row.id,
      removedQuestions,
      [],
    ).catch(() => undefined);
  }
  return { form: toRecord(data as unknown as MoveInFormRow, "manager") };
}

export async function cancelMoveInForm(actor: MoveInFormActor, id: string): Promise<{ ok: true }> {
  requireManager(actor);
  const row = await getRow(actor, id, "edit");
  if (row.status === "cancelled") return { ok: true };
  if (row.status !== "sent") throw new MoveInFormError("A submitted form is locked and cannot be cancelled.", 409);
  const auditKey = await audit(actor, "cancel", { form_record_id: row.id });
  const { data, error } = await actor.context.db.from(TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "sent").select("id").maybeSingle();
  await updateAuditResult(actor.context, auditKey, { status: error || !data ? "failed" : "success" });
  if (error) throw new MoveInFormError("Could not cancel the form.", 500);
  if (!data) throw new MoveInFormError("A submitted form is locked and cannot be cancelled.", 409);
  return { ok: true };
}

/* ------------------------------------------------------------ answers */

const answerKey = z.string().regex(KEY_PATTERN);
const answerSchema = z.union([
  z.object({
    key: answerKey,
    value: z.union([z.string().max(5000), z.array(z.string().max(200)).max(60), z.number().finite(), z.boolean(), z.null()]),
  }).strict(),
  z.object({ key: answerKey, files: z.array(z.string().max(300)).max(MAX_FILES_PER_QUESTION) }).strict(),
  z.object({
    key: answerKey,
    signature: z.object({ storagePath: z.string().max(300), signedName: z.string().max(120), signedAt: z.string().max(40) }).strict(),
  }).strict(),
]);
const answersBody = z.object({ answers: z.array(answerSchema).max(100) }).strict();

function conditionValue(answer: MoveInFormAnswer | undefined): string {
  if (!answer || !("value" in answer)) return "";
  const value = answer.value;
  if (value === true) return "yes";
  if (value === false) return "no";
  if (Array.isArray(value)) return JSON.stringify(value);
  return value == null ? "" : String(value);
}

function isHidden(question: MoveInFormQuestion, byKey: Map<string, MoveInFormAnswer>): boolean {
  const asAnswers = [...byKey.values()].map((answer) => ({ key: answer.key, label: "", type: "text", value: conditionValue(answer) })) as RentalCustomFieldAnswer[];
  return isCustomFieldHiddenByCondition(question as unknown as ManagerCustomApplicationField, asAnswers);
}

const isFileQuestion = (question: MoveInFormQuestion) => question.type === "photos" || question.type === "file";

function fail(message: string): never {
  throw new MoveInFormError(message, 400);
}

function pathBelongsToRecord(path: string, recordId: string, key: string): boolean {
  return FILE_PATH_PATTERN.test(path) && path.startsWith(`${recordId}/${key}/`);
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function checkValue(question: MoveInFormQuestion, value: unknown): void {
  const label = question.label;
  const str = (max = 500) => {
    if (typeof value !== "string") fail(`${label} needs a text answer.`);
    if (value.length > max) fail(`${label} is too long.`);
    return value.trim();
  };
  switch (question.type) {
    case "text": case "initials": str(); return;
    case "long_text": str(5000); return;
    case "email": { const email = str(); if (email && !isLegitimateEmail(email)) fail(`${label} needs a valid email.`); return; }
    case "phone": { const phone = str(); if (phone && !isCompletePhoneNumber(phone)) fail(`${label} needs a complete phone number.`); return; }
    case "date": { const date = str(); if (date && !validDate(date)) fail(`${label} needs a valid date.`); return; }
    case "number": case "currency": {
      if (typeof value === "number") return;
      const text = str();
      if (text && !Number.isFinite(Number(text))) fail(`${label} needs a number.`);
      return;
    }
    case "yes_no":
      if (value === true || value === false || value === "yes" || value === "no" || value === "") return;
      fail(`${label} needs a yes or no.`);
      return;
    case "checkbox":
      if (value === true || value === false || value === "yes" || value === "no" || value === "") return;
      fail(`${label} needs to be checked or not.`);
      return;
    case "select": {
      const choice = str();
      if (choice && !question.options.includes(choice)) fail(`Choose one of the listed options for ${label}.`);
      return;
    }
    case "multi_select": {
      if (!Array.isArray(value)) fail(`${label} needs a list of choices.`);
      if (value.some((entry) => !question.options.includes(entry))) fail(`Choose only the listed options for ${label}.`);
      return;
    }
    default:
      fail(`${label} cannot take a typed answer.`);
  }
}

function valueIsBlank(question: MoveInFormQuestion, value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  if (question.type === "checkbox") return value !== true && value !== "yes";
  return false;
}

/**
 * Validates an answer set against the SNAPSHOT the resident was sent. Unknown keys, wrong
 * shapes, off-list options and files outside this record's prefix are refused; a question
 * hidden by its `showIf` is neither required nor kept. A draft skips required-ness only.
 */
export function checkMoveInFormAnswers(
  recordId: string,
  questions: MoveInFormQuestion[],
  raw: unknown,
  mode: "draft" | "submit",
  now = new Date().toISOString(),
): MoveInFormAnswer[] {
  const { answers } = answersBody.parse({ answers: raw });
  const byKey = new Map<string, MoveInFormAnswer>();
  const known = new Map(questions.map((question) => [question.key, question]));
  for (const answer of answers as MoveInFormAnswer[]) {
    if (!known.has(answer.key)) fail("That form does not ask one of these questions.");
    if (byKey.has(answer.key)) fail("Each question can only be answered once.");
    byKey.set(answer.key, answer);
  }
  const accepted: MoveInFormAnswer[] = [];
  for (const question of questions) {
    const answer = byKey.get(question.key);
    if (isHidden(question, byKey)) continue;
    if (!answer) {
      if (mode === "submit" && question.required) fail(`${question.label} is required.`);
      continue;
    }
    if (question.type === "signature") {
      if (!("signature" in answer)) fail(`${question.label} needs a signature.`);
      const { signature } = answer;
      if (!pathBelongsToRecord(signature.storagePath, recordId, question.key)) fail("The signature file does not belong to this form.");
      const signedName = signature.signedName.trim();
      if (!signedName) fail(`${question.label} needs your typed name.`);
      accepted.push({ key: question.key, signature: { storagePath: signature.storagePath, signedName, signedAt: now } });
      continue;
    }
    if (isFileQuestion(question)) {
      if (!("files" in answer)) fail(`${question.label} needs an uploaded file.`);
      const files = [...new Set(answer.files)];
      if (files.some((path) => !pathBelongsToRecord(path, recordId, question.key))) fail("A file does not belong to this form.");
      if (mode === "submit" && question.required && files.length === 0) fail(`${question.label} is required.`);
      if (files.length) accepted.push({ key: question.key, files });
      continue;
    }
    if (!("value" in answer)) fail(`${question.label} needs a typed answer.`);
    if (valueIsBlank(question, answer.value)) {
      if (mode === "submit" && question.required) fail(`${question.label} is required.`);
      continue;
    }
    checkValue(question, answer.value);
    accepted.push({ key: question.key, value: typeof answer.value === "string" ? answer.value.trim() : answer.value });
  }
  // A required signature must be present on submit even if the loop above `continue`d past it.
  if (mode === "submit") {
    for (const question of questions) {
      if (question.type === "signature" && question.required && !isHidden(question, byKey) && !accepted.some((answer) => answer.key === question.key)) {
        fail(`${question.label} is required.`);
      }
    }
  }
  return accepted;
}

/* ------------------------------------------------------------ resident API */

function requireResident(actor: MoveInFormActor): asserts actor is Extract<MoveInFormActor, { role: "resident" }> {
  if (actor.role !== "resident") throw new MoveInFormError("Form not found.", 404);
}

async function getOpenResidentRow(actor: MoveInFormActor, id: string): Promise<MoveInFormRow> {
  requireResident(actor);
  const row = await getRow(actor, id, "edit");
  if (row.status !== "sent") throw new MoveInFormError(row.status === "submitted" ? "This form was already submitted." : "This form is no longer open.", 409);
  return row;
}

export async function saveMoveInFormDraft(actor: MoveInFormActor, id: string, raw: unknown): Promise<{ form: MoveInFormRecord }> {
  const row = await getOpenResidentRow(actor, id);
  const answers = checkMoveInFormAnswers(row.id, questionsOf(row), (raw as { answers?: unknown } | null)?.answers, "draft");
  const { data, error } = await actor.context.db.from(TABLE).update({ answers, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("status", "sent").select("*").maybeSingle();
  if (error) throw new MoveInFormError("Could not save your answers.", 500);
  if (!data) throw new MoveInFormError("This form was already submitted.", 409);
  return { form: toRecord(data as unknown as MoveInFormRow, "resident") };
}

/** Re-encodes an upload (strips metadata, bounds size); the declared type is never trusted. */
async function normalizeImage(file: File, kind: "photo" | "signature"): Promise<{ bytes: Buffer; contentType: string; ext: "jpg" | "png" }> {
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new MoveInFormError("Choose an image smaller than 4.5 MB.");
  const source = Buffer.from(await file.arrayBuffer());
  try {
    const metadata = await sharp(source, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png", "webp", "heif"].includes(metadata.format ?? "")) throw new Error("unsupported image");
    const pipeline = sharp(source, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true });
    return kind === "signature"
      ? { bytes: await pipeline.png().toBuffer(), contentType: "image/png", ext: "png" }
      : { bytes: await pipeline.jpeg({ quality: 85 }).toBuffer(), contentType: "image/jpeg", ext: "jpg" };
  } catch {
    throw new MoveInFormError("Choose a valid JPEG, PNG or WebP image.");
  }
}

export async function uploadMoveInFormFile(actor: MoveInFormActor, id: string, questionKey: string, file: File): Promise<{ storagePath: string }> {
  const row = await getOpenResidentRow(actor, id);
  if (!KEY_PATTERN.test(questionKey)) throw new MoveInFormError("That form does not ask this question.");
  const question = questionsOf(row).find((item) => item.key === questionKey);
  if (!question || !(isFileQuestion(question) || question.type === "signature")) throw new MoveInFormError("That question does not take a file.");
  const storage = actor.context.db.storage.from(MOVE_IN_FORM_FILES_BUCKET);
  // Caps come from what is really stored, not from what a draft happens to reference.
  const { data: forQuestion, error: listError } = await storage.list(`${row.id}/${questionKey}`, { limit: 100 });
  if (listError) throw new MoveInFormError("Could not upload the file.", 500);
  if ((forQuestion ?? []).length >= (question.type === "signature" ? MAX_SIGNATURES_PER_QUESTION : MAX_FILES_PER_QUESTION)) throw new MoveInFormError("This question has reached its file limit.");
  if ((await countStored(storage, row.id, questionsOf(row))) >= MAX_FILES_PER_FORM) throw new MoveInFormError("This form has reached its file limit.");
  const image = await normalizeImage(file, question.type === "signature" ? "signature" : "photo");
  const path = `${row.id}/${questionKey}/${randomUUID()}.${image.ext}`;
  const { error } = await storage.upload(path, image.bytes, { contentType: image.contentType, cacheControl: "31536000", upsert: false });
  if (error) throw new MoveInFormError("Could not upload the file.", 500);
  return { storagePath: path };
}

/**
 * A resident removes a file they uploaded (a photo taken out, a signature redone). Only while the
 * form is still open, and only a path inside this record's own prefix; anything else is a 404.
 */
export async function deleteMoveInFormFile(actor: MoveInFormActor, id: string, path: string): Promise<{ ok: true }> {
  const row = await getOpenResidentRow(actor, id);
  const key = path.split("/")[1] ?? "";
  if (!pathBelongsToRecord(path, row.id, key) || !questionsOf(row).some((question) => question.key === key)) {
    throw new MoveInFormError("File not found.", 404);
  }
  const { error } = await actor.context.db.storage.from(MOVE_IN_FORM_FILES_BUCKET).remove([path]);
  if (error) throw new MoveInFormError("Could not remove the file.", 500);
  return { ok: true };
}

/** After a submit: drop stored objects under the record that the final answers no longer reference. */
async function pruneUnreferencedFiles(
  storage: ReturnType<SupabaseClient["storage"]["from"]>,
  recordId: string,
  questions: MoveInFormQuestion[],
  answers: MoveInFormAnswer[],
): Promise<void> {
  const keep = new Set(answers.flatMap((answer) => "files" in answer ? answer.files : "signature" in answer ? [answer.signature.storagePath] : []));
  const doomed: string[] = [];
  for (const question of questions) {
    if (!(isFileQuestion(question) || question.type === "signature")) continue;
    const { data } = await storage.list(`${recordId}/${question.key}`, { limit: 100 });
    for (const entry of data ?? []) {
      const path = `${recordId}/${question.key}/${entry.name}`;
      if (!keep.has(path)) doomed.push(path);
    }
  }
  if (doomed.length) await storage.remove(doomed);
}

async function countStored(storage: ReturnType<SupabaseClient["storage"]["from"]>, recordId: string, questions: MoveInFormQuestion[]): Promise<number> {
  let total = 0;
  for (const question of questions) {
    if (!(isFileQuestion(question) || question.type === "signature")) continue;
    const { data } = await storage.list(`${recordId}/${question.key}`, { limit: 100 });
    total += (data ?? []).length;
  }
  return total;
}

export async function submitMoveInForm(actor: MoveInFormActor, id: string, raw: unknown): Promise<{ form: MoveInFormRecord }> {
  requireResident(actor);
  const row = await getOpenResidentRow(actor, id);
  const questions = questionsOf(row);
  const answers = checkMoveInFormAnswers(row.id, questions, (raw as { answers?: unknown } | null)?.answers, "submit");
  const db = actor.context.db;
  const storage = db.storage.from(MOVE_IN_FORM_FILES_BUCKET);
  // Every referenced file must actually be stored: a path in a body proves nothing.
  const referenced = answers.flatMap((answer) => "files" in answer ? answer.files : "signature" in answer ? [answer.signature.storagePath] : []);
  for (const key of new Set(referenced.map((path) => path.split("/")[1]!))) {
    const { data, error } = await storage.list(`${row.id}/${key}`, { limit: 100 });
    if (error) throw new MoveInFormError("Could not check your uploads. Please try again.", 500);
    const names = new Set((data ?? []).map((entry) => entry.name));
    if (referenced.filter((path) => path.split("/")[1] === key).some((path) => !names.has(path.split("/")[2]!))) {
      throw new MoveInFormError("One of your uploads is missing. Add it again.");
    }
  }
  let signedDocumentSha256: string | null = null;
  if (row.source === "upload") {
    const pdf = row.snapshot.pdf;
    if (!pdf || !pdfPathTrusted(pdf.storagePath, row.manager_user_id, row.form_id)) throw new MoveInFormError("The document for this form is unavailable.", 409);
    const { data, error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).download(pdf.storagePath);
    if (error || !data) throw new MoveInFormError("The document for this form is unavailable.", 409);
    signedDocumentSha256 = sha256(new Uint8Array(await data.arrayBuffer()));
    // The resident signs the exact bytes they were sent; a changed file voids that.
    if (signedDocumentSha256 !== pdf.sha256) throw new MoveInFormError("The document changed after it was sent. Ask your property manager to resend it.", 409);
    if (!answers.some((answer) => "signature" in answer)) throw new MoveInFormError("Sign the document before submitting.");
  }
  const auditKey = await audit(actor, "submit", { form_record_id: row.id, form_id: row.form_id });
  const now = new Date().toISOString();
  const { data, error } = await db.from(TABLE).update({
    answers, status: "submitted", submitted_at: now, updated_at: now, signed_document_sha256: signedDocumentSha256,
  }).eq("id", row.id).eq("status", "sent").select("*").maybeSingle();
  await updateAuditResult(actor.context, auditKey, { status: error || !data ? "failed" : "success" });
  if (error) throw new MoveInFormError("Could not submit the form.", 500);
  // A concurrent second submit loses the compare-and-swap above.
  if (!data) throw new MoveInFormError("This form was already submitted.", 409);
  const saved = data as unknown as MoveInFormRow;
  track("move_in_form_submitted", actor.context.userId, { form_id: row.form_id });
  // A manager's linked-form rule may have been waiting on exactly this form (best-effort, never fails the submit).
  void completeOpenLinkedFormRequestByForm(db, {
    applicationId: row.application_id,
    formKind: "move_in",
    formId: row.form_id,
    filledByUserId: actor.context.userId,
    submissionRef: row.id,
  });
  // Uploads the final answers no longer reference (photos taken out, a signature redone) are dead weight.
  await pruneUnreferencedFiles(storage, row.id, questions, answers).catch(() => undefined);
  await notifyManagerOfSubmission(saved, db);
  return { form: toRecord(saved, "resident") };
}

/**
 * The property's "Tell me when a resident submits" choice: nothing, an Assistant notice, or an Assistant
 * notice plus an email to the manager. Runs on the service client (the row is already saved), and each
 * leg is best-effort on its own so a mail failure never hides the in-app notice.
 */
async function notifyManagerOfSubmission(row: MoveInFormRow, db: SupabaseClient): Promise<void> {
  try {
    const property = await readProperty(db, row.property_id);
    const choice = property?.settings.notifyOnSubmit ?? "assistant";
    if (choice === "none") return;
    await emitMoveInFormEvent(db, { row, event: "submitted" }).catch(() => undefined);
    if (choice === "assistant-and-email") await emailManagerOfMoveInFormSubmission(db, row).catch(() => undefined);
  } catch {
    // Best-effort: the submission is saved above.
  }
}

/* ------------------------------------------------------------------ files */

/** A short-lived signed URL, only after the path is proven to belong to this record. */
export async function moveInFormFileUrl(actor: MoveInFormActor, id: string, path: string): Promise<string> {
  const row = await getRow(actor, id);
  if (!pathBelongsToRecord(path, row.id, path.split("/")[1] ?? "")) throw new MoveInFormError("File not found.", 404);
  if (actor.role === "manager") {
    // A manager only ever sees what was actually submitted into the record.
    const referenced = (Array.isArray(row.answers) ? row.answers : []).some((answer) =>
      ("files" in answer && answer.files.includes(path)) || ("signature" in answer && answer.signature.storagePath === path));
    if (!referenced) throw new MoveInFormError("File not found.", 404);
  }
  const { data, error } = await actor.context.db.storage.from(MOVE_IN_FORM_FILES_BUCKET).createSignedUrl(path, FILE_URL_SECONDS);
  if (error || !data?.signedUrl) throw new MoveInFormError("File not found.", 404);
  return data.signedUrl;
}

/** The PDF in a record's snapshot, for the resident it was sent to or the manager who owns it. */
export async function moveInFormRecordPdf(actor: MoveInFormActor, id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = await getRow(actor, id);
  const pdf = row.snapshot?.pdf;
  if (!pdf || !pdfPathTrusted(pdf.storagePath, row.manager_user_id, row.form_id)) throw new MoveInFormError("File not found.", 404);
  const { data, error } = await actor.context.db.storage.from(LEASE_TEMPLATE_BUCKET).download(pdf.storagePath);
  if (error || !data) throw new MoveInFormError("File not found.", 404);
  return { bytes: new Uint8Array(await data.arrayBuffer()), fileName: pdf.fileName };
}

/** Owner-scoped read of the uploaded original for the builder's preview. */
export async function moveInFormTemplatePdf(actor: MoveInFormActor, propertyId: string, formId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  requireManager(actor);
  if (!MOVE_IN_FORM_ID_PATTERN.test(formId)) throw new MoveInFormError("File not found.", 404);
  const scope = await scopeFor(actor);
  const property = await readProperty(actor.context.db, propertyId);
  if (!property || !authorized(actor, scope, { resident_email: "", manager_user_id: property.ownerId, property_id: property.id })) throw new MoveInFormError("File not found.", 404);
  const pdf = property.templates.find((item) => item.id === formId)?.pdf;
  if (!pdf || !pdfPathTrusted(pdf.storagePath, property.ownerId, formId)) throw new MoveInFormError("File not found.", 404);
  const { data, error } = await actor.context.db.storage.from(LEASE_TEMPLATE_BUCKET).download(pdf.storagePath);
  if (error || !data) throw new MoveInFormError("File not found.", 404);
  return { bytes: new Uint8Array(await data.arrayBuffer()), fileName: pdf.fileName };
}

/** Upload a form's PDF original. Same hardening as the application import: magic bytes, 8 MB, rate limit. */
export async function uploadMoveInFormTemplatePdf(
  actor: MoveInFormActor,
  input: { propertyId: string; formId: string; file: File },
): Promise<{ pdf: NonNullable<MoveInFormTemplate["pdf"]> }> {
  requireManager(actor);
  if (!MOVE_IN_FORM_ID_PATTERN.test(input.formId)) throw new MoveInFormError("Invalid form id.");
  if (!(await rateLimit(`move-in-form-pdf:${actor.context.userId}`, 8, 60_000)).ok) throw new MoveInFormError("Too many uploads. Try again shortly.", 429);
  const { file } = input;
  if (file.type !== "application/pdf" || file.size < 8 || file.size > LEASE_TEMPLATE_MAX_BYTES) throw new MoveInFormError("Upload a PDF between 8 bytes and 8 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder("latin1").decode(bytes.slice(0, 1024)).includes("%PDF-")) throw new MoveInFormError("That file is not a PDF.");
  const db = actor.context.db;
  const scope = await scopeFor(actor, "edit");
  const property = await readProperty(db, input.propertyId);
  if (!property || !authorized(actor, scope, { resident_email: "", manager_user_id: property.ownerId, property_id: property.id })) {
    throw new MoveInFormError("Property not found.", 404);
  }
  // Only the property's owner stores originals under their own prefix. A co-manager who can edit the
  // form still sees the real reason rather than a missing property.
  if (property.ownerId !== actor.context.userId) {
    throw new MoveInFormError("Only the property owner can upload the form's PDF.", 403);
  }
  let pageCount: number;
  try { pageCount = (await PDFDocument.load(bytes)).getPageCount(); }
  catch { throw new MoveInFormError("Could not read that PDF. Upload a different file.", 422); }
  if (pageCount < 1 || pageCount > 100) throw new MoveInFormError("Upload a PDF between 1 and 100 pages.");
  const path = `${property.ownerId}/move-in-forms/${input.formId}/${Date.now()}-${randomUUID()}.pdf`;
  const { error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).upload(path, bytes, { contentType: "application/pdf", cacheControl: "0", upsert: false });
  if (error) throw new MoveInFormError("Could not securely store the PDF.", 502);
  const fileName = file.name.replace(/[^\w .()-]/g, "_").slice(0, 120) || "form.pdf";
  return { pdf: { storagePath: path, fileName, pageCount, sha256: sha256(bytes) } };
}

/* ----------------------------------------------- for the filled-form PDF */

export async function getMoveInFormForExport(actor: MoveInFormActor, id: string): Promise<MoveInFormRecord> {
  const row = await getRow(actor, id);
  return toRecord(row, actor.role);
}
