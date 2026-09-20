import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";
import { loadDueScheduledInboxMessages } from "@/lib/scheduled-inbox-messages";
import { sendScheduledInboxMessageNow } from "@/lib/send-scheduled-inbox-message-now";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return !isProductionRuntime();
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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
