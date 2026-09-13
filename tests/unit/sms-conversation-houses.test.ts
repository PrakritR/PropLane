/**
 * Every Communication thread knows its house(s), because one workspace number
 * is shared by the whole team and the houses decide who sees the thread.
 *
 * Tags come from a record or an explicit match, never a guess; a manual pick
 * outranks the rest and is the only thing that clears a thread.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  loadConversationHouses,
  setConversationHousesManually,
  tagConversationHouse,
  tagProspectThreadFromAgent,
} from "@/lib/sms/conversation-houses.server";

const owner = "owner-1";
const key = `${owner}:prospect:+12065550100`;

describe("tagConversationHouse", () => {
  it("is additive and idempotent, and an automatic tag never overwrites an existing one", async () => {
    const db = createMemoryDb({ manager_sms_conversation_houses: [] });
    expect(await tagConversationHouse(db as never, { managerUserId: owner, conversationKey: key, propertyId: "h1", source: "leasing" })).toBe(true);
    expect(await tagConversationHouse(db as never, { managerUserId: owner, conversationKey: key, propertyId: "h1", source: "tour" })).toBe(true);
    expect(await tagConversationHouse(db as never, { managerUserId: owner, conversationKey: key, propertyId: "h2", source: "tour" })).toBe(true);
    const tags = await loadConversationHouses(db as never, [owner]);
    expect(tags.get(key)).toEqual([
      { propertyId: "h1", source: "leasing" },
      { propertyId: "h2", source: "tour" },
    ]);
  });

  it("delegates manual replacement to the atomic RPC with its authorized snapshot", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const expectedTags = [{ conversation_key: key, property_id: "h1" }];
    expect(await setConversationHousesManually({ rpc } as never, {
      managerUserId: owner, conversationKey: key, propertyIds: [" h3 ", "h3"], taggedByUserId: "co-1",
      memberKeys: [key], expectedTags, accessRevision: "revision",
    })).toBe(true);
    expect(rpc).toHaveBeenCalledWith("replace_conversation_houses", {
      p_owner: owner, p_actor: "co-1", p_key: key, p_member_keys: [key], p_next: ["h3"],
      p_expected_tags: expectedTags, p_access_revision: "revision",
    });
  });

  it("does not report an RPC error or stale authorization result as saved", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "failed" } })
      .mockResolvedValueOnce({ data: false, error: null });
    const args = { managerUserId: owner, conversationKey: key, propertyIds: [], taggedByUserId: "co-1",
      memberKeys: [key], expectedTags: [], accessRevision: "revision" };
    expect(await setConversationHousesManually({ rpc } as never, args)).toBe(false);
    expect(await setConversationHousesManually({ rpc } as never, args)).toBe(false);
  });

  it("ignores blank ids and keys instead of writing a junk row", async () => {
    const db = createMemoryDb({ manager_sms_conversation_houses: [] });
    expect(await tagConversationHouse(db as never, { managerUserId: owner, conversationKey: " ", propertyId: "h1", source: "leasing" })).toBe(false);
    expect(await tagConversationHouse(db as never, { managerUserId: owner, conversationKey: key, propertyId: "", source: "leasing" })).toBe(false);
    expect(db.__tables.manager_sms_conversation_houses).toHaveLength(0);
  });
});

describe("tagProspectThreadFromAgent — tags only what is ours to tag", () => {
  it("tags a texting prospect's thread under the workspace owner", async () => {
    const db = createMemoryDb({ manager_sms_conversation_houses: [] });
    await tagProspectThreadFromAgent(db as never, {
      landlordId: owner,
      prospectPhoneE164: "+12065550100",
      channel: "sms",
      propertyId: "h1",
      propertyOwnerUserId: owner,
      source: "leasing",
    });
    expect((await loadConversationHouses(db as never, [owner])).get(key)).toEqual([{ propertyId: "h1", source: "leasing" }]);
  });

  it("does nothing for an emailed prospect (no SMS thread) or another manager's house", async () => {
    const db = createMemoryDb({ manager_sms_conversation_houses: [] });
    await tagProspectThreadFromAgent(db as never, {
      landlordId: owner, prospectPhoneE164: null, channel: "email", propertyId: "h1", propertyOwnerUserId: owner, source: "leasing",
    });
    await tagProspectThreadFromAgent(db as never, {
      landlordId: owner, prospectPhoneE164: "+12065550100", channel: "sms", propertyId: "h9", propertyOwnerUserId: "someone-else", source: "leasing",
    });
    expect(db.__tables.manager_sms_conversation_houses).toHaveLength(0);
  });
});

describe("no tag is ever a guess", () => {
  it("the keyword leasing bot tags only an explicit hint, never the default-property fallback", () => {
    const bot = readFileSync("src/lib/claw-leasing-bot.server.ts", "utf8");
    const tagAt = bot.indexOf('source: "leasing"');
    expect(tagAt).toBeGreaterThan(-1);
    const guard = bot.slice(bot.lastIndexOf("if (", tagAt), tagAt);
    expect(guard).toContain("hinted?.propertyId");
    expect(guard).not.toContain("defaultPropertyId");
  });

  it("the manual route re-derives ownership of every house id from the body", () => {
    const route = readFileSync("src/app/api/manager/sms-conversations/houses/route.ts", "utf8");
    expect(route).toContain("findPropertyIdsNotOwnedByManager(auth.db, ownerId, propertyIds)");
    expect(route).toContain('resolveSmsScopeManagerIds(auth.db, auth.user.id, "edit")');
  });
});
