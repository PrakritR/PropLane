import { requireCronSecret } from "@/lib/cron-auth.server";
import { NextResponse } from "next/server";
import { loadDueScheduledInboxMessages } from "@/lib/scheduled-inbox-messages.server";
import { sendScheduledInboxMessageNow } from "@/lib/send-scheduled-inbox-message-now";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!requireCronSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  const due = await loadDueScheduledInboxMessages(db);
  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const message of due) {
    const result = await sendScheduledInboxMessageNow(db, message);
    if (result.ok) sent++;
    else {
      failed++;
      errors.push(`${message.id}: ${result.error ?? "Delivery pending"}`);
    }
  }
  return NextResponse.json({ ok: true, sent, failed, errors: errors.length ? errors : undefined });
}
