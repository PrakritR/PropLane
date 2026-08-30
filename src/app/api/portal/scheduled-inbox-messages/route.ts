import { NextResponse } from "next/server";
import { filterRecipientsBySenderScope } from "@/lib/inbox-recipient-scope";
import {
  createScheduledInboxMessage,
  generateScheduledInboxMessageId,
  loadScheduledInboxMessagesForManager,
  loadScheduledInboxMessagesForResident,
} from "@/lib/scheduled-inbox-messages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type PortalRole = "manager" | "resident";

type PortalActor = {
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
  userId: string;
  role: PortalRole;
  email: string;
  name: string;
  isManager: boolean;
  isResident: boolean;
};

async function requirePortalActor(preferredRole?: PortalRole): Promise<PortalActor | null> {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role, email, full_name").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || roleList.includes("admin") || legacy === "manager" || legacy === "admin";
  const isResident = roleList.includes("resident") || legacy === "resident";
  if (!isManager && !isResident) return null;

  const email = (profile?.email ?? user.email ?? "").trim().toLowerCase();
  if (!email) return null;

  let role: PortalRole;
  if (isManager && isResident) {
    role = preferredRole === "resident" ? "resident" : "manager";
  } else {
    role = isManager ? "manager" : "resident";
  }

  return {
    db,
    userId: user.id,
    role,
    email,
    name: profile?.full_name?.trim() || email,
    isManager,
    isResident,
  };
}

function parsePreferredRole(req: Request, body?: { senderPortal?: string }): PortalRole | undefined {
  const url = new URL(req.url);
  const queryRole = url.searchParams.get("as");
  if (queryRole === "resident" || queryRole === "manager") return queryRole;
  if (body?.senderPortal === "resident") return "resident";
  if (body?.senderPortal === "manager") return "manager";
  return undefined;
}

async function resolveManagerUserIdForEmail(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  email: string,
): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const { data: profile } = await db.from("profiles").select("id").eq("email", normalized).maybeSingle();
  if (profile?.id) return profile.id as string;
  const { data: fallback } = await db.from("profiles").select("id").ilike("email", normalized).maybeSingle();
  return (fallback?.id as string | undefined) ?? null;
}

