import { NextResponse } from "next/server";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isApplicationPhotoSlot, validateApplicationPhotoUpload } from "@/lib/rental-application/application-photos";
import {
  accessiblePropertyIdsForManager,
  APPLICATION_DOCUMENTS_BUCKET,
  authorizeApplicationPhotoWrite,
  buildApplicationPhotoPath,
  canActorAccessApplicationPhoto,
  applicationPhotoServeBytes,
  ApplicationPhotoPreviewUnavailable,
  countApplicationPhotoObjects,
  isPathInApplicationFolder,
  MAX_APPLICATION_PHOTO_OBJECTS,
  type ApplicationPhotoActor,
  type ApplicationPhotoWriteTarget,
  type StoredApplicationOwnership,
} from "@/lib/rental-application/application-photos.server";
import type { ApplicationPhotoAttachment, ApplicationPhotoSlot } from "@/lib/rental-application/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import {
  applicationDocumentOriginalPath,
  createApplicationDocumentUploadEncryption,
  decryptApplicationDocumentBytes,
} from "@/lib/security/application-document-crypto.server";
import { APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX } from "@/lib/security/application-document-format";
import { resolveApplicationDocumentStoragePath } from "@/lib/security/application-document-aliases.server";

export const runtime = "nodejs";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

type StoredApplicationRow = {
  recordId: string;
  application: Record<string, unknown> | null;
  target: ApplicationPhotoWriteTarget;
};

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, trimmed.toUpperCase(), normalized, normalized.toUpperCase()].filter(Boolean))];
}

/** Load the stored application row (and its ownership + token facts) by axis id. */
async function loadApplicationRow(db: ServiceClient, applicationId: string): Promise<StoredApplicationRow | null> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_data, manager_user_id, property_id, assigned_property_id, resident_email")
    .in("id", idVariants(applicationId))
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const record = data[0];
  const row = (record.row_data ?? {}) as Partial<DemoApplicantRow>;
  const application =
    row.application && typeof row.application === "object" ? (row.application as Record<string, unknown>) : null;
  return {
    recordId: record.id,
    application,
    target: {
      bucket: typeof row.bucket === "string" ? row.bucket : null,
      setupTokenHash: typeof row.setupTokenHash === "string" ? row.setupTokenHash : null,
      setupTokenExpiresAt: typeof row.setupTokenExpiresAt === "string" ? row.setupTokenExpiresAt : null,
      setupTokenConsumedAt: typeof row.setupTokenConsumedAt === "string" ? row.setupTokenConsumedAt : null,
      ownership: {
        managerUserId: (record.manager_user_id ?? row.managerUserId ?? null) as string | null,
        propertyId: (record.property_id ?? row.propertyId ?? null) as string | null,
        assignedPropertyId: (record.assigned_property_id ?? row.assignedPropertyId ?? null) as string | null,
        residentEmail: (record.resident_email ?? row.email ?? null) as string | null,
      },
    },
  };
}

type ResolvedSession =
  | { kind: "admin" }
  | { kind: "manager"; userId: string; email: string }
  | { kind: "resident"; email: string }
  | { kind: "none" };

/** Resolve who is calling from the authenticated session (never from the body). */
async function resolveSession(db: ServiceClient): Promise<ResolvedSession> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "none" };
  if (await isAdminUser(user.id)) return { kind: "admin" };
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
  const role = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
  if (role === "manager" || role === "owner" || role === "pro") return { kind: "manager", userId: user.id, email };
  if (role === "resident") return { kind: "resident", email };
  // A signed-in user with some other role still owns applications by their email.
  if (email) return { kind: "resident", email };
  return { kind: "none" };
}

/** The authenticated session's email, if any (for the applicant-by-email fallback). */
function sessionEmail(session: ResolvedSession): string {
  return session.kind === "manager" || session.kind === "resident" ? session.email : "";
}

/**
 * A signed-in user is the APPLICANT of this row when their authenticated email
 * matches the stored applicant email — regardless of their primary `profiles.role`.
 * This is the safe fallback for multi-role accounts (a manager-primary login
 * applying as a resident): it only ever GRANTS access to one's own application by
 * one's own authenticated email, never widening cross-tenant reach.
 */
function isApplicantBySessionEmail(session: ResolvedSession, ownership: StoredApplicationOwnership): boolean {
  const email = sessionEmail(session);
  if (!email) return false;
  return canActorAccessApplicationPhoto({ kind: "resident", email }, ownership);
}

/**
 * Build the access actor. `allowGuest` is true for writes only, and a guest
 * actor carries no identity — writes authorize a guest exclusively by the row's
 * resident-setup token (see `authorizeApplicationPhotoWrite`), never a claimed
 * email.
 */
