import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { NextResponse } from "next/server";
import { closeRelayThread, provisionRelayThread } from "@/lib/sms-relay.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

async function requireManager(): Promise<
  | { ok: true; userId: string; name: string; phone: string; phoneVerified: boolean }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };

  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return { ok: false, response: NextResponse.json({ error: "Manager access required." }, { status: 403 }) };
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("full_name, phone, phone_verified_at")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    return { ok: false, response: NextResponse.json({ error: "Manager access required." }, { status: 403 }) };
  }
  return {
    ok: true,
    userId: user.id,
    name: String(profile?.full_name ?? "").trim() || "your property manager",
    phone: String(profile?.phone ?? "").trim(),
    phoneVerified: Boolean(profile?.phone_verified_at),
  };
}

/** GET — the signed-in manager's relay threads with their proxy numbers. */
export async function GET() {
  const auth = await requireManager();
  if (!auth.ok) return auth.response;
  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db
    .from("sms_relay_threads")
    .select("id, state, counterparty_name, counterparty_user_id, label, created_at, closed_at, sms_relay_numbers(phone_e164)")
    .eq("manager_user_id", auth.userId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    threads: (data ?? []).map((row) => ({
      id: row.id,
      state: row.state,
      counterpartyName: row.counterparty_name,
      counterpartyUserId: row.counterparty_user_id,
      label: row.label,
      proxyPhone: (row.sms_relay_numbers as { phone_e164?: string } | null)?.phone_e164 ?? null,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    })),
  });
}

/**
 * POST — provision a relay thread to a resident's phone. The manager must
 * have a verified personal phone (that's the number their binding relays to).
 */
export async function POST(req: Request) {
  const auth = await requireManager();
  if (!auth.ok) return auth.response;
  if (!auth.phone || !auth.phoneVerified) {
    return NextResponse.json(
      { error: "Verify your personal phone in Settings before opening a text relay." },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    counterpartyPhone?: string;
    counterpartyName?: string;
    counterpartyUserId?: string;
    label?: string;
  };
  const counterpartyPhone = String(body.counterpartyPhone ?? "").trim();
  if (!counterpartyPhone) return NextResponse.json({ error: "counterpartyPhone is required." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const result = await provisionRelayThread(db, {
    managerUserId: auth.userId,
    managerPhone: auth.phone,
    managerName: auth.name,
    counterpartyPhone,
    counterpartyName: String(body.counterpartyName ?? "").trim() || null,
    counterpartyUserId: String(body.counterpartyUserId ?? "").trim() || null,
    label: String(body.label ?? "").trim() || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 500 });

  track("sms_relay_thread_created", auth.userId, {});
  return NextResponse.json({ ok: true, threadId: result.threadId, proxyPhone: result.proxyPhone });
}

/** PATCH — close a thread (move-out): bindings deactivate, number cools down 30 days. */
export async function PATCH(req: Request) {
  const auth = await requireManager();
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { threadId?: string; action?: string };
  const threadId = String(body.threadId ?? "").trim();
  if (!threadId || body.action !== "close") {
    return NextResponse.json({ error: "threadId and action:'close' are required." }, { status: 400 });
  }
  const db = createSupabaseServiceRoleClient();
  const result = await closeRelayThread(db, { threadId, managerUserId: auth.userId });
  if (!result.ok) return NextResponse.json({ error: result.error ?? "Close failed." }, { status: 404 });
  track("sms_relay_thread_closed", auth.userId, {});
  return NextResponse.json({ ok: true });
}
