/**
 * `sweepTaskReminders` resolves the `task` reminder rule PER TASK, from that
 * task's own `propertyId` (PLAN-0916-1040) — one manager's task blob spans
 * every house, so a single workspace-wide rule can no longer decide every
 * task's reminder the way it did before house overrides existed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const materialize = vi.fn(() => Promise.resolve(1));

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/portal-detail-routes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-detail-routes")>();
  return { ...actual, managerTaskListHref: () => "/portal/tasks" };
});
vi.mock("@/lib/manager-default-tasks.server", () => ({ assigneeEmail: async () => "assignee@example.com" }));
vi.mock("@/lib/reminders/queue.server", () => ({
  materializeReminders: (...args: unknown[]) => materialize(...(args as [])),
}));
vi.mock("@/lib/reminders/manager-recipients.server", () => ({
  loadManagerReminderRecipients: () =>
    Promise.resolve(new Map([["mgr-1", { email: "manager@example.com", name: "Morgan" }]])),
  loadTeamReminderRecipients: () => Promise.resolve([]),
  teamReminderRecipients: () => [],
}));

const rule = (enabled: boolean) => ({
  enabled,
  leadMinutes: [60],
  audience: { manager: true, counterparty: false, team: false },
  teamUserIds: [],
  inbox: true,
  email: true,
  sms: false,
});

/** Workspace has task reminders OFF; the overridden house turned them ON. */
const OVERRIDE_PROPERTY_ID = "house-override";
let workspaceEnabled = false;

vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsResolver: () =>
    Promise.resolve({
      resolve: (_managerUserId: string, propertyId: string | null) => ({
        rules: { task: rule(propertyId === OVERRIDE_PROPERTY_ID ? true : workspaceEnabled) },
        quietHours: { enabled: false },
      }),
    }),
}));

import { sweepTaskReminders } from "@/lib/reminders/subjects/tasks.server";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

function scheduleRow(managerUserId: string, tasks: unknown[]) {
  return { manager_user_id: managerUserId, row_data: { tasks } };
}

function fakeDb(rows: unknown[]) {
  return {
    from() {
      return { select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) };
    },
  } as never;
}

beforeEach(() => {
  materialize.mockClear();
  workspaceEnabled = false;
});

describe("sweepTaskReminders — per-house reminder override", () => {
  it("PLAN-0916-1040: a house override fires a task reminder the workspace rule would suppress", async () => {
    const taskOnOverriddenHouse = {
      id: "t-1",
      title: "Turn the unit",
      completed: false,
      assignee: { type: "team", id: "u-1", name: "Ada" },
      dueDate: inHours(5),
      propertyId: OVERRIDE_PROPERTY_ID,
    };
    const taskOnWorkspaceHouse = {
      id: "t-2",
      title: "Order supplies",
      completed: false,
      assignee: { type: "team", id: "u-1", name: "Ada" },
      dueDate: inHours(5),
      propertyId: "house-plain",
    };
    const queued = await sweepTaskReminders(fakeDb([scheduleRow("mgr-1", [taskOnOverriddenHouse, taskOnWorkspaceHouse])]), NOW);
    // Only the overridden house's task queued — the workspace-scoped one did not.
    expect(queued).toBe(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    const input = materialize.mock.calls[0]![1] as { subjectId: string };
    expect(input.subjectId).toBe("t-1");
  });

  it("when the workspace turns task reminders ON, an untouched house still fires (no override needed)", async () => {
    workspaceEnabled = true;
    const task = {
      id: "t-3",
      title: "Renew insurance",
      completed: false,
      assignee: { type: "team", id: "u-1", name: "Ada" },
      dueDate: inHours(5),
      propertyId: "house-plain",
    };
    const queued = await sweepTaskReminders(fakeDb([scheduleRow("mgr-1", [task])]), NOW);
    expect(queued).toBe(1);
  });
});
