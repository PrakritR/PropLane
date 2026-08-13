import { parseScheduledMessageListId } from "@/lib/payment-automation-server";
import { upsertScheduledMessageOverride } from "@/lib/payment-automation-settings";
import { decodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";
import { updateScheduledInboxMessage } from "@/lib/scheduled-inbox-messages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireManager();
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const { id: rawId } = await ctx.params;
    const id = decodeScheduledMessagePathId(rawId);

    const body = (await req.json()) as {
      cancelled?: boolean;
      cancelledBecausePaid?: boolean;
      customSubject?: string;
      customBody?: string;
      customDaysBeforeDue?: number;
      customSendAt?: string;
    };

    if (id.startsWith("sched_inbox_")) {
      const now = new Date().toISOString();
      const inboxPatch: Parameters<typeof updateScheduledInboxMessage>[3] = {};
      if (typeof body.cancelled === "boolean") {
        inboxPatch.status = body.cancelled ? "cancelled" : "scheduled";
        inboxPatch.cancelledAt = body.cancelled ? now : null;
      }
      if (typeof body.customSubject === "string") inboxPatch.subject = body.customSubject.trim();
      if (typeof body.customBody === "string") inboxPatch.body = body.customBody.trim();
      if (typeof body.customSendAt === "string" && body.customSendAt.trim()) {
        const parsedSendAt = new Date(body.customSendAt);
        if (!Number.isNaN(parsedSendAt.getTime())) inboxPatch.sendAt = parsedSendAt.toISOString();
      }
      await updateScheduledInboxMessage(auth.db, auth.userId, id, inboxPatch);
      return NextResponse.json({ ok: true });
    }

    const parsed = parseScheduledMessageListId(id);
    if (!parsed) {
      return NextResponse.json({ error: "Invalid scheduled message id." }, { status: 400 });
    }

    const patch: {
      cancelled?: boolean;
      cancelledBecausePaid?: boolean;
      customSubject?: string;
      customBody?: string;
      customDaysBeforeDue?: number;
      customSendAt?: string;
    } = {};

    if (typeof body.cancelled === "boolean") patch.cancelled = body.cancelled;
    if (typeof body.cancelledBecausePaid === "boolean") patch.cancelledBecausePaid = body.cancelledBecausePaid;
    if (typeof body.customSubject === "string") patch.customSubject = body.customSubject.trim();
    if (typeof body.customBody === "string") patch.customBody = body.customBody.trim();
    if (typeof body.customDaysBeforeDue === "number" && Number.isFinite(body.customDaysBeforeDue)) {
      patch.customDaysBeforeDue = Math.max(0, Math.min(60, Math.round(body.customDaysBeforeDue)));
    }
    if (typeof body.customSendAt === "string" && body.customSendAt.trim()) {
      const parsedSendAt = new Date(body.customSendAt);
      if (!Number.isNaN(parsedSendAt.getTime())) patch.customSendAt = parsedSendAt.toISOString();
    }

    await upsertScheduledMessageOverride(auth.db, {
      managerUserId: auth.userId,
      chargeId: parsed.chargeId,
      kind: parsed.kind,
      daysBeforeDue: parsed.daysBeforeDue,
      patch,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
