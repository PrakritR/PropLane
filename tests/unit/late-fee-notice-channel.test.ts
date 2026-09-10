/**
 * The late-fee notice is sent from its own branch of the cron job, not the
 * reminder loop (`message.kind !== "late_fee"` excludes it). It therefore never
 * read the per-slot channel override the inbox card writes: a manager could
 * switch the late-fee notice to SMS, see the card say SMS, and still have the
 * notice go out on the automation's default channels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliverPaymentReminder = vi.fn();
const loadManagerAutomationSettings = vi.fn();
const loadScheduledMessageOverrides = vi.fn();

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));
vi.mock("@/lib/payment-automation-server", () => ({
  loadListingByPropertyId: async () => new Map(),
}));
vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return {
    ...actual,
    loadManagerAutomationSettings: (...a: unknown[]) => loadManagerAutomationSettings(...a),
    loadScheduledMessageOverrides: (...a: unknown[]) => loadScheduledMessageOverrides(...a),
  };
});
vi.mock("@/lib/payment-reminder-delivery", () => ({
  deliverPaymentReminder: (...a: unknown[]) => deliverPaymentReminder(...a),
  reminderHtmlFromText: (text: string) => text,
}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  syncLedgerChargeEntry: async () => undefined,
}));

const { DEFAULT_MANAGER_AUTOMATION_SETTINGS, scheduledOverrideId } = await import(
  "@/lib/payment-automation-settings"
);
const { GET } = await import("@/app/api/cron/send-payment-reminders/route");

const MANAGER = "mgr-1";
const CHARGE_ID = "hc_rent_overdue";

/** 40 days ago — well past the 5-day default grace period. */
function longOverdueCharge() {
  const due = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  return {
    id: CHARGE_ID,
    createdAt: due.toISOString(),
    residentEmail: "resident@example.com",
    residentName: "Rey Resident",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    managerUserId: MANAGER,
    kind: "rent",
    title: "June rent",
    amountLabel: "$1000.00",
    balanceLabel: "$1000.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    dueDateLabel: due.toISOString().slice(0, 10),
  };
}

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, string> = {};
      const resultFor = () => {
        if (table === "portal_household_charge_records") {
          if (filters.kind === "late_fee") return { data: [], error: null };
          return {
            data: [{ id: CHARGE_ID, row_data: longOverdueCharge(), manager_user_id: MANAGER }],
            error: null,
          };
        }
        return { data: [], error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        or: () => builder,
        limit: async () => resultFor(),
        maybeSingle: async () => ({
          data: table === "profiles" ? { full_name: "Dana Doe", email: "dana@example.com", sms_from_number: "+15550100" } : null,
        }),
        upsert: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resultFor()).then(resolve),
      };
      return builder;
    },
  };
}

function run() {
  return GET(
    new Request("http://localhost/api/cron/send-payment-reminders", {
      headers: { authorization: "Bearer test-cron-secret" },
    }),
  );
}

/** Every reminder slot off, so the late-fee notice is the only send in the run. */
const NOTICE_ONLY_SETTINGS = {
  ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  preDueReminderDays: [],
  sameDayReminderEnabled: false,
  postDueReminderDays: [],
  overdueDailyEnabled: false,
  lateFeeNoticeEnabled: true,
  paymentReminderDeliverViaEmail: true,
  paymentReminderDeliverViaSms: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.NODE_ENV = "test";
  loadManagerAutomationSettings.mockResolvedValue(NOTICE_ONLY_SETTINGS);
  loadScheduledMessageOverrides.mockResolvedValue(new Map());
  deliverPaymentReminder.mockResolvedValue({ sent: true });
});

describe("late-fee notice delivery channels", () => {
  it("uses the automation defaults when the notice has no override", async () => {
    const res = await run();

    expect(res.status).toBe(200);
    expect(deliverPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        slotLabel: "late_fee_created",
        managerDeliverViaEmail: true,
        managerDeliverViaSms: false,
      }),
    );
  });

  it("honours the channel the manager set on the late-fee notice itself", async () => {
    loadScheduledMessageOverrides.mockResolvedValue(
      new Map([
        [
          scheduledOverrideId({
            managerUserId: MANAGER,
            chargeId: CHARGE_ID,
            kind: "late_fee",
            daysBeforeDue: null,
          }),
          { customDeliverViaEmail: false, customDeliverViaSms: true },
        ],
      ]),
    );

    await run();

    expect(deliverPaymentReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        slotLabel: "late_fee_created",
        managerDeliverViaEmail: false,
        managerDeliverViaSms: true,
      }),
    );
  });
});