async function buildActor(
  db: ServiceClient,
  session: ResolvedSession,
  allowGuest: boolean,
): Promise<ApplicationPhotoActor | null> {
  if (session.kind === "admin") return { kind: "admin" };
  if (session.kind === "manager") {
    const accessiblePropertyIds = await accessiblePropertyIdsForManager(db, session.userId);
    return { kind: "manager", userId: session.userId, accessiblePropertyIds };
  }
  if (session.kind === "resident") return { kind: "resident", email: session.email };
  return allowGuest ? { kind: "guest", email: "" } : null;
}

/**
 * Every write denial — missing row, wrong or absent setup token, decided
 * application, foreign session — returns this identical response, so probing an
 * application id (with any email or token guess) reveals nothing about whether
 * it exists or whom it belongs to.
 */
function writeDenied(): NextResponse {
  return NextResponse.json({ error: "Not allowed." }, { status: 403 });
}

function sanitizeFileName(name: unknown, fallback: string): string {
  if (typeof name === "string" && name.trim()) {
    const cleaned = name.trim().replace(/[^\w.\-() ]+/g, "_").slice(0, 120);
    if (cleaned) return cleaned;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// POST — mint a signed upload URL plus a per-object encryption key. The client
// encrypts before uploading directly to private Storage, keeping large phone
// captures clear of the serverless body limit. The master key stays server-only.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      applicationId?: string;
      slot?: string;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      setupToken?: string;
      encryptionVersion?: number;
    };
    if (body.action !== "sign") {
      return NextResponse.json({ error: "Unsupported action." }, { status: 400 });
    }
    // Older open tabs must refresh rather than upload plaintext to a new .penc path.
    if (body.encryptionVersion !== 1) {
      return NextResponse.json({ error: "Refresh this page before uploading a document." }, { status: 409 });
    }
    const applicationId = body.applicationId?.trim() ?? "";
    if (!applicationId) return NextResponse.json({ error: "applicationId required." }, { status: 400 });
    if (!isApplicationPhotoSlot(body.slot)) return NextResponse.json({ error: "Invalid slot." }, { status: 400 });
    const slot: ApplicationPhotoSlot = body.slot;

    const validated = validateApplicationPhotoUpload(slot, body.mimeType, body.sizeBytes);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

    const limit = await rateLimit(`application-photo-sign:${clientIpFrom(req)}`, 20, 60_000);
    if (limit.unavailable) return NextResponse.json({ error: "Uploads are temporarily unavailable." }, { status: 503 });
    if (!limit.ok) {
      return NextResponse.json({ error: "Too many uploads. Try again in a minute." }, { status: 429 });
    }

    const db = createSupabaseServiceRoleClient();
    const session = await resolveSession(db);
    const actor = await buildActor(db, session, true);
    if (!actor) return writeDenied();

    const row = await loadApplicationRow(db, applicationId);
    if (
      !authorizeApplicationPhotoWrite({
        actor,
        row: row?.target ?? null,
        setupToken: body.setupToken,
        sessionEmail: sessionEmail(session),
      })
    ) {
      return writeDenied();
    }

    if ((await countApplicationPhotoObjects(db, applicationId)) >= MAX_APPLICATION_PHOTO_OBJECTS) {
      return NextResponse.json(
        { error: "Photo limit reached for this application. Remove one before adding another." },
        { status: 409 },
      );
    }

    const storagePath = `${buildApplicationPhotoPath(row!.recordId, slot, validated.ext)}${APPLICATION_DOCUMENT_ENCRYPTED_SUFFIX}`;
    const encryption = createApplicationDocumentUploadEncryption(storagePath, body.sizeBytes!);
    const { data, error } = await db.storage.from(APPLICATION_DOCUMENTS_BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data?.token) {
      return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 502 });
    }
    return NextResponse.json({
      path: storagePath,
      token: data.token,
      fileName: sanitizeFileName(body.fileName, `${slot}.${validated.ext}`),
      encryption,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error("[security] application_document_upload_preparation_failed");
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET — stream a stored photo. The path is resolved from the STORED row, never
// the client, so a caller can only ever fetch a photo genuinely attached to an
// application they are authorized to see. Guests are not served (they rely on
// the in-session in-memory preview). Denials return 404 to avoid leaking which
// applications exist.
// ---------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const applicationId = url.searchParams.get("applicationId")?.trim() ?? "";
    const slotParam = url.searchParams.get("slot") ?? "";
    const index = Number.parseInt(url.searchParams.get("index") ?? "0", 10) || 0;
    if (!applicationId || !isApplicationPhotoSlot(slotParam)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const slot: ApplicationPhotoSlot = slotParam;

    const db = createSupabaseServiceRoleClient();
    const session = await resolveSession(db);
    const actor = await buildActor(db, session, false);
    if (!actor) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const row = await loadApplicationRow(db, applicationId);
    if (
      !row ||
      !row.application ||
      !(
        canActorAccessApplicationPhoto(actor, row.target.ownership) ||
        isApplicantBySessionEmail(session, row.target.ownership)
      )
    ) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const attachment = resolveAttachment(row.application, slot, index);
    const storagePath = attachment?.storagePath?.trim();
    if (!storagePath || !isPathInApplicationFolder(storagePath, applicationId)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const resolvedPath = await resolveApplicationDocumentStoragePath(db, row.recordId, storagePath);
    const { data, error } = await db.storage.from(APPLICATION_DOCUMENTS_BUCKET).download(resolvedPath);
    if (error || !data) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const bytes = decryptApplicationDocumentBytes(Buffer.from(await data.arrayBuffer()), resolvedPath);
    const preview = url.searchParams.get("preview") === "1";
    let served: { body: Buffer; contentType: string };
    try {
      served = await applicationPhotoServeBytes(bytes, applicationDocumentOriginalPath(resolvedPath), { preview });
    } catch (e) {
      if (e instanceof ApplicationPhotoPreviewUnavailable) {
        return NextResponse.json({ error: "Preview unavailable." }, { status: 404 });
      }
      throw e;
    }
    // The stored fileName arrives via the application autosave path, which never
    // ran this route's sanitizer — re-apply the allowlist at serve time so a
    // hostile stored name can't break header construction.
    const safeName = sanitizeFileName(attachment?.fileName, "photo");
    // `BodyInit` accepts neither a Node `Buffer` nor a `Uint8Array<ArrayBufferLike>` (that would
    // admit a SharedArrayBuffer), so copy into a Uint8Array with its own plain ArrayBuffer.
    // Copying is also the safe choice here: `Buffer.from` allocates out of a shared pool, so
    // handing out a view over `served.body.buffer` risks exposing bytes beyond this photo.
    const body = new Uint8Array(served.body);
    return new NextResponse(body, {
      headers: {
        "Content-Type": served.contentType,
        "Content-Disposition": `inline; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove a stored object (applicant remove / retake, pending rows
// only). The caller names a storagePath; it must live under the application's
// own folder and the actor must pass the same write authorization as uploads.
// ---------------------------------------------------------------------------
export async function DELETE(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      applicationId?: string;
      storagePath?: string;
      setupToken?: string;
    };
    const applicationId = body.applicationId?.trim() ?? "";
    const storagePath = body.storagePath?.trim() ?? "";
    if (!applicationId || !storagePath) {
      return NextResponse.json({ error: "applicationId and storagePath required." }, { status: 400 });
    }
    if (!isPathInApplicationFolder(storagePath, applicationId)) {
      return NextResponse.json({ error: "Invalid path." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const session = await resolveSession(db);
    const actor = await buildActor(db, session, true);
    if (!actor) return writeDenied();

    const row = await loadApplicationRow(db, applicationId);
    if (
      !authorizeApplicationPhotoWrite({
        actor,
        row: row?.target ?? null,
        setupToken: body.setupToken,
        sessionEmail: sessionEmail(session),
      })
    ) {
      return writeDenied();
    }

    const resolvedPath = await resolveApplicationDocumentStoragePath(db, row!.recordId, storagePath);
    // An old browser can remove a migrated attachment by its original reference.
    const { error } = await db.storage.from(APPLICATION_DOCUMENTS_BUCKET).remove([...new Set([storagePath, resolvedPath])]);
    if (error) return NextResponse.json({ error: "Could not remove the file." }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("application-photos delete failed", e);
    return NextResponse.json({ error: "Delete failed." }, { status: 500 });
  }
}

function resolveAttachment(
  application: Record<string, unknown>,
  slot: ApplicationPhotoSlot,
  index: number,
): ApplicationPhotoAttachment | null {
  if (slot === "income") {
    const list = application.incomeProofPhotos;
    if (!Array.isArray(list)) return null;
    const entry = list[index];
    return isAttachment(entry) ? entry : null;
  }
  const key = slot === "idFront" ? "idPhotoFront" : "idPhotoBack";
  const entry = application[key];
  return isAttachment(entry) ? entry : null;
}

function isAttachment(value: unknown): value is ApplicationPhotoAttachment {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { storagePath?: unknown }).storagePath === "string"
  );
}
