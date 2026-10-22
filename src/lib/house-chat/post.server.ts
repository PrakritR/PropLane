import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { houseThreadId } from "@/lib/house-thread-id";
import { assertHouseThreadAccess, type HouseAccess } from "./access.server";
import { housemateLabel } from "./model";
import { appendHouseLine, loadHouseThread } from "./store.server";

/**
 * The stored id of one post. Every housemate reads message ids, so it is a digest of the poster and the client's
 * send token (stable across a retry, so a retry posts once) and never carries an account id.
 */
export function houseReplyMessageId(userId: string, token: string): string {
  return `house-reply:${createHash("sha256").update(`${userId}\0${token}`).digest("hex").slice(0, 32)}`;
}

/** A house chat line is plain text; the cap keeps one post from becoming a document. */
export const HOUSE_CHAT_MAX_TEXT = 4000;

export type HouseChatPostInput = {
  threadId: string;
  userId: string;
  email: string;
  /** The poster's own account name (profile), used for the team side. */
  fromName: string;
  text: string;
  hasAttachments: boolean;
  messageId: string;
};

export type HouseChatPostResult =
  | { ok: true; posted: boolean }
  | { ok: false; status: 400 | 403 | 404 | 500; error: string };

/**
 * Authorize then append. Membership is re-derived from the thread id on this write (fresh occupancy read);
 * a resident is drawn as "First · Room", a teammate by their account name. No SMS, no email: the in-app
 * thread is the channel, and the SMS group stays the SMS house group's job.
 */
export async function postToHouseChat(
  db: SupabaseClient,
  input: HouseChatPostInput,
  deps: { access?: (threadId: string) => Promise<HouseAccess> } = {},
): Promise<HouseChatPostResult> {
  const text = input.text.trim();
  if (!text) return { ok: false, status: 400, error: "Write a message first." };
  if (text.length > HOUSE_CHAT_MAX_TEXT) return { ok: false, status: 400, error: "That message is too long." };
  if (input.hasAttachments) return { ok: false, status: 400, error: "Files can't be shared in the house chat yet." };

  const access = deps.access
    ? await deps.access(input.threadId)
    : await assertHouseThreadAccess(db, { threadId: input.threadId, userId: input.userId, email: input.email, level: "edit", fresh: true });
  if (!access.ok || !access.canPost) return { ok: false, status: 403, error: "You cannot post to this house chat." };

  // The STORED id, rebuilt from what the gate authorized: a resident posts with the opaque alias.
  const threadId = houseThreadId(access.parsed.ownerManagerUserId, access.parsed.workspaceId, access.parsed.propertyId);
  const stored = await loadHouseThread(db, threadId);
  if (!stored) return { ok: false, status: 404, error: "House chat not found." };

  const from = access.kind === "resident" ? housemateLabel(access.resident) : input.fromName.trim() || "Team";
  const appended = await appendHouseLine(db, threadId, {
    id: input.messageId,
    from,
    body: text,
    actorUserId: input.userId,
  });
  if (!appended.ok) return { ok: false, status: 500, error: "Could not post to the house chat." };
  return { ok: true, posted: appended.posted };
}

export async function handleHouseChatPost(db: SupabaseClient, input: HouseChatPostInput): Promise<NextResponse> {
  const result = await postToHouseChat(db, input);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, houseHandled: true, posted: result.posted });
}
