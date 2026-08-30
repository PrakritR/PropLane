/**
 * The resident assistant's proposal has to become a ROW, not just a sentence.
 *
 * The agent loop returns a proposed write; it does not store one. Without the
 * insert the assistant ends the turn asking "shall I go ahead?" with nothing
 * behind it — the resident's portal shows no card to approve, and saying yes
 * just makes the next turn propose again. `portal: "resident"` is load-bearing:
 * the confirm gate is portal-bound and refuses a claimed row whose portal does
 * not match the calling route.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const autoRespond = vi.fn();
vi.mock("@/lib/agent/inbox-auto-respond.server", () => ({
  autoRespondToResidentInboxMessage: (...args: unknown[]) => autoRespond(...args),
}));

const { runResidentInboxAgentTurn, residentAgentThreadId, RESIDENT_AGENT_FROM_NAME } = await import(
  "@/lib/agent/resident-inbox-agent.server"
);

const RESIDENT = "d1b42a92-0784-4ccc-b857-41db374547e1";
const MANAGER = "552b562f-e9cb-443b-84ec-48018fc0fa19";
const THREAD_ID = residentAgentThreadId(RESIDENT, MANAGER);

const PREVIEW = {
  title: "Report a maintenance issue",
  fields: [
    { label: "Issue", value: "Kitchen sink is leaking" },
    { label: "Unit", value: "Room 7" },
  ],
  confirmLabel: "Submit request",
};

type Captured = { pendingInserts: Record<string, unknown>[]; threadUpserts: Record<string, unknown>[] };

function fakeDb(opts: { insertFails?: boolean } = {}) {
  const captured: Captured = { pendingInserts: [], threadUpserts: [] };
  const threadRow = {
    id: THREAD_ID,
    row_data: {
      scope: "axis_portal_inbox_resident_v1",
      messages: [{ from: "PropLane Portal", body: "the kitchen sink is leaking", at: "Aug 30, 9:00 AM" }],
    },
  };
  const db = {
    from(table: string) {
      if (table === "agent_pending_actions") {
        return {
          insert(payload: Record<string, unknown>) {
            captured.pendingInserts.push(payload);
            return {
              select: () => ({
                single: async () =>
                  opts.insertFails
                    ? { data: null, error: { message: "insert refused", code: "42501" } }
                    : { data: { id: "pending-action-1" }, error: null },
              }),
            };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: threadRow, error: null }) }) }),
        upsert: async (payload: Record<string, unknown>) => {
          captured.threadUpserts.push(payload);
          return { data: null, error: null };
        },
      };
    },
  };
  return { db: db as never, captured };
}

const target = {
  threadId: THREAD_ID,
  scope: "axis_portal_inbox_resident_v1",
  ownerUserId: RESIDENT,
  participantEmail: "resident@example.com",
  threadType: "resident_agent",
  rowData: {},
};

function residentVisibleReply(captured: Captured): string {
  const rowData = captured.threadUpserts.at(-1)?.row_data as { messages: { from: string; body: string }[] };
  const last = rowData.messages.at(-1)!;
  expect(last.from).toBe(RESIDENT_AGENT_FROM_NAME);
  return last.body;
}

beforeEach(() => {
  autoRespond.mockReset();
});

describe("resident assistant proposals", () => {
  it("persists the proposal so the resident has something to approve", async () => {
    autoRespond.mockResolvedValue({
      ok: true,
      reply: "I can file that with your manager as a maintenance request.",
      pendingAction: {
        toolName: "report_maintenance_issue",
        input: { summary: "Kitchen sink is leaking" },
        preview: PREVIEW,
      },
    });
    const { db, captured } = fakeDb();

    const result = await runResidentInboxAgentTurn(db, target, RESIDENT, "resident@example.com", "sink is leaking");

    expect(result).toEqual({ replied: true });
    expect(captured.pendingInserts).toHaveLength(1);
    const row = captured.pendingInserts[0]!;
    // Claimed on user_id, and portal-bound to the route that will confirm it.
    expect(row.user_id).toBe(RESIDENT);
    expect(row.portal).toBe("resident");
    expect(row.tool_name).toBe("report_maintenance_issue");
    expect(row.preview).toEqual(PREVIEW);
    // The write itself has NOT happened — only the proposal was stored.
    expect(captured.pendingInserts.every((r) => r.tool_name === "report_maintenance_issue")).toBe(true);

    expect(residentVisibleReply(captured)).toContain('Approve "Report a maintenance issue" in your portal');
  });

  it("tells the resident when the proposal could not be stored", async () => {
    autoRespond.mockResolvedValue({
      ok: true,
      reply: "I can file that with your manager as a maintenance request.",
      pendingAction: {
        toolName: "report_maintenance_issue",
        input: { summary: "Kitchen sink is leaking" },
        preview: PREVIEW,
      },
    });
    const { db, captured } = fakeDb({ insertFails: true });

    await runResidentInboxAgentTurn(db, target, RESIDENT, "resident@example.com", "sink is leaking");

    const body = residentVisibleReply(captured);
    expect(body).toContain("could not prepare");
    // Never promise a card the resident cannot act on.
    expect(body).not.toContain("Approve ");
  });

  it("leaves a read-only answer alone — no row, no confirmation copy", async () => {
    autoRespond.mockResolvedValue({ ok: true, reply: "Rent is due on the 1st.", pendingAction: undefined });
    const { db, captured } = fakeDb();

    await runResidentInboxAgentTurn(db, target, RESIDENT, "resident@example.com", "when is rent due?");

    expect(captured.pendingInserts).toHaveLength(0);
    expect(residentVisibleReply(captured)).toBe("Rent is due on the 1st.");
  });
});
