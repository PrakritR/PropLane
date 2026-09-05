import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  INBOX_ATTACHMENTS_BUCKET,
  contentDispositionForInboxAttachmentPath,
  contentTypeForInboxAttachmentPath,
  inboxAttachmentServeUrl,
  inboxAttachmentStoragePrefix,
  isInboxAttachmentPath,
  sanitizeInboxAttachmentExt,
  sanitizeInboxAttachmentFileName,
  userCanAccessInboxAttachment,
} from "@/lib/inbox-attachments.server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

async function resolveUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(req: Request) {
  try {
    const user = await resolveUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const path = new URL(req.url).searchParams.get("path")?.trim() ?? "";
    if (!path || !isInboxAttachmentPath(path)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const db = createSupabaseServiceRoleClient();
    const userEmail = String(user.email ?? "").trim().toLowerCase();
    const admin = await isAdminUser(user.id);
    if (
      !(await userCanAccessInboxAttachment(db, {
        userId: user.id,
        userEmail,
        path,
        isAdmin: admin,
      }))
    ) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const { data, error } = await db.storage.from(INBOX_ATTACHMENTS_BUCKET).download(path);
    if (error || !data) return NextResponse.json({ error: "Not found." }, { status: 404 });

    const bytes = Buffer.from(await data.arrayBuffer());
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": contentTypeForInboxAttachmentPath(path),
        // NEVER `inline`. These bytes are attacker-controllable — any authenticated
        // user can upload one and send it to anyone — and this route answers on the
        // APP's own origin, so an inline response is a same-origin document under
        // the uploader's control. That was survivable only while every allowed type
        // was an inert raster image; `application/pdf` (an active document format
        // that runs in whatever handler the browser has registered) made it a real
        // escalation. The disposition deliberately does NOT branch on content type,
        // so widening ALLOWED_MIME again can never silently reopen this.
        "Content-Disposition": contentDispositionForInboxAttachmentPath(path),
        "Cache-Control": "private, no-store",
        // Defense in depth if a client ever ignores the disposition: no scripts, no
        // subresources, no form posts, opaque origin, and not loadable cross-site.
        "Content-Security-Policy": "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await resolveUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    if (
      !(await rateLimit(`inbox-attach:user:${user.id}`, 20, 60_000)).ok ||
      !(await rateLimit(`inbox-attach:ip:${clientIpFrom(req)}`, 40, 60_000)).ok
    ) {
      return NextResponse.json({ error: "Too many uploads. Please slow down." }, { status: 429 });
    }

    const body = (await req.json()) as { dataUrl?: string; ext?: string; fileName?: string };
    const dataUrl = body.dataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
      return NextResponse.json({ error: "dataUrl required." }, { status: 400 });
    }

    const [header, b64] = dataUrl.split(",");
    if (!header || !b64) return NextResponse.json({ error: "Invalid data URL." }, { status: 400 });

    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = mimeMatch?.[1] ?? "image/jpeg";
    if (!ALLOWED_MIME.has(mime)) {
      return NextResponse.json({ error: "Only JPEG, PNG, WebP, GIF images, and PDF documents are allowed." }, { status: 400 });
    }

    const bytes = Buffer.from(b64, "base64");
    const maxBytes = mime === "application/pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (bytes.length > maxBytes) {
      return NextResponse.json(
        { error: mime === "application/pdf" ? "PDF must be 10 MB or smaller." : "Image must be 5 MB or smaller." },
        { status: 400 },
      );
    }

    const ext = sanitizeInboxAttachmentExt(body.ext, mime);
    if (!ext) {
      return NextResponse.json({ error: "Invalid file extension." }, { status: 400 });
    }
    // `<userId>/<ts>-<uuid>/<original name>` — the uuid segment keeps the key
    // unique, the last segment preserves the uploader's file name so the chip in
    // a message bubble can show it. Ownership checks still read `path[0]`.
    const path = `${inboxAttachmentStoragePrefix(user.id)}${Date.now()}-${randomUUID()}/${sanitizeInboxAttachmentFileName(body.fileName, ext)}`;
    const db = createSupabaseServiceRoleClient();
    const { error } = await db.storage.from(INBOX_ATTACHMENTS_BUCKET).upload(path, bytes, {
      contentType: mime,
      cacheControl: "31536000",
      upsert: false,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ url: inboxAttachmentServeUrl(path) });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
