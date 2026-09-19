import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

async function resolveUser() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

const TEST_MEDIA_PREFIX = "test-workspaces";

function safeExtension(value: string): string {
  const ext = value.trim().toLowerCase().replace(/^\.+/, "");
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

async function uploadToStorage(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  bytes: Buffer | Uint8Array,
  mime: string,
  ext: string,
  testWorkspaceId?: string,
) {
  const prefix = testWorkspaceId ? `${TEST_MEDIA_PREFIX}/${testWorkspaceId}/${userId}` : userId;
  const path = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExtension(ext)}`;
  // Filenames are timestamp+random and never overwritten, so the object is
  // immutable — cache for a year to avoid re-fetching media on every view.
  const { error } = await db.storage.from("listing-photos").upload(path, bytes, { contentType: mime, cacheControl: "31536000", upsert: false });
  if (error) throw new Error(error.message);
  const { data } = db.storage.from("listing-photos").getPublicUrl(path);
  return data.publicUrl;
}

/** Lets the browser select the server upload path without accepting a client workspace id. */
export async function GET() {
  const user = await resolveUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const db = createSupabaseServiceRoleClient();
  const access = await resolveAuthenticatedBusinessAccess(user.id, db);
  if (access.kind === "denied") {
    return NextResponse.json({ error: "Test workspace access is unavailable." }, { status: 403 });
  }
  return NextResponse.json({ serverUpload: access.kind === "test" }, { headers: { "Cache-Control": "private, no-store" } });
}

// Accepts either:
//   multipart/form-data with a "file" field (raw binary — used for videos)
//   application/json with { dataUrl, ext }  (base64 data URL — used for images)
export async function POST(req: Request) {
  try {
    const user = await resolveUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const access = await resolveAuthenticatedBusinessAccess(user.id, db);
    if (access.kind === "denied") {
      return NextResponse.json({ error: "Test workspace access is unavailable." }, { status: 403 });
    }
    const testWorkspaceId = access.kind === "test" ? access.workspaceId : undefined;
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "file required." }, { status: 400 });
      const mime = file.type || "video/mp4";
      const ext = file.name.split(".").pop() ?? mime.split("/")[1] ?? "mp4";
      const bytes = Buffer.from(await file.arrayBuffer());
      const url = await uploadToStorage(db, user.id, bytes, mime, ext, testWorkspaceId);
      return NextResponse.json({ url });
    }

    // JSON path (images as base64 data URLs)
    const body = (await req.json()) as { dataUrl?: string; ext?: string };
    const dataUrl = body.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "dataUrl required." }, { status: 400 });
    }
    const [header, b64] = dataUrl.split(",");
    if (!header || !b64) return NextResponse.json({ error: "Invalid data URL." }, { status: 400 });
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? "image/jpeg";
    const ext = body.ext ?? (mime.split("/")[1] ?? "jpg");
    const bytes = Buffer.from(b64, "base64");
    const url = await uploadToStorage(db, user.id, bytes, mime, ext, testWorkspaceId);
    return NextResponse.json({ url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Reclaims only the authenticated classified actor's private-test media. */
export async function DELETE(req: Request) {
  try {
    const user = await resolveUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const access = await resolveAuthenticatedBusinessAccess(user.id, db);
    if (access.kind === "denied") {
      return NextResponse.json({ error: "Test workspace access is unavailable." }, { status: 403 });
    }
    if (access.kind !== "test") return NextResponse.json({ error: "Not found." }, { status: 404 });

    const body = await req.json() as { paths?: unknown };
    const paths = Array.isArray(body.paths)
      ? [...new Set(body.paths.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean))]
      : [];
    if (paths.length === 0 || paths.length > 100) {
      return NextResponse.json({ error: "paths required." }, { status: 400 });
    }
    const prefix = `${TEST_MEDIA_PREFIX}/${access.workspaceId}/${user.id}/`;
    if (paths.some((path) => !path.startsWith(prefix))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { error } = await db.storage.from("listing-photos").remove(paths);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not remove listing media." },
      { status: 500 },
    );
  }
}
