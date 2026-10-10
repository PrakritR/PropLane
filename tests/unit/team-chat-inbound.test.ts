import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { startsWithAssistantAddress, stripAssistantAddress } from "@/lib/sms/team-chat-routing";

type Member = { userId: string; teamRole: string | null; isOwner: boolean };
const members = vi.fn(async (..._args: unknown[]): Promise<Member[]> => []);
const post = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({
  ok: true, posted: true, threadId: "team-thread:o:ws:ws1", workspaceId: "ws1",
}));
type RelayOutcome = { memberUserId: string; status: "sent" | "skipped" | "failed"; reason?: string };
const relay = vi.fn(async (..._args: unknown[]): Promise<RelayOutcome[]> => []);
vi.mock("@/lib/team-comms.server", () => ({
  resolveWorkspaceTeamMembers: (...args: unknown[]) => members(...args),
  postTeamThreadMessage: (...args: unknown[]) => post(...args),
  relayTeamChatMessageToSms: (...args: unknown[]) => relay(...args),
  teamMemberCanPost: (member: Member | undefined) => Boolean(member) && member!.teamRole !== "viewer",
}));

const sessionLookup = vi.fn(async (..._args: unknown[]) => ({ ok: true, session: null as { id: string } | null }));
const openProposal = vi.fn(async (..._args: unknown[]): Promise<{ status: string }> => ({ status: "none" }));
vi.mock("@/lib/agent/portal-assistant-session.server", () => ({
  readPortalAssistantSmsSession: (...args: unknown[]) => sessionLookup(...args),
}));
// `classifySmsConfirmationReply` stays REAL: it is the gate that keeps a chatty "yes I will" out of
// the confirm path, so a stub here would prove nothing.
vi.mock("@/lib/sms/agent-confirmation.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/agent-confirmation.server")>()),
  resolveOpenSmsProposal: (...args: unknown[]) => openProposal(...args),
}));

import { inboxInitials } from "@/components/portal/portal-inbox-ui";
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
  relay.mockResolvedValue([]);
  sessionLookup.mockResolvedValue({ ok: true, session: null });
  openProposal.mockResolvedValue({ status: "none" });
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

  it("reports a member the relay could not text, and still completes the inbound", async () => {
    relay.mockResolvedValue([
      { memberUserId: "akhil", status: "sent" },
      { memberUserId: "akshaya", status: "failed", reason: "no_credit" },
    ]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await route("hello")).toEqual({ kind: "team", ok: true });
      expect(logged).toHaveBeenCalledWith("team-chat inbound relay undelivered", expect.stringContaining("no_credit"));
    } finally {
      logged.mockRestore();
    }
  });

  it("a replayed MessageSid re-posts nothing but still relays (the per-member dedupe key makes that exactly-once)", async () => {
    post.mockResolvedValue({ ok: true, posted: false, threadId: "team-thread:o:ws:ws1", workspaceId: "ws1" });
    expect(await route("hello")).toEqual({ kind: "team", ok: true });
    expect(relay).toHaveBeenCalledTimes(1);
  });

  it("a bare YES answering an open Assistant proposal reaches the agent, not the team", async () => {
    sessionLookup.mockResolvedValue({ ok: true, session: { id: "sess-1" } });
    openProposal.mockResolvedValue({ status: "one" });
    expect(await route("YES")).toEqual({ kind: "agent", text: "YES" });
    expect(openProposal.mock.calls[0]![1]).toMatchObject({ userId: "prakrit", sessionId: "sess-1", portal: "manager" });
    expect(post).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
  });

  it("holds a reply back from the agent when more than one proposal is open, rather than broadcasting it", async () => {
    sessionLookup.mockResolvedValue({ ok: true, session: { id: "sess-1" } });
    openProposal.mockResolvedValue({ status: "ambiguous" });
    expect(await route("no")).toEqual({ kind: "agent", text: "no" });
    expect(post).not.toHaveBeenCalled();
  });

  it("a conversational yes with nothing pending is still a team line", async () => {
    sessionLookup.mockResolvedValue({ ok: true, session: { id: "sess-1" } });
    openProposal.mockResolvedValue({ status: "none" });
    expect(await route("yes")).toEqual({ kind: "team", ok: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a sentence that merely contains yes never asks about proposals at all", async () => {
    expect(await route("yes I will meet them at 4")).toEqual({ kind: "team", ok: true });
    expect(sessionLookup).not.toHaveBeenCalled();
    expect(openProposal).not.toHaveBeenCalled();
  });

  it("fails closed to the Team chat when the session or proposal read is unavailable", async () => {
    sessionLookup.mockResolvedValue({ ok: false, session: null });
    expect(await route("YES")).toEqual({ kind: "team", ok: true });
    sessionLookup.mockResolvedValue({ ok: true, session: { id: "sess-1" } });
    openProposal.mockResolvedValue({ status: "unavailable" });
    expect(await route("YES")).toEqual({ kind: "team", ok: true });
    openProposal.mockRejectedValueOnce(new Error("db down"));
    expect(await route("YES")).toEqual({ kind: "team", ok: true });
  });

  it("a relay failure never fails the inbound (the chat line is already durable)", async () => {
    relay.mockRejectedValueOnce(new Error("sms down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await route("hello")).toEqual({ kind: "team", ok: true });
    spy.mockRestore();
  });
});

describe("team chat avatar", () => {
  it("initials skip the separator in 'Team · <workspace>'", () => {
    expect(inboxInitials("Team · Seattle Homes")).toBe("TS");
    expect(inboxInitials("Team · My workspace")).toBe("TM");
    expect(inboxInitials("Ambika Mago")).toBe("AM");
    expect(inboxInitials("+1 555 000 9253")).toBe("?");
  });
});
