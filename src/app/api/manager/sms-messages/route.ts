import { resolveManagerRouteActor } from "@/lib/auth/route-actor.server";
import { NextResponse } from "next/server";
import type { ManagerSmsMessageStorageTable } from "@/lib/manager-sms-messages";
import { deleteManagerSmsMessage } from "@/lib/manager-sms-messages.server";

export const runtime = "nodejs";

const STORAGE_TABLES = new Set<ManagerSmsMessageStorageTable>([
  "manager_sms_messages",
  "inbound_sms_log",
  "sms_relay_messages",
]);

async function requireManager() {
  const actor = await resolveManagerRouteActor({ route: "manager/sms-messages" });
  if (!actor.ok) return { error: NextResponse.json({ error: actor.error }, { status: actor.status }) };
  return { user: { id: actor.userId }, db: actor.db };
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
