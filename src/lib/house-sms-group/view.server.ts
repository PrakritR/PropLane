import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { maskPhoneLast4, memberView, SMS_GROUP_MIN_PHONES, type SmsGroupMemberView } from "./model";
import { loadHouseSmsGroup, threadIdFor } from "./store.server";

/** What the "Text group" screen draws for one house: masked phones, never a number, sid or user id. */
export type HouseSmsGroupView = {
  exists: boolean;
  status: "none" | "pending" | "active";
  /** "•••• 9944": the line the group is projected from. */
  maskedLine: string | null;
  members: SmsGroupMemberView[];
  /** Phones still needed before Twilio can start the group (0 once it is live). */
  phonesNeeded: number;
};

export async function loadHouseSmsGroupView(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; propertyId: string },
): Promise<HouseSmsGroupView> {
  const loaded = await loadHouseSmsGroup(db, threadIdFor(input));
  const state = loaded?.state;
  if (!state) return { exists: false, status: "none", maskedLine: null, members: [], phonesNeeded: SMS_GROUP_MIN_PHONES };
  return {
    exists: true,
    status: state.status,
    maskedLine: state.line ? maskPhoneLast4(state.line) : null,
    members: state.members.map((m) => memberView(m, state.status === "active")),
    phonesNeeded: state.status === "active" ? 0 : Math.max(0, SMS_GROUP_MIN_PHONES - state.members.length),
  };
}
