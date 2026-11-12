import { NextResponse } from "next/server";
import { assertSettingsScopeOwned, resolveSettingsScopeParams } from "@/lib/scope/settings-scope";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { sourceReport } from "@/lib/prospect-spine/index.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";

export const runtime = "nodejs";

/** Lead sources (design-1112 §6): per property, which platform produced each lead and where the conversation lives now. */
export async function GET(req: Request) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    if (!user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    if (!(await userHoldsManagerRole(db, user.id))) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const scope = resolveSettingsScopeParams(req.url);
    const access = await assertSettingsScopeOwned(db, user.id, scope, { intent: "read", level: "read" });
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const workspaceId = access.workspaceId ?? (await userDefaultWorkspaceId(db, access.ownerUserId).catch(() => ""));
    if (!workspaceId) return NextResponse.json({ rows: [] });
    const since = new URL(req.url).searchParams.get("since");
    const rows = await sourceReport(db, { workspaceId, propertyId: access.propertyId, since: since && !Number.isNaN(Date.parse(since)) ? since : null });
    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ error: "Could not load lead sources." }, { status: 503 });
  }
}
