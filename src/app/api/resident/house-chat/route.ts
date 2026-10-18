import { NextResponse, after } from "next/server";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { houseChatOfferAvailable, recordResidentHouseChatChoice } from "@/lib/house-groups/consent.server";
import { syncHouseGroup } from "@/lib/house-groups/manager.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function residentUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
    return { error: NextResponse.json({ error: "Residents only." }, { status: 403 }) } as const;
  }
  return { db, userId: user.id } as const;
}

/** Is the house chat offer shown to this resident (shared line on, chat enabled for their team, verified phone)? */
export async function GET() {
  const who = await residentUser();
  if ("error" in who) return who.error;
  return NextResponse.json({ available: await houseChatOfferAvailable(who.db, who.userId) });
}

/** POST `{ consent: boolean }`: the resident's own yes / no. The phone and the teams come from the account. */
export async function POST(req: Request) {
  const who = await residentUser();
  if ("error" in who) return who.error;
  const body = (await req.json().catch(() => ({}))) as { consent?: unknown };
  if (typeof body.consent !== "boolean") return NextResponse.json({ error: "consent must be true or false." }, { status: 400 });
  const result = await recordResidentHouseChatChoice(who.db, who.userId, body.consent);
  if (!result.ok) return NextResponse.json({ error: "Could not save your choice." }, { status: 409 });
  // Join or leave takes effect now, after the response, instead of at the next daily run.
  const db = who.db;
  after(async () => {
    for (const target of result.workspaces) {
      if (!target.propertyId) continue;
      await syncHouseGroup(db, { workspaceId: target.workspaceId, propertyId: target.propertyId, reason: "consent_change" }).catch(() => undefined);
    }
  });
  return NextResponse.json({ ok: true });
}
