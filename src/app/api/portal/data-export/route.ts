import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getUserOrRejection } from "@/lib/auth/session-rejection";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import { rateLimit } from "@/lib/rate-limit";
import { track } from "@/lib/analytics/posthog";
import { collectManagerExport } from "@/lib/account-export/collect-manager-export.server";
import { buildEncryptedExportFile, exportFileName } from "@/lib/account-export/build-export-file.server";
import { EXPORT_FILE_MIME, validateExportPassword } from "@/lib/account-export/export-password";

export const runtime = "nodejs";
/** Reading every owned table for a large portfolio, then scrypt, is well past the default. */
export const maxDuration = 60;

export const DATA_EXPORT_WINDOW_MS = 10 * 60 * 1000;

/**
 * `POST /api/portal/data-export` `{ password }` → the manager's own data as ONE encrypted
 * `.proplane` attachment (PRP-324).
 *
 * The session is the only identity: the manager id and email that scope every read come
 * from `getUser()`, never the body. Reads run on the service-role client because the
 * caller's own session client is `authenticated`, which holds SELECT on far fewer tables
 * than the manager owns — this route is the authorization check, and every select is
 * pinned to `user.id` / the account email (see `collectManagerExport`). Identity numbers
 * and payment instruments are stripped before a row is retained; the password never leaves
 * this request and is never logged.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    // Generic 401 — why a session was refused is an oracle; the reason goes to the log.
    const { user } = await getUserOrRejection(supabase, "POST /api/portal/data-export");
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    let body: { password?: unknown };
    try {
      body = (await req.json()) as { password?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const invalid = validateExportPassword(body.password);
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }
    const password = body.password as string;

    const db = createSupabaseServiceRoleClient();
    const [{ data: roleRows, error: roleError }, { data: profile }] = await Promise.all([
      db.from("profile_roles").select("role").eq("user_id", user.id),
      db.from("profiles").select("role, email").eq("id", user.id).maybeSingle(),
    ]);
    if (roleError) {
      return NextResponse.json({ error: "Could not confirm your account role." }, { status: 500 });
    }
    const roles = normalizePortalRoles(roleRows as { role: string }[] | null, profile?.role ?? null);
    if (!roles.includes("manager")) {
      return NextResponse.json({ error: "Only a property manager account can export data." }, { status: 403 });
    }

    // One export per manager per ten minutes: the read walks every owned table and
    // scrypt is deliberately slow, so a loop here is a cheap way to burn the free tier.
    const limit = await rateLimit(`data-export:${user.id}`, 1, DATA_EXPORT_WINDOW_MS);
    if (limit.unavailable) {
      return NextResponse.json({ error: "Export is temporarily unavailable. Try again shortly." }, { status: 503 });
    }
    if (!limit.ok) {
      return NextResponse.json(
        { error: "You can export once every 10 minutes. Try again in a few minutes." },
        { status: 429, headers: { "Retry-After": String(DATA_EXPORT_WINDOW_MS / 1000) } },
      );
    }

    const now = new Date();
    const email = String(profile?.email ?? user.email ?? "").trim().toLowerCase();
    const exportData = await collectManagerExport(db, { userId: user.id, email }, { now });
    const file = buildEncryptedExportFile(exportData, password);

    track("data_export_completed", user.id, {
      tableCount: exportData.manifest.tableCount,
      rowCount: exportData.manifest.rowCount,
    });

    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: {
        "Content-Type": EXPORT_FILE_MIME,
        "Content-Length": String(file.length),
        // Always an attachment, never inline: the bytes are opaque ciphertext, and there is
        // nothing a browser should try to render on the app's origin.
        "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (e) {
    // Never the password, never a row: the message from a failed read names a table at most.
    const message = e instanceof Error ? e.message : "Export failed.";
    console.error(`[data-export] failed: ${message}`);
    return NextResponse.json({ error: "Couldn't build your export. Please try again." }, { status: 500 });
  }
}
