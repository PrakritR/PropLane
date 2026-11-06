import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { loadManagerScheduledMessages } from "@/lib/payment-automation-server";
import { setDateReminderKey, upsertScheduledMessageOverride } from "@/lib/payment-automation-settings";
import { restoreFuturePaymentRemindersForCharge } from "@/lib/payment-reminder-lifecycle.server";
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
  if (!(await userHoldsManagerRole(db, user.id))) return null;
  return { db, userId: user.id };
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const includeHidden = url.searchParams.get("includeHidden") === "1";

    const { settings, messages } = await loadManagerScheduledMessages(ctx.db, ctx.userId, { includeHidden });
    return NextResponse.json({ settings, messages });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Add a one-off set-date reminder for a single charge. */
export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as { chargeId?: string; date?: string; action?: string };
    const chargeId = typeof body.chargeId === "string" ? body.chargeId.trim() : "";

    if (body.action === "restoreForPending") {
      if (!chargeId) {
        return NextResponse.json({ error: "chargeId is required." }, { status: 400 });
      }
      const { data: chargeRow } = await ctx.db
        .from("portal_household_charge_records")
        .select("id, manager_user_id")
        .eq("id", chargeId)
        .maybeSingle();
      if (!chargeRow || chargeRow.manager_user_id !== ctx.userId) {
        return NextResponse.json({ error: "Charge not found." }, { status: 404 });
      }
      const restored = await restoreFuturePaymentRemindersForCharge(ctx.db, ctx.userId, chargeId);
      return NextResponse.json({ ok: true, restored });
    }

    const dateKey = typeof body.date === "string" ? setDateReminderKey(body.date.trim()) : null;
    if (!chargeId || dateKey == null) {
      return NextResponse.json({ error: "A charge and a valid date (YYYY-MM-DD) are required." }, { status: 400 });
    }

    const { data: chargeRow } = await ctx.db
      .from("portal_household_charge_records")
      .select("id, manager_user_id")
      .eq("id", chargeId)
      .maybeSingle();
    if (!chargeRow || chargeRow.manager_user_id !== ctx.userId) {
      return NextResponse.json({ error: "Charge not found." }, { status: 404 });
    }

    await upsertScheduledMessageOverride(ctx.db, {
      managerUserId: ctx.userId,
      chargeId,
      kind: "set_date",
      daysBeforeDue: dateKey,
      patch: { cancelled: false },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
