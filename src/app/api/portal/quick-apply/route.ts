import { NextResponse } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { readListingSource } from "@/lib/listing-channels/lead-source.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { runQuickApply, type QuickApplyInput } from "@/lib/rental-application/quick-apply.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

/**
 * Quick apply: submit a solo application to one room from the signed-in resident's saved answers.
 * Signed-in residents only (401 otherwise), 10 a minute per account (30 for the read-only dry run that labels the button). Everything that makes a submit a
 * submit (validation, fee guard, linking, notices, screening) is the shared write in
 * `signed-in-application-write.server.ts`; see `quick-apply.server.ts`.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user?.email) return NextResponse.json({ error: "Sign in to apply." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as QuickApplyInput;
    // A dry run only decides what the button says, so it gets its own, looser budget.
    const limited = body.dryRun === true
      ? await rateLimit(`quick-apply-dry:${user.id}`, 30, 60_000)
      : await rateLimit(`quick-apply:${user.id}`, 10, 60_000);
    if (!limited.ok) {
      return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
    }
    if (!(await rateLimit(`quick-apply-ip:${clientIpFrom(req)}`, 30, 60_000)).ok) {
      return NextResponse.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
    }

    const db = createSupabaseServiceRoleClient();
    if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
      return NextResponse.json({ error: "Application access is unavailable for this account." }, { status: 403 });
    }
    const { data: profile } = await db.from("profiles").select("email, role").eq("id", user.id).maybeSingle();
    const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
    if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole }))) {
      return NextResponse.json({ error: "Quick apply is for resident accounts." }, { status: 401 });
    }
    const email = String(profile?.email ?? user.email ?? "").trim().toLowerCase();
    if (!email) return NextResponse.json({ error: "Sign in to apply." }, { status: 401 });

    const outcome = await runQuickApply(
      db,
      { user, role: legacyRole, email, leadSource: await readListingSource(req) },
      body,
    );
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not submit the application.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
