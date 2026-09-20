/**
 * `payment_manager` was fully configurable but nothing ever queued it.
 *
 * Modelled on `booking-reminder-sweep.test.ts`'s mocking harness: mock
 * `materializeReminders`, `manager-recipients.server`, and `settings.server`,
 * then assert what the sweep would have queued.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const materialize = vi.fn(() => Promise.resolve(1));

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/reminders/queue.server", () => ({
  materializeReminders: (...args: unknown[]) => materialize(...(args as [])),
}));
vi.mock("@/lib/reminders/manager-recipients.server", () => ({
  loadManagerReminderRecipients: () =>
    Promise.resolve(new Map([["mgr-1", { email: "manager@example.com", name: "Morgan" }]])),
  loadTeamReminderRecipientsByManager: () => Promise.resolve(new Map()),
  teamRecipientsScopedToSubject: () => [],
  teamReminderRecipients: () => [],
}));

const rule = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  leadMinutes: [3 * 24 * 60, 24 * 60],
  timings: ["after:1440", "after:4320"],
  audience: { manager: true, counterparty: false, team: false },
  teamUserIds: [],
  inbox: true,
  email: true,
  sms: false,
  ...over,
});

let paymentManagerRule = rule();
/** House `mgr-house-override` gets its own `payment_manager` rule, keyed off `propertyId`. */
let paymentManagerOverrideRule: ReturnType<typeof rule> | null = null;
const OVERRIDE_PROPERTY_ID = "mgr-house-override";

const settingsFor = (propertyId: string | null) => ({
  rules: {
    payment_manager: propertyId === OVERRIDE_PROPERTY_ID && paymentManagerOverrideRule ? paymentManagerOverrideRule : paymentManagerRule,
  },
  quietHours: { enabled: false },
});

vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsForManagers: () => Promise.resolve(new Map([["mgr-1", settingsFor(null)]])),
  loadReminderSettingsResolver: () =>
    Promise.resolve({ resolve: (_managerUserId: string, propertyId: string | null) => settingsFor(propertyId) }),
}));

import { sweepPaymentManagerReminders } from "@/lib/reminders/subjects/payments.server";
import { reminderIsCurrent } from "@/lib/reminders/current.server";
import type { ReminderQueueRow } from "@/lib/reminders/queue.server";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function chargeRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    manager_user_id: "mgr-1",
    row_data: {
      status: "pending",
      title: "September rent",
      residentName: "Jamie Resident",
      propertyId: "mgr-house-1",
      propertyLabel: "Ash Flats 6",
      balanceLabel: "$1,200.00",
      // Two days overdue as of NOW.
      dueDateIso: "2026-09-08T12:00:00.000Z",
      ...over,
    },
  };
}

function fakeSweepDb(rows: unknown[]) {
  return {
    from(table: string) {
      if (table !== "portal_household_charge_records") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: rows, error: null }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  materialize.mockClear();
  paymentManagerRule = rule();
  paymentManagerOverrideRule = null;
});

