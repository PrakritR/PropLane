import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { NextResponse } from "next/server";
import type { ManagerSmsMessageStorageTable } from "@/lib/manager-sms-messages";
import { deleteManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const STORAGE_TABLES = new Set<ManagerSmsMessageStorageTable>([
  "manager_sms_messages",
  "inbound_sms_log",
  "sms_relay_messages",
]);

async function requireManager() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return { error: NextResponse.json({ error: "Manager access required." }, { status: 403 }) };
  return { user, db };
}

/** Delete one stored SMS row from a manager conversation thread. */
export async function DELETE(req: Request) {
  const auth = await requireManager();
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => ({}))) as {
    messageId?: string;
    storageTable?: ManagerSmsMessageStorageTable;
  };
  const messageId = String(body.messageId ?? "").trim();
  const storageTable = String(body.storageTable ?? "").trim() as ManagerSmsMessageStorageTable;
  if (!messageId) return NextResponse.json({ error: "Message id required." }, { status: 400 });
  if (!STORAGE_TABLES.has(storageTable)) {
    return NextResponse.json({ error: "Invalid message store." }, { status: 400 });
  }

  const result = await deleteManagerSmsMessage(auth.db, {
    viewerUserId: auth.user.id,
    messageId,
    storageTable,
  });
  if (!result.ok) {
    const status = result.status ?? 500;
    const message =
      result.error === "forbidden"
        ? "You do not have edit access to this message."
        : result.error === "not_found"
          ? "Message not found."
          : "Could not delete message.";
    return NextResponse.json({ error: message }, { status });
  }
  return NextResponse.json({ ok: true });
}
