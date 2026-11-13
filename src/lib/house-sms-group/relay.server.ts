import "server-only";

import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { groupTextFor, readSmsGroupState } from "./model";
import { postToHouseSmsGroup } from "./post.server";

/**
 * A line typed in the in-app house chat goes out to the house's SMS group, from the group's projected line,
 * as "<First · Room>: <words>". A house with no live group does nothing here AND reads nothing more (the stored
 * row the caller already holds decides). Runs after the response; a failure never fails the in-app post (the
 * line is already in the thread), and the post is keyed on the line's id so a retried send goes out once.
 * Lines that ARRIVED by SMS are appended by `inbound.server.ts` directly and never pass through here, so
 * nothing echoes.
 */
export function queueHouseSmsGroupRelay(
  db: SupabaseClient,
  input: {
    rowData: Record<string, unknown>;
    ownerUserId: string;
    workspaceId: string;
    propertyId: string;
    from: string;
    body: string;
    messageId: string;
  },
): void {
  const state = readSmsGroupState(input.rowData);
  if (!state || state.status !== "active") return;
  const task = async () => {
    try {
      const posted = await postToHouseSmsGroup(db, {
        workspaceId: input.workspaceId,
        propertyId: input.propertyId,
        ownerUserId: input.ownerUserId,
        text: groupTextFor(input.from, input.body),
        kind: "relay",
        idempotencyKey: `relay:${input.messageId}`,
      });
      if (!posted.ok) console.error("house sms group relay not sent", posted.reason, posted.detail ?? "");
    } catch (error) {
      // Masked: no phone number or message body reaches a log.
      console.error("house sms group relay failed", error instanceof Error ? error.name : "unknown");
    }
  };
  try {
    after(task);
  } catch {
    void task();
  }
}
