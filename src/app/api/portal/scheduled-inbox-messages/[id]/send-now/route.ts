import { NextResponse } from "next/server";
import {
  loadScheduledInboxMessagesForManager,
  loadScheduledInboxMessagesForResident,
  isResidentOriginatedScheduledMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages.server";
import { sendScheduledInboxMessageNow } from "@/lib/send-scheduled-inbox-message-now";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";

export const runtime = "nodejs";

type PortalRole = "manager" | "resident";

async function requirePortalActor(preferredRole?: PortalRole) {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") return null;
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  const isResident = roleList.includes("resident") || legacy === "resident";
  if (!isManager && !isResident) return null;

  let role: PortalRole;
  if (isManager && isResident) {
    role = preferredRole === "resident" ? "resident" : "manager";
  } else {
    role = isManager ? "manager" : "resident";
  }

  return { db, userId: user.id, role };
}

function parsePreferredRole(req: Request): PortalRole | undefined {
  const url = new URL(req.url);
  const queryRole = url.searchParams.get("as");
  if (queryRole === "resident" || queryRole === "manager") return queryRole;
  return undefined;
}

async function findMessage(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  role: PortalRole,
  id: string,
): Promise<ScheduledInboxMessageRecord | null> {
  const messages =
    role === "resident"
      ? await loadScheduledInboxMessagesForResident(db, userId)
      : await loadScheduledInboxMessagesForManager(db, userId);
  return messages.find((m) => m.id === id) ?? null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const preferredRole = parsePreferredRole(req);
    const auth = await requirePortalActor(preferredRole);
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id } = await ctx.params;
    const message = await findMessage(auth.db, auth.userId, auth.role, id);
    if (!message) return NextResponse.json({ error: "Scheduled message not found." }, { status: 404 });

    if (auth.role === "resident" && !isResidentOriginatedScheduledMessage(message)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const result = await sendScheduledInboxMessageNow(auth.db, message);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Could not send message." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
