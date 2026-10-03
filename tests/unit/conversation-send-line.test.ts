import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { resolveConversationSendLine } from "@/lib/sms/manager-workspace-role.server";

/**
 * S6 (comms-safety-0929): a reply with no line of its own used to leave from
 * the owner's DEFAULT workspace's number. It leaves from the conversation's
 * own line, or the house's workspace's line, or refuses when the owner has more
 * than one line and nothing places the conversation.
 */

const OWNER = "owner-1";
const seed = (numbers: number) =>
  createMemoryDb({
    manager_sms_numbers: [
      { id: "n-a", manager_user_id: OWNER, workspace_id: "ws-a", phone_number: "+12065550001" },
      ...(numbers > 1 ? [{ id: "n-b", manager_user_id: OWNER, workspace_id: "ws-b", phone_number: "+14255550002" }] : []),
      { id: "n-other", manager_user_id: "someone-else", workspace_id: "ws-x", phone_number: "+12065550999" },
    ],
    manager_property_records: [
      { id: "hA", manager_user_id: OWNER, workspace_id: "ws-a" },
      { id: "hB", manager_user_id: OWNER, workspace_id: "ws-b" },
    ],
  });

describe("resolveConversationSendLine", () => {
  it("replies on the line the conversation came in on (workspace B), not the default (A)", async () => {
    const res = await resolveConversationSendLine(seed(2) as never, OWNER, { linePhones: ["(425) 555-0002"] });
    expect(res).toMatchObject({ ok: true, numberId: "n-b", via: "line" });
  });

  it("falls to the house's workspace line", async () => {
    const res = await resolveConversationSendLine(seed(2) as never, OWNER, { propertyId: "hB" });
    expect(res).toMatchObject({ ok: true, numberId: "n-b", via: "house" });
  });

  it("refuses when two lines exist and nothing places the conversation", async () => {
    expect(await resolveConversationSendLine(seed(2) as never, OWNER, {})).toEqual({ ok: false, reason: "work_line_ambiguous" });
    expect(await resolveConversationSendLine(seed(2) as never, OWNER, { linePhones: ["+19995550000"] })).toEqual({
      ok: false,
      reason: "work_line_ambiguous",
    });
  });

  it("an owner with one line needs no placement", async () => {
    expect(await resolveConversationSendLine(seed(1) as never, OWNER, {})).toMatchObject({ ok: true, numberId: "n-a", via: "only" });
  });

  it("never returns another owner's line", async () => {
    const res = await resolveConversationSendLine(seed(2) as never, OWNER, { linePhones: ["+12065550999"] });
    expect(res.ok).toBe(false);
  });
});
