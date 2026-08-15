import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { isResidentSetupTokenValid } from "@/lib/auth/resident-setup-token";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { APPLICATION_DOCUMENTS_BUCKET } from "@/lib/rental-application/application-photos";
import type { ApplicationPhotoSlot } from "@/lib/rental-application/types";

export { APPLICATION_DOCUMENTS_BUCKET };

/**
 * Server-only helpers for the applicant photo bucket. The authorization
 * predicate ({@link canActorAccessApplicationPhoto}) is a pure function so the
 * cross-manager isolation boundary can be proven without a live database — see
 * `tests/unit/application-photo-access.test.ts`. All Storage access runs through
 * the service-role client inside the API routes; nothing here trusts an owner id
 * supplied by the client.
 */

type ServiceClient = SupabaseClient;

/** Ownership facts read from the stored application row (never from the client). */
export type StoredApplicationOwnership = {
  managerUserId: string | null;
  propertyId: string | null;
  assignedPropertyId: string | null;
  residentEmail: string | null;
};

/**
 * Who is asking. `manager` carries the exact set of property ids they may reach
 * today (own + co-manager-linked). `resident`/`guest` carry an email that must
 * match the application's stored applicant email. Reads never accept `guest`.
 */
export type ApplicationPhotoActor =
  | { kind: "admin" }
  | { kind: "manager"; userId: string; accessiblePropertyIds: ReadonlySet<string> }
  | { kind: "resident"; email: string }
  | { kind: "guest"; email: string };

const norm = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * The single security decision: may this actor touch this application's photos?
 * Mirrors `fetchApplicationsForManagerUser` — a manager is in only when the
 * application is attributed to them OR its property is one they can reach today.
 * This is what stops manager B from reading manager A's applicant's ID photo.
 */
export function canActorAccessApplicationPhoto(
  actor: ApplicationPhotoActor,
  app: StoredApplicationOwnership,
): boolean {
  if (actor.kind === "admin") return true;

  if (actor.kind === "resident" || actor.kind === "guest") {
    const applicantEmail = norm(app.residentEmail);
    return applicantEmail.length > 0 && applicantEmail === norm(actor.email);
  }

  // manager / owner / pro
  if (app.managerUserId && app.managerUserId === actor.userId) return true;
  const propertyId = (app.propertyId ?? "").trim();
  const assignedPropertyId = (app.assignedPropertyId ?? "").trim();
  if (propertyId && actor.accessiblePropertyIds.has(propertyId)) return true;
  if (assignedPropertyId && actor.accessiblePropertyIds.has(assignedPropertyId)) return true;
  return false;
}

/**
 * Property ids a manager may reach TODAY: every property they own now, unioned
 * with co-manager-linked properties granting `applications` or `residents`.
 * Same union `fetchApplicationsForManagerUser` uses to decide visibility.
 */
export async function accessiblePropertyIdsForManager(db: ServiceClient, userId: string): Promise<Set<string>> {
  const [appIds, resIds, owned] = await Promise.all([
    linkedPropertyIdsForModule(db, userId, "applications"),
    linkedPropertyIdsForModule(db, userId, "residents"),
    db.from("manager_property_records").select("id").eq("manager_user_id", userId),
  ]);
  const ids = new Set<string>();
  for (const property of owned.data ?? []) {
    if (property?.id) ids.add(property.id);
  }
  for (const id of appIds) ids.add(id);
  for (const id of resIds) ids.add(id);
  return ids;
}

/**
 * Storage folder key for an application — normalized axis id, filesystem-safe.
 * Uppercased so it is CASE-CANONICAL: `normalizeApplicationAxisId` preserves the
 * case of an already-prefixed id, so the id captured at upload time and the
 * stored `row.id` used at delete time could otherwise differ by case and point
 * at two folders — which, given deletion is the only thing that reclaims bytes,
 * would orphan the photos forever. Two spellings of one axis id map here to one
 * folder.
 */
export function applicationPhotoFolderKey(applicationId: string): string {
  const normalized = normalizeApplicationAxisId(applicationId) || applicationId.trim();
  return normalized.toUpperCase().replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
}

/** Unguessable object path: `application/<folder>/<slot>-<ts>-<uuid>.<ext>`. */
export function buildApplicationPhotoPath(applicationId: string, slot: ApplicationPhotoSlot, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  return `application/${applicationPhotoFolderKey(applicationId)}/${slot}-${Date.now()}-${randomUUID()}.${safeExt}`;
}

/** Guard that a stored path really belongs to this application's folder. */
export function isPathInApplicationFolder(path: string, applicationId: string): boolean {
  return path.startsWith(`application/${applicationPhotoFolderKey(applicationId)}/`);
}