export async function GET(req: Request) {
  try {
    const preferredRole = parsePreferredRole(req);
    const ctx = await requirePortalActor(preferredRole);
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    if (ctx.role === "resident") {
      const messages = await loadScheduledInboxMessagesForResident(ctx.db, ctx.userId);
      return NextResponse.json({ messages });
    }

    const messages = await loadScheduledInboxMessagesForManager(ctx.db, ctx.userId);
    return NextResponse.json({ messages });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      subject?: string;
      body?: string;
      sendAt?: string;
      recipientEmail?: string;
      recipientName?: string;
      recipientUserId?: string;
      broadcastCategories?: unknown;
      deliverViaEmail?: boolean;
      deliverViaSms?: boolean;
      senderPortal?: string;
    };

    const preferredRole = parsePreferredRole(req, body);
    const ctx = await requirePortalActor(preferredRole);
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const subject = String(body.subject ?? "").trim();
    const messageBody = String(body.body ?? "").trim();
    const sendAtRaw = String(body.sendAt ?? "").trim();
    const broadcastCategories = (Array.isArray(body.broadcastCategories) ? body.broadcastCategories : []).filter(
      (c): c is "management" | "resident" => c === "management" || c === "resident",
    );
    const recipientEmail = String(body.recipientEmail ?? "").trim().toLowerCase();
    const recipientName = String(body.recipientName ?? "").trim();

    if (!subject || !messageBody) {
      return NextResponse.json({ error: "Subject and message are required." }, { status: 400 });
    }
    if (!sendAtRaw) {
      return NextResponse.json({ error: "Send date and time are required." }, { status: 400 });
    }
    const sendAt = new Date(sendAtRaw);
    if (Number.isNaN(sendAt.getTime())) {
      return NextResponse.json({ error: "Invalid send date." }, { status: 400 });
    }
    if (sendAt.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: "Send time must be in the future." }, { status: 400 });
    }

    if (ctx.role === "resident") {
      if (broadcastCategories.length) {
        return NextResponse.json({ error: "Residents can only message their manager directly." }, { status: 400 });
      }
      if (!recipientEmail || !recipientEmail.includes("@")) {
        return NextResponse.json({ error: "Choose your property manager." }, { status: 400 });
      }
      const { allowed } = await filterRecipientsBySenderScope(
        ctx.db,
        {
          id: ctx.userId,
          email: ctx.email,
          role: "resident",
          isAdmin: false,
        },
        [{ email: recipientEmail, userId: null }],
      );
      if (!allowed.some((r) => r.email.trim().toLowerCase() === recipientEmail)) {
        return NextResponse.json({ error: "That recipient is not in your messaging scope." }, { status: 403 });
      }

      const recipientUserId = await resolveManagerUserIdForEmail(ctx.db, recipientEmail);
      if (!recipientUserId) {
        return NextResponse.json({ error: "Could not resolve your manager." }, { status: 400 });
      }

      const record = await createScheduledInboxMessage(ctx.db, {
        id: generateScheduledInboxMessageId(),
        managerUserId: recipientUserId,
        sendAt: sendAt.toISOString(),
        status: "scheduled",
        subject,
        body: messageBody,
        recipientEmail,
        recipientName: recipientName || recipientEmail,
        recipientUserId,
        deliverViaEmail: body.deliverViaEmail !== false,
        deliverViaSms: body.deliverViaSms !== false,
        senderPortal: "resident",
        senderUserId: ctx.userId,
        senderName: ctx.name,
        senderEmail: ctx.email,
      });

      return NextResponse.json({ ok: true, message: record });
    }

    if (!broadcastCategories.length && (!recipientEmail || !recipientEmail.includes("@"))) {
      const recipientUserIdFromBody = String(body.recipientUserId ?? "").trim();
      if (!recipientUserIdFromBody) {
        return NextResponse.json({ error: "Choose a recipient or a broadcast group." }, { status: 400 });
      }
      const { allowed } = await filterRecipientsBySenderScope(
        ctx.db,
        {
          id: ctx.userId,
          email: ctx.email,
          role: ctx.role,
          isAdmin: false,
        },
        [{ email: "", userId: recipientUserIdFromBody }],
      );
      if (allowed.length === 0) {
        return NextResponse.json({ error: "That recipient is not in your messaging scope." }, { status: 403 });
      }

      const { data: recipientProfile } = await ctx.db
        .from("profiles")
        .select("email, full_name")
        .eq("id", recipientUserIdFromBody)
        .maybeSingle();
      const resolvedEmail = String(recipientProfile?.email ?? "").trim().toLowerCase();
      const resolvedName =
        recipientName ||
        String(recipientProfile?.full_name ?? "").trim() ||
        (resolvedEmail.includes("@") ? resolvedEmail : "Co-manager");

      const record = await createScheduledInboxMessage(ctx.db, {
        id: generateScheduledInboxMessageId(),
        managerUserId: ctx.userId,
        sendAt: sendAt.toISOString(),
        status: "scheduled",
        subject,
        body: messageBody,
        recipientEmail: resolvedEmail.includes("@") ? resolvedEmail : "",
        recipientName: resolvedName,
        recipientUserId: recipientUserIdFromBody,
        deliverViaEmail: body.deliverViaEmail !== false,
        deliverViaSms: body.deliverViaSms === true,
        senderPortal: "manager",
        senderUserId: ctx.userId,
        senderName: ctx.name,
        senderEmail: ctx.email,
      });

      return NextResponse.json({ ok: true, message: record });
    }

    let recipientUserId: string | null = String(body.recipientUserId ?? "").trim() || null;
    if (recipientEmail && !broadcastCategories.length) {
      recipientUserId = await resolveManagerUserIdForEmail(ctx.db, recipientEmail);
    }

    const record = await createScheduledInboxMessage(ctx.db, {
      id: generateScheduledInboxMessageId(),
      managerUserId: ctx.userId,
      sendAt: sendAt.toISOString(),
      status: "scheduled",
      subject,
      body: messageBody,
      recipientEmail: broadcastCategories.length ? broadcastCategories.join("+") : recipientEmail,
      recipientName: broadcastCategories.length
        ? broadcastCategories.includes("resident")
          ? "All residents"
          : "All management"
        : recipientName || recipientEmail,
      recipientUserId,
      broadcastCategories: broadcastCategories.length ? broadcastCategories : undefined,
      deliverViaEmail: body.deliverViaEmail !== false,
      deliverViaSms: body.deliverViaSms === true,
      senderPortal: "manager",
      senderUserId: ctx.userId,
    });

    return NextResponse.json({ ok: true, message: record });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
