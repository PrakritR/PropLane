import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startsWithAssistantAddress, stripAssistantAddress } from "@/lib/sms/team-chat-routing";

type Member = { userId: string; teamRole: string | null; isOwner: boolean };
const members = vi.fn(async (..._args: unknown[]): Promise<Member[]> => []);
const post = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
  ok: true, posted: true, threadId: "team-thread:o:ws:ws1", workspaceId: "ws1",
}));
const relay = vi.fn(async (..._args: unknown[]) => []);
vi.mock("@/lib/team-comms.server", () => ({
  resolveWorkspaceTeamMembers: (...args: unknown[]) => members(...args),
  postTeamThreadMessage: (...args: unknown[]) => post(...args),
  relayTeamChatMessageToSms: (...args: unknown[]) => relay(...args),
  teamMemberCanPost: (member: Member | undefined) => Boolean(member) && member!.teamRole !== "viewer",
}));

import { routeManagerInboundText } from "@/lib/sms/team-chat-inbound.server";

const db = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { full_name: "Prakrit Ramachandran" } }) }) }) }),
} as unknown as SupabaseClient;

const trio: Member[] = [
  { userId: "owner", teamRole: null, isOwner: true },
  { userId: "prakrit", teamRole: "admin", isOwner: false },
  { userId: "akshaya", teamRole: "property_manager", isOwner: false },
];

const route = (body: string, actorUserId = "prakrit") =>
  routeManagerInboundText(db, { ownerManagerUserId: "owner", workspaceId: "ws1", actorUserId, body, messageSid: "SM123" });

beforeEach(() => {
  vi.clearAllMocks();
  members.mockResolvedValue(trio);
  post.mockResolvedValue({ ok: true, posted: true, threadId: "team-thread:o:ws:ws1", workspaceId: "ws1" });
});

describe("assistant address", () => {
  it("recognises @assistant, 'assistant,' / 'assistant:' and @ai at the start, in any case", () => {
    for (const body of ["@assistant who's late?", "@Assistant who's late?", "assistant, who's late?", "Assistant: who's late?", "@ai who's late?", "@AI who's late?", "  @assistant who's late?"]) {
      expect(startsWithAssistantAddress(body), body).toBe(true);
    }
  });

  it("does not treat mid-sentence mentions or look-alikes as the address", () => {
    for (const body of ["ask the @assistant later", "@air filter is due", "assistants are great", "the assistant, he said", "assistant manager is here", "hello"]) {
      expect(startsWithAssistantAddress(body), body).toBe(false);
    }
  });

  it("strips the address and keeps the question", () => {
    expect(stripAssistantAddress("@assistant who's late on rent at 5257?")).toBe("who's late on rent at 5257?");
    expect(stripAssistantAddress("Assistant: who's late?")).toBe("who's late?");
    expect(stripAssistantAddress("@ai, status")).toBe("status");
    expect(stripAssistantAddress("@assistant")).toBe("@assistant"); // nothing to ask: kept whole
  });
});

describe("routeManagerInboundText", () => {
  it("a plain text from a member of a team workspace goes to the Team chat as that member (channel sms, idempotent on the MessageSid) and is relayed to the others", async () => {
    const result = await route("I'll meet the plumber at 5257 at 4");
    expect(result).toEqual({ kind: "team", ok: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({
      ownerManagerUserId: "owner", workspaceId: "ws1", actorUserId: "prakrit",
      actorName: "Prakrit Ramachandran", text: "I'll meet the plumber at 5257 at 4",
      messageId: "team-sms:SM123", channel: "sms",
    });
    expect(relay.mock.calls[0]![1]).toMatchObject({
      ownerManagerUserId: "owner", workspaceId: "ws1", senderUserId: "prakrit",
      senderName: "Prakrit Ramachandran", messageId: "team-sms:SM123",
    });
  });

  it("an '@assistant' text goes to the agent with the address stripped; nothing is posted or relayed", async () => {
    const result = await route("@assistant who's late on rent at 5257?");
    expect(result).toEqual({ kind: "agent", text: "who's late on rent at 5257?" });
    expect(post).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
  });

  it("a one-member workspace keeps today's behavior: every text goes to the agent, unchanged", async () => {
    members.mockResolvedValue([trio[0]!]);
    expect(await route("what's due this week?", "owner")).toEqual({ kind: "agent", text: "what's due this week?" });
    expect(post).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
  });

  it("a sender who is not a member of THIS number's workspace is not given the team's chat", async () => {
    members.mockResolvedValue(trio);
    expect(await route("hello team", "someone-in-another-workspace")).toEqual({ kind: "agent", text: "hello team" });
    expect(post).not.toHaveBeenCalled();
  });

  it("a Viewer does not post to the chat from a text either", async () => {
    members.mockResolvedValue([...trio, { userId: "vee", teamRole: "viewer", isOwner: false }]);
    expect(await route("hello", "vee")).toEqual({ kind: "agent", text: "hello" });
    expect(post).not.toHaveBeenCalled();
  });

  it("the owner texting is a team line too (relayed to the teammates, never back to her)", async () => {
    await route("gate code is in the house page", "owner");
    expect(post.mock.calls[0]![1]).toMatchObject({ actorUserId: "owner", channel: "sms" });
    expect(relay.mock.calls[0]![1]).toMatchObject({ senderUserId: "owner" });
  });

  it("a failed append asks the caller to retry the whole inbound and relays nothing", async () => {
    post.mockResolvedValue({ ok: false, error: "Could not post to the team thread." });
    expect(await route("hello")).toEqual({ kind: "team", ok: false });
    expect(relay).not.toHaveBeenCalled();
  });

  it("a replayed MessageSid re-posts nothing but still relays (the per-member dedupe key makes that exactly-once)", async () => {
    post.mockResolvedValue({ ok: true, posted: false, threadId: "team-thread:o:ws:ws1", workspaceId: "ws1" });
    expect(await route("hello")).toEqual({ kind: "team", ok: true });
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it("a relay failure never fails the inbound (the chat line is already durable)", async () => {
    relay.mockRejectedValueOnce(new Error("sms down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await route("hello")).toEqual({ kind: "team", ok: true });
    spy.mockRestore();
  });
});
