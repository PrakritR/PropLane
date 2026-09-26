import {
  previewResidentApplicationRemoval,
  removeResidentApplication,
} from "@/lib/auth/remove-resident-application";
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { deleteResidentAccount } from "@/lib/auth/delete-portal-account";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function canManageResidentAccess(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      email?: unknown;
      purgeData?: unknown;
      applicationId?: unknown;
      mode?: unknown;
    } | null;
    const emailInput = normalizeEmail(body?.email);
    const applicationId = typeof body?.applicationId === "string" ? body.applicationId.trim() : "";
    if (!emailInput && !applicationId) {
      return NextResponse.json({ error: "Email or applicationId is required." }, { status: 400 });
    }
    const purgeData = body?.purgeData === true;
    // `preview` counts what a delete would remove and writes nothing. The
    // confirm dialog reads it, so the numbers a manager agrees to are the
    // server's, never the browser's own guess at what it can see.
    const preview = body?.mode === "preview";

    const svc = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, svc)).kind === "denied") {
      return NextResponse.json({ error: "Resident access is unavailable for this account." }, { status: 403 });
    }
    let email = emailInput;
    if (!email && applicationId) {
      const { data: appRow } = await svc
        .from("manager_application_records")
        .select("resident_email")
        .eq("id", applicationId)
        .maybeSingle();
      email = normalizeEmail(appRow?.resident_email);
    }
    const { data: requestor } = await svc.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (!requestor || !canManageResidentAccess(requestor.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const isAdmin = String(requestor.role ?? "").toLowerCase() === "admin" || (await isAdminUser(user.id));

    if (preview) {
      if (!applicationId) {
        return NextResponse.json({ error: "Choose the resident to preview." }, { status: 400 });
      }
      const counted = await previewResidentApplicationRemoval(svc, { userId: user.id, isAdmin }, { applicationId, email });
      return NextResponse.json(counted, { status: counted.ok ? 200 : counted.status });
    }

    if (!isAdmin) {
      if (!purgeData) {
        return NextResponse.json({ error: "Resident logins belong to the resident. You can remove an application from your portfolio while keeping their login and financial history." }, { status: 403 });
      }
      if (!applicationId) {
        return NextResponse.json({ error: "Choose the application to remove. A manager cannot delete a resident's login." }, { status: 400 });
      }
      const result = await removeResidentApplication(svc, { userId: user.id, isAdmin: false }, { applicationId, email });
      return NextResponse.json(result, { status: result.ok ? 200 : result.status });
    }

    const targetUserId = email ? await findAuthUserIdByEmail(svc, email) : null;
    const result = await deleteResidentAccount(svc, {
      userId: targetUserId ?? undefined,
      email,
      applicationId,
      purgeData,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 409 });
    }

    if (result.mode === "purged") {
      return NextResponse.json({ ok: true, mode: "purged", loginMode: result.loginMode });
    }

    return NextResponse.json({ ok: true, mode: result.mode });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove resident access." },
      { status: 500 },
    );
  }
}
