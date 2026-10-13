import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { teamInviteOwnerIdsForActor } from "@/lib/auth/co-manager-team-invite.server";
import {
  listWorkNumberRecipients,
  MAX_WORK_NUMBER_RECIPIENTS,
  parseWorkNumberRecipientInput,
} from "@/lib/work-number-recipients.server";

export const runtime = "nodejs";

/**
 * The "Also notify" list on the work number: people without a PropLane account who get every
 * manager notice. The table has no client policy, so this service-role route is the only door.
 * Read: the workspace owner, or a teammate holding Team at edit under that owner; POST/DELETE: the owner only
 * (`teamInviteOwnerIdsForActor`). The owner is derived from the actor, never trusted from the
 * body unless it is one the actor may manage.
 */
async function authorize(req: Request, requestedOwner: string | null, opts: { ownerOnly?: boolean } = {}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const db = createSupabaseServiceRoleClient();
  const allowed = await teamInviteOwnerIdsForActor(db, user.id);
  const ownerUserId = requestedOwner?.trim() || user.id;
  if (!allowed.has(ownerUserId)) {
    return { error: NextResponse.json({ error: "You do not have Team permission for this workspace." }, { status: 403 }) } as const;
  }
  // Adding or removing who is texted is the owner's call; teammates with Team at edit may only read the list.
  if (opts.ownerOnly && user.id !== ownerUserId) {
    return { error: NextResponse.json({ error: "Only the workspace owner can change this list." }, { status: 403 }) } as const;
  }
  void req;
  return { db, user, ownerUserId } as const;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const auth = await authorize(req, url.searchParams.get("ownerUserId"));
  if ("error" in auth) return auth.error;
  try {
    const recipients = await listWorkNumberRecipients(auth.db, auth.ownerUserId);
    return NextResponse.json({ recipients });
  } catch {
    return NextResponse.json({ error: "Could not load the list." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { ownerUserId?: string; label?: string; phone?: string; email?: string };
  const auth = await authorize(req, typeof body.ownerUserId === "string" ? body.ownerUserId : null, { ownerOnly: true });
  if ("error" in auth) return auth.error;
  const parsed = parseWorkNumberRecipientInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const existing = await listWorkNumberRecipients(auth.db, auth.ownerUserId);
    if (existing.length >= MAX_WORK_NUMBER_RECIPIENTS) {
      return NextResponse.json({ error: `You can add up to ${MAX_WORK_NUMBER_RECIPIENTS} people.` }, { status: 400 });
    }
    const { data, error } = await auth.db
      .from("workspace_work_number_recipients")
      .insert({
        owner_user_id: auth.ownerUserId,
        label: parsed.label,
        phone: parsed.phone,
        email: parsed.email,
        created_by: auth.user.id,
      })
      .select("id, owner_user_id, label, phone, email, created_at")
      .single();
    if (error) return NextResponse.json({ error: "Could not save." }, { status: 500 });
    return NextResponse.json({
      recipient: {
        id: String(data.id),
        ownerUserId: String(data.owner_user_id),
        label: String(data.label),
        phone: (data.phone as string | null) ?? null,
        email: (data.email as string | null) ?? null,
        createdAt: String(data.created_at),
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const body = (await req.json().catch(() => ({}))) as { id?: string; ownerUserId?: string };
  const id = (typeof body.id === "string" ? body.id : url.searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
  const auth = await authorize(req, (typeof body.ownerUserId === "string" ? body.ownerUserId : url.searchParams.get("ownerUserId")) || null, { ownerOnly: true });
  if ("error" in auth) return auth.error;
  // Scoped to the owner the actor may manage: an id from another workspace deletes nothing.
  const { error } = await auth.db
    .from("workspace_work_number_recipients")
    .delete()
    .eq("id", id)
    .eq("owner_user_id", auth.ownerUserId);
  if (error) return NextResponse.json({ error: "Could not remove." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