/**
 * Per-application object quota. The meaningful maximum is 5 (front + back ID
 * plus 3 income documents); 6 leaves headroom for the transient retake overlap
 * (new object uploaded before the replaced one is removed) while still bounding
 * what any one application id can ever cost in storage.
 */
export const MAX_APPLICATION_PHOTO_OBJECTS = 6;

/** How many objects already live under an application's folder. */
export async function countApplicationPhotoObjects(db: ServiceClient, applicationId: string): Promise<number> {
  const folder = `application/${applicationPhotoFolderKey(applicationId)}`;
  const { data, error } = await db.storage
    .from(APPLICATION_DOCUMENTS_BUCKET)
    .list(folder, { limit: MAX_APPLICATION_PHOTO_OBJECTS + 1 });
  if (error || !data) return 0;
  return data.length;
}

/** The stored-row facts a write decision needs (read from the row, never the client). */
export type ApplicationPhotoWriteTarget = {
  ownership: StoredApplicationOwnership;
  bucket: string | null;
  setupTokenHash: string | null;
  setupTokenExpiresAt: string | null;
  setupTokenConsumedAt: string | null;
};

/**
 * The single write (sign-upload / delete) authorization decision:
 *
 * - No stored row → deny for everyone. The client persists the draft first (the
 *   guest upsert is what mints the setup token), so there is never a legitimate
 *   write against a nonexistent application.
 * - A decided (non-pending) application is immutable except to an admin —
 *   retention Option A: photos live exactly as long as the row, and only the
 *   row's hard delete removes them.
 * - A guest is authorized ONLY by the row's unguessable resident-setup token,
 *   never by a claimed email — an id + email probe must learn nothing.
 * - A signed-in actor authorizes by session: manager property access, or the
 *   authenticated email matching the stored applicant email (multi-role logins).
 */
export function authorizeApplicationPhotoWrite(params: {
  actor: ApplicationPhotoActor;
  row: ApplicationPhotoWriteTarget | null;
  setupToken?: string | null;
  sessionEmail?: string | null;
}): boolean {
  const { actor, row } = params;
  if (!row) return false;
  if (actor.kind === "admin") return true;
  if (row.bucket && row.bucket !== "pending") return false;
  if (actor.kind === "guest") {
    const token = (params.setupToken ?? "").trim();
    if (!token) return false;
    return isResidentSetupTokenValid(row, token);
  }
  if (canActorAccessApplicationPhoto(actor, row.ownership)) return true;
  const email = (params.sessionEmail ?? "").trim();
  if (!email) return false;
  return canActorAccessApplicationPhoto({ kind: "resident", email }, row.ownership);
}

/** Content-type for a downloaded object based on its extension. */
export function contentTypeForApplicationPhotoPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "pdf":
      return "application/pdf";
    default:
      return "image/jpeg";
  }
}

function storageExt(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

/** HEIC/HEIF from phone cameras are not displayable in browsers — convert for inline preview. */
export function applicationPhotoNeedsPreviewConversion(storagePath: string, contentType: string): boolean {
  const ext = storageExt(storagePath);
  return (
    ext === "heic" ||
    ext === "heif" ||
    contentType === "image/heic" ||
    contentType === "image/heif"
  );
}

/**
 * When `preview` is set, convert HEIC/HEIF captures to JPEG so managers can see
 * ID photos inline. Original bytes are unchanged when preview is off.
 */
export async function applicationPhotoServeBytes(
  bytes: Buffer,
  storagePath: string,
  opts: { preview: boolean },
): Promise<{ body: Buffer; contentType: string }> {
  const contentType = contentTypeForApplicationPhotoPath(storagePath);
  if (!opts.preview || !applicationPhotoNeedsPreviewConversion(storagePath, contentType)) {
    return { body: bytes, contentType };
  }
  try {
    const converted = await sharp(bytes).rotate().jpeg({ quality: 88 }).toBuffer();
    return { body: converted, contentType: "image/jpeg" };
  } catch {
    return { body: bytes, contentType };
  }
}

/** Best-effort removal of every object under an application's folder (hard delete). */
export async function reclaimApplicationPhotos(db: ServiceClient, applicationId: string): Promise<void> {
  try {
    const folder = `application/${applicationPhotoFolderKey(applicationId)}`;
    const { data, error } = await db.storage.from(APPLICATION_DOCUMENTS_BUCKET).list(folder, { limit: 1000 });
    if (error || !data || data.length === 0) return;
    const paths = data.map((entry) => `${folder}/${entry.name}`);
    await db.storage.from(APPLICATION_DOCUMENTS_BUCKET).remove(paths);
  } catch {
    // Storage cleanup is best-effort; a leftover object is never user-visible
    // (the row that referenced it is gone). There is no periodic sweep — an
    // object that survives this pass stays until removed by hand.
  }
}
