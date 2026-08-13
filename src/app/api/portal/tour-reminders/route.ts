import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  cancelTourReminderForPlannedEvent,
  findTourReminderForPlannedEvent,
  listTourRemindersForPlannedEvent,
  reconcileDuplicateTourReminders,
  upsertTourReminderForPlannedEvent,
} from "@/lib/tour-reminder.server";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role, full_name, email").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;

  const managerName =
    profile?.full_name?.trim() || profile?.email?.trim() || user.email?.trim() || "Your property manager";
  return { db, userId: user.id, managerName };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const plannedEventId = new URL(req.url).searchParams.get("plannedEventId")?.trim() ?? "";
    if (!plannedEventId) return NextResponse.json({ error: "plannedEventId required." }, { status: 400 });
    await reconcileDuplicateTourReminders(ctx.db, ctx.userId, plannedEventId);
    const reminder = await findTourReminderForPlannedEvent(ctx.db, ctx.userId, plannedEventId);
    const reminders = await listTourRemindersForPlannedEvent(ctx.db, ctx.userId, plannedEventId);
    return NextResponse.json({ reminder, reminders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json()) as {
      plannedEventId?: string;
      tourStartIso?: string;
      tourEndIso?: string;
      recipientEmail?: string;
      recipientName?: string;
      propertyTitle?: string;
      instructions?: string;
      subject?: string;
      body?: string;
      sendAt?: string;
      deliverViaEmail?: boolean;
      deliverViaSms?: boolean;
    };

    const plannedEventId = body.plannedEventId?.trim() ?? "";
    const tourStartIso = body.tourStartIso?.trim() ?? "";
    const tourEndIso = body.tourEndIso?.trim() ?? "";
    const recipientEmail = body.recipientEmail?.trim() ?? "";
    if (!plannedEventId || !tourStartIso || !tourEndIso || !recipientEmail) {
      return NextResponse.json({ error: "plannedEventId, tourStartIso, tourEndIso, and recipientEmail are required." }, { status: 400 });
    }

    const reminder = await upsertTourReminderForPlannedEvent(ctx.db, {
      managerUserId: ctx.userId,
      plannedEventId,
      tourStartIso,
      tourEndIso,
      recipientEmail,
      recipientName: body.recipientName?.trim() ?? recipientEmail,
      propertyTitle: body.propertyTitle?.trim(),
      instructions: body.instructions?.trim(),
      managerName: ctx.managerName,
      subject: body.subject,
      body: body.body,
      sendAt: body.sendAt,
      deliverViaEmail: body.deliverViaEmail,
      deliverViaSms: body.deliverViaSms,
    });
    const reminders = await listTourRemindersForPlannedEvent(ctx.db, ctx.userId, plannedEventId);
    return NextResponse.json({ reminder, reminders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const plannedEventId = new URL(req.url).searchParams.get("plannedEventId")?.trim() ?? "";
    if (!plannedEventId) return NextResponse.json({ error: "plannedEventId required." }, { status: 400 });
    await cancelTourReminderForPlannedEvent(ctx.db, ctx.userId, plannedEventId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