describe("sweepPaymentManagerReminders", () => {
  it("queues a manager reminder for an unpaid overdue charge", async () => {
    const queued = await sweepPaymentManagerReminders(fakeSweepDb([chargeRow("charge-1")]), NOW);

    expect(queued).toBe(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    const [, input] = materialize.mock.calls[0]! as [unknown, Record<string, unknown>];
    expect(input.kind).toBe("payment_manager");
    expect(input.subjectId).toBe("charge-1");
    expect(input.managerUserId).toBe("mgr-1");
    expect(input.anchorIso).toBe("2026-09-08T12:00:00.000Z");
    expect(input.recipients).toEqual([
      { email: "manager@example.com", role: "manager", name: "Morgan", userId: "mgr-1" },
    ]);
  });

  it("queues nothing for a paid, void, or canceled charge", async () => {
    const rows = [
      chargeRow("charge-paid", { status: "paid" }),
      chargeRow("charge-void", { status: "void" }),
      chargeRow("charge-canceled", { status: "Canceled" }),
    ];
    const queued = await sweepPaymentManagerReminders(fakeSweepDb(rows), NOW);
    expect(queued).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("queues nothing when the manager turned payment alerts off", async () => {
    paymentManagerRule = rule({ enabled: false });
    const queued = await sweepPaymentManagerReminders(fakeSweepDb([chargeRow("charge-1")]), NOW);
    expect(queued).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("the anchor it writes is exactly what paymentManagerReminderIsCurrent recomputes from the same row", async () => {
    await sweepPaymentManagerReminders(fakeSweepDb([chargeRow("charge-1")]), NOW);
    const [, input] = materialize.mock.calls[0]! as [unknown, Record<string, unknown>];
    const writtenAnchor = String(input.anchorIso);

    // `reminderIsCurrent` is the real, unmocked function here — it dispatches
    // to `paymentManagerReminderIsCurrent`, which re-derives the anchor from
    // the SAME row_data shape and compares it against the queued row's
    // snapshot. A mismatch here is exactly the failure mode that would make
    // every queued row fail this check and silently never send.
    const currentDb = {
      from(table: string) {
        if (table !== "portal_household_charge_records") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: chargeRow("charge-1"), error: null }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;

    const queueRow: ReminderQueueRow = {
      id: "reminder-1",
      managerUserId: "mgr-1",
      kind: "payment_manager",
      subjectId: "charge-1",
      leadMinutes: -1440,
      recipientEmail: "manager@example.com",
      recipientRole: "manager",
      sendAt: "2026-09-09T12:00:00.000Z",
      attempts: 0,
      payload: { anchorIso: writtenAnchor },
    };
    await expect(reminderIsCurrent(currentDb, queueRow)).resolves.toBe(true);
  });

  it("is idempotent: running the sweep twice queues the same subject with the same anchor, not a second copy", async () => {
    // `materializeReminders` itself is mocked here — real de-duplication is
    // `portal_reminder_records`' unique `dedupe_key` with `ignoreDuplicates`
    // (queue.server.ts). What THIS sweep must guarantee is that a re-run
    // produces byte-identical (kind, subjectId, anchorIso) input each time —
    // the precondition that dedupe key relies on. A sweep that derived a
    // different anchor (e.g. from `now` rather than the stored due date)
    // would queue a second, undeduped row every tick.
    const rows = [chargeRow("charge-1")];
    await sweepPaymentManagerReminders(fakeSweepDb(rows), NOW);
    const firstCall = materialize.mock.calls[0]![1] as Record<string, unknown>;

    materialize.mockClear();
    await sweepPaymentManagerReminders(fakeSweepDb(rows), new Date(NOW.getTime() + 5 * 60_000));
    const secondCall = materialize.mock.calls[0]![1] as Record<string, unknown>;

    expect(secondCall.kind).toBe(firstCall.kind);
    expect(secondCall.subjectId).toBe(firstCall.subjectId);
    expect(secondCall.anchorIso).toBe(firstCall.anchorIso);
  });

  it("PLAN-0916-1040: a house override fires where the workspace rule is off — resolved per charge's own propertyId", async () => {
    paymentManagerRule = rule({ enabled: false });
    paymentManagerOverrideRule = rule({ enabled: true });
    const rows = [
      chargeRow("charge-plain", { propertyId: "mgr-house-1" }),
      chargeRow("charge-overridden", { propertyId: OVERRIDE_PROPERTY_ID }),
    ];
    const queued = await sweepPaymentManagerReminders(fakeSweepDb(rows), NOW);
    expect(queued).toBe(1);
    expect(materialize).toHaveBeenCalledTimes(1);
    const input = materialize.mock.calls[0]![1] as Record<string, unknown>;
    expect(input.subjectId).toBe("charge-overridden");
  });
});
