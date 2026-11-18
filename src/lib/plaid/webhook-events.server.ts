import "server-only";

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPlaidItemByPlaidItemId, updatePlaidItem } from "@/lib/plaid/items.server";
import { syncPlaidItem } from "@/lib/plaid/transactions-sync.server";

/** Route a verified Plaid webhook to the item it names. Unknown items are ignored. */
export async function handlePlaidWebhookEvent(event: Record<string, unknown>): Promise<void> {
  const itemId = typeof event.item_id === "string" ? event.item_id : "";
  if (!itemId) return;
  const db = createSupabaseServiceRoleClient();
  const item = await getPlaidItemByPlaidItemId(db, itemId);
  if (!item) return;

  const type = event.webhook_type;
  const code = event.webhook_code;
  if (type === "TRANSACTIONS" && (code === "SYNC_UPDATES_AVAILABLE" || code === "INITIAL_UPDATE" || code === "HISTORICAL_UPDATE")) {
    await syncPlaidItem(db, item);
    return;
  }
  if (type === "ITEM") {
    if (code === "ERROR") {
      const errorCode = (event.error as { error_code?: unknown } | undefined)?.error_code;
      if (errorCode === "ITEM_LOGIN_REQUIRED") await updatePlaidItem(db, item.id, { status: "login_required", last_error: "ITEM_LOGIN_REQUIRED" });
      return;
    }
    if (code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT") {
      await updatePlaidItem(db, item.id, { status: "login_required", last_error: String(code) });
      return;
    }
    if (code === "USER_PERMISSION_REVOKED" || code === "USER_ACCOUNT_REVOKED") {
      await updatePlaidItem(db, item.id, { status: "revoked", last_error: String(code) });
    }
  }
}
