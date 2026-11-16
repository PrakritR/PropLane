/**
 * Communication auto-reply.
 *
 * Two things here are safety-critical rather than cosmetic: the transcript must
 * reach the model in the right order and role, and the turn must never be able
 * to execute a write without a human confirming it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAgentTurn = vi.fn();
const resolveCtx = vi.fn();

vi.mock("@/lib/agent/loop", () => ({ runAgentTurn: (...args: unknown[]) => runAgentTurn(...args) }));
vi.mock("@/lib/tools/resident-index", () => ({ residentAgentRegistry: { tools: {} } }));
vi.mock("@/lib/tools/resident-inbox-context", () => ({
  resolveResidentInboxAgentContext: (...args: unknown[]) => resolveCtx(...args),
}));

const { autoRespondToResidentInboxMessage, buildTurnMessages, MAX_HISTORY_MESSAGES } = await import(
  "@/lib/agent/inbox-auto-respond.server"
);

const db = {} as never;
const okCtx = { ok: true, ctx: { kind: "resident", userId: "u1", email: "r@x.com" } };

describe("buildTurnMessages", () => {
  it("keeps the transcript in order and ends on the incoming message", () => {
    const out = buildTurnMessages(
      [
        { from: "resident", body: "when is rent due?" },
        { from: "manager", body: "the 1st" },
      ],
      "and how much?",
    );
    expect(out).toEqual([
      { role: "user", content: "when is rent due?" },
      { role: "assistant", content: "the 1st" },
      { role: "user", content: "and how much?" },
    ]);
  });

  it("maps the resident to user and the other side to assistant", () => {
    const out = buildTurnMessages([{ from: "manager", body: "hi" }], "hello");
    expect(out[0]!.role).toBe("assistant");
    expect(out[1]!.role).toBe("user");
  });

  it("bounds history so a long thread cannot grow the turn without limit", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({
      from: "resident" as const,
      body: `m${i}`,
    }));
    const out = buildTurnMessages(history, "latest");
    expect(out).toHaveLength(MAX_HISTORY_MESSAGES + 1);
    // Keeps the RECENT end, not the oldest.
    expect(out[0]!.content).toBe("m28");
    expect(out.at(-1)!.content).toBe("latest");
  });

  it("drops blank entries rather than sending empty turns", () => {
    const out = buildTurnMessages(
      [{ from: "resident", body: "   " }, { from: "manager", body: "real" }],
      "q",
    );
    expect(out.map((m) => m.content)).toEqual(["real", "q"]);
  });
});

describe("autoRespondToResidentInboxMessage", () => {
  beforeEach(() => {
    runAgentTurn.mockReset();
    resolveCtx.mockReset();
  });

  it("refuses an empty message before doing any work", async () => {
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "   ",
    });
    expect(out).toEqual({ ok: false, reason: "empty_message" });
    expect(resolveCtx).not.toHaveBeenCalled();
  });

  it("refuses when the resident is not bound to the thread's manager", async () => {
    resolveCtx.mockResolvedValue({ ok: false, reason: "manager_not_linked" });
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "other-manager",
      residentEmail: "r@x.com",
      incomingText: "what is my balance?",
    });
    expect(out).toEqual({ ok: false, reason: "manager_not_linked" });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("NEVER allow-lists a write tool — every write has to be confirmed", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    runAgentTurn.mockResolvedValue({ reply: "ok", model: "m", pendingAction: undefined });
    await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "pay my rent",
    });
    const opts = runAgentTurn.mock.calls[0]![0] as { allowWriteTools: string[]; readOnly?: boolean };
    expect(opts.allowWriteTools).toEqual([]);
    // readOnly would HIDE write tools, leaving the assistant unable to offer
    // anything; the proposal gate is what makes them safe, not concealment.
    expect(opts.readOnly).toBeUndefined();
  });

  it("the thread auto-reply surface is read-only on its own tool shortlist, with its own prompt and trace", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    runAgentTurn.mockResolvedValue({ reply: "ok", model: "m", pendingAction: undefined });
    const registryFor = vi.fn(() => ({ tools: {} }) as never);
    await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "wifi?",
      surface: { system: "SURFACE", promptId: "p", traceName: "t", registryFor, toolNames: ["get_move_in_info"], expectedUserId: "u1" },
    });
    const opts = runAgentTurn.mock.calls[0]![0] as { allowWriteTools: string[]; readOnly?: boolean; toolNames?: string[]; system: string };
    expect(opts.readOnly).toBe(true);
    expect(opts.toolNames).toEqual(["get_move_in_info"]);
    expect(opts.allowWriteTools).toEqual([]);
    expect(opts.system).toBe("SURFACE");
    expect(registryFor).toHaveBeenCalledWith(okCtx.ctx);
  });

  it("refuses when the email resolves to someone other than the authenticated resident", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "wifi?",
      surface: { system: "S", promptId: "p", traceName: "t", registryFor: () => ({ tools: {} }) as never, toolNames: [], expectedUserId: "someone-else" },
    });
    expect(out).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("passes a write proposal back for the caller to persist and confirm", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    const pendingAction = { toolName: "schedule_message", input: {}, preview: { title: "x" }, destructive: false };
    runAgentTurn.mockResolvedValue({ reply: "I can do that", model: "m", pendingAction });
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "remind me",
    });
    expect(out).toMatchObject({ ok: true, reply: "I can do that", pendingAction });
  });

  it("still succeeds when the model only proposes and says nothing", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    runAgentTurn.mockResolvedValue({
      reply: "",
      model: "m",
      pendingAction: { toolName: "t", input: {}, preview: {}, destructive: false },
    });
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "do it",
    });
    expect(out.ok).toBe(true);
  });

  it("reports a failed turn instead of throwing into the send path", async () => {
    resolveCtx.mockResolvedValue(okCtx);
    runAgentTurn.mockRejectedValue(new Error("upstream 529"));
    const out = await autoRespondToResidentInboxMessage(db, {
      managerUserId: "m1",
      residentEmail: "r@x.com",
      incomingText: "hi",
    });
    expect(out).toEqual({ ok: false, reason: "upstream 529" });
  });
});
