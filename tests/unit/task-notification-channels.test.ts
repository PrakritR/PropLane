import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task reminders reach the assignee on every channel they accept, from the MANAGER's own
 * work identity.
 *
 * The reminder used to POST Resend directly. That made it email-only — it appeared nowhere in
 * the portal, so a person who deleted the mail had no second copy — and it left on the shared
 * `RESEND_FROM` regardless of which manager the task belonged to, so a reply went to a
 * synthetic address rather than to that manager.
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  delivered: [] as Row[],
  profile: null as Row | null,
  assistantAddress: null as string | null,
  assistantName: "",
  sentEmails: [] as Row[],
}));

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: async (_db: unknown, opts: Row) => {
    state.delivered.push(opts);
    return { ok: true, recipientCount: 1 };
  },
}));

vi.mock("@/lib/manager-tasks.server", () => ({
  loadManagerTasks: async () => [],
  saveManagerTasks: async () => {},
}));

function db() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: table === "profiles" ? state.profile : null,
            error: null,
          }),
        }),
      }),
    }),
  };
}

const TASK = {
  id: "task-1",
  title: "Cleaning along with room 3 and 7",
  notes: "Start after the cleaner finishes",
  dueDate: "2026-09-01T23:59:00Z",
  propertyTitle: "5257 Brooklyn Avenue Northeast",
  status: "in-progress",
} as never;

async function notify(assignee: Row, kind: "created" | "due" | "advance" = "due") {
  const { sendTaskAssigneeEmail } = await import("@/lib/manager-default-tasks.server");
  return sendTaskAssigneeEmail({
    db: db() as never,
    managerUserId: "mgr-1",
    task: TASK,
    assignee: assignee as never,
    kind,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.delivered = [];
  state.profile = { email: "manager@example.com", full_name: "Prakrit Ramachandran" };
});

describe("task reminder delivery", () => {
  it("writes the portal inbox copy and lets preferences decide email and SMS", async () => {
    await notify({ type: "team", id: "user-9", name: "Sam Teammate" });

    expect(state.delivered).toHaveLength(1);
    // A category-driven send always writes the inbox and gates email/SMS per recipient, so
    // "all channels" never overrides someone who turned one off.
    expect(state.delivered[0]?.eventCategory).toBe("maintenance");
  });

  it("sends as the manager, not as a generic PropLane sender", async () => {
    await notify({ type: "team", id: "user-9", name: "Sam Teammate" });

    expect(state.delivered[0]?.senderUserId).toBe("mgr-1");
    expect(state.delivered[0]?.senderEmail).toBe("manager@example.com");
    expect(state.delivered[0]?.fromName).toBe("Prakrit Ramachandran");
  });

  it("gives SMS its own one-line body instead of the full email", async () => {
    await notify({ type: "team", id: "user-9", name: "Sam Teammate" });

    const sms = String(state.delivered[0]?.smsText ?? "");
    expect(sms).toContain("Task due now");
    expect(sms).toContain("5257 Brooklyn Avenue Northeast");
    // The notes belong in the inbox and the email, not in a text.
    expect(sms).not.toContain("Start after the cleaner finishes");
    expect(String(state.delivered[0]?.text)).toContain("Start after the cleaner finishes");
  });

  it("greets a person by name", async () => {
    await notify({ type: "team", id: "user-9", name: "Sam Teammate" });

    expect(String(state.delivered[0]?.text)).toContain("Hi Sam Teammate,");
  });

  it("does not greet someone by their raw email address", async () => {
    // A vendor directory row can carry a blank name; the greeting used to fall through to the
    // address, and "Hi ogambik2@gmail.com," is what a person actually received.
    await notify({ type: "team", id: "user-9", name: "" });

    const text = String(state.delivered[0]?.text);
    expect(text).not.toMatch(/Hi \S+@\S+/);
    expect(text).toContain("Hi there,");
  });

  it("refuses to send when the assignee has no address at all", async () => {
    const { sendTaskAssigneeEmail } = await import("@/lib/manager-default-tasks.server");
    const emptyDb = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };

    const res = await sendTaskAssigneeEmail({
      db: emptyDb as never,
      managerUserId: "mgr-1",
      task: TASK,
      assignee: { type: "team", id: "user-9", name: "Sam" } as never,
      kind: "due",
    });

    expect(res).toEqual({ sent: false, error: "assignee_email_missing" });
    expect(state.delivered).toHaveLength(0);
  });
});
