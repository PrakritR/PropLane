/**
 * `processDueTaskReminders` must honor a task's own `propertyId` when loading
 * lifecycle automation (PLAN-0916-1040) — a manager's due-task email sweep
 * spans every house, so a single workspace-wide `lifecycleTasks` blob can no
 * longer decide every task's reminder the way it did before house overrides
 * existed. `lifecycleTasks` stays an ATOMIC namespace (a house override
 * replaces the whole blob, same as the workspace save it mirrors).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadManagerTasks = vi.fn();
const saveManagerTasks = vi.fn().mockResolvedValue(undefined);
const loadLifecycleAutomation = vi.fn();
const loadPropertyOverridesForManagers = vi.fn();
const deliverPortalInboxMessage = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@/lib/manager-tasks.server", () => ({
  loadManagerTasks: (...args: unknown[]) => loadManagerTasks(...args),
  saveManagerTasks: (...args: unknown[]) => saveManagerTasks(...args),
}));
vi.mock("@/lib/task-lifecycle-automation.server", () => ({
  loadLifecycleAutomation: (...args: unknown[]) => loadLifecycleAutomation(...args),
}));
vi.mock("@/lib/settings/property-overrides.server", () => ({
  loadPropertyOverridesForManagers: (...args: unknown[]) => loadPropertyOverridesForManagers(...args),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: (...args: unknown[]) => deliverPortalInboxMessage(...args),
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));

import { processDueTaskReminders } from "@/lib/manager-default-tasks.server";

const MGR = "mgr-1";
const OVERRIDE_PROPERTY_ID = "house-override";
// `processDueTaskReminders` has no injectable clock (it reads Date.now()
// directly), so every task here is due safely in the PAST — that keeps the
// "due" reminder path's gate deterministic (`remindersOn`, keyed only on
// `sendEmailReminder`) regardless of the real wall-clock time the suite runs
// at, rather than a relative offset that could land on either side of "now".
const PAST_DUE = "2020-01-01T00:00:00.000Z";

const workspaceAutomation = {
  review_application: { days: 3, sendEmailReminder: false, reminderMinutesBeforeList: [] },
  review_and_send_lease: { days: 3, sendEmailReminder: false, reminderMinutesBeforeList: [] },
  collect_rent: { days: 3, sendEmailReminder: false, reminderMinutesBeforeList: [] },
};

/** The overridden house turns email reminders ON for `collect_rent`. */
const houseOverrideAutomation = {
  ...workspaceAutomation,
  collect_rent: { days: 3, sendEmailReminder: true, reminderMinutesBeforeList: [60] },
};

function task(id: string, propertyId: string) {
  return {
    id,
    title: `Task ${id}`,
    completed: false,
    templateKey: "collect_rent",
    propertyId,
    dueDate: PAST_DUE,
    assignee: { type: "team", id: "u-1", name: "Ada" },
  };
}

function fakeDb() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "ada@example.com", full_name: "Ada" } }) }) }) };
      }
      throw new Error(`unexpected table "${table}"`);
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveManagerTasks.mockResolvedValue(undefined);
  deliverPortalInboxMessage.mockResolvedValue({ ok: true });
  loadLifecycleAutomation.mockResolvedValue(workspaceAutomation);
  loadPropertyOverridesForManagers.mockResolvedValue(
    new Map([[MGR, new Map([[OVERRIDE_PROPERTY_ID, houseOverrideAutomation]])]]),
  );
});

describe("processDueTaskReminders — per-house lifecycle automation", () => {
  it("PLAN-0916-1040: a task on the overridden house sends the due reminder the workspace default would not", async () => {
    loadManagerTasks.mockResolvedValue([task("t-override", OVERRIDE_PROPERTY_ID)]);
    const sent = await processDueTaskReminders(fakeDb(), MGR);
    expect(sent).toBe(1);
    expect(deliverPortalInboxMessage).toHaveBeenCalledTimes(1);
  });

  it("a task on an untouched house never sends — the workspace default has email reminders off", async () => {
    loadManagerTasks.mockResolvedValue([task("t-plain", "house-plain")]);
    const sent = await processDueTaskReminders(fakeDb(), MGR);
    expect(sent).toBe(0);
    expect(deliverPortalInboxMessage).not.toHaveBeenCalled();
  });

  it("resolves overrides in ONE batched call, not one per task", async () => {
    loadManagerTasks.mockResolvedValue([
      task("t-1", OVERRIDE_PROPERTY_ID),
      task("t-2", "house-plain"),
      task("t-3", OVERRIDE_PROPERTY_ID),
    ]);
    await processDueTaskReminders(fakeDb(), MGR);
    expect(loadPropertyOverridesForManagers).toHaveBeenCalledTimes(1);
    expect(loadPropertyOverridesForManagers).toHaveBeenCalledWith(expect.anything(), [MGR], "lifecycleTasks");
  });
});
