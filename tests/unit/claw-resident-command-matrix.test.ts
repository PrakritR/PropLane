/**
 * Exhaustive resident SMS command matrix — every keyword the help menu
 * advertises, plus the leasing prospect intents.
 *
 * The manager rows are gone with the regex command layer they tested: a manager
 * texting their work number now reaches the full manager agent, covered by
 * tests/unit/manager-sms-agent.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyResidentSmsIntent } from "@/lib/claw-resident-intents";
import { classifyLeasingIntent } from "@/lib/claw-leasing-links";

/** Resident commands advertised in help / common phrasing. */
const RESIDENT_COMMAND_MATRIX: Array<{
  text: string;
  intent: ReturnType<typeof classifyResidentSmsIntent>["intent"];
  domain?: ReturnType<typeof classifyResidentSmsIntent>["domain"];
  skipBrief?: boolean;
}> = [
  { text: "hi", intent: "greeting", skipBrief: true },
  { text: "hello", intent: "greeting", skipBrief: true },
  { text: "help", intent: "help", skipBrief: true },
  { text: "menu", intent: "help", skipBrief: true },
  { text: "options", intent: "help", skipBrief: true },
  { text: "info", intent: "help", skipBrief: true },
  { text: "rent", intent: "pay", domain: "Payments" },
  { text: "pay", intent: "pay", domain: "Payments" },
  { text: "balance", intent: "balance", domain: "Payments" },
  { text: "how much do I owe", intent: "balance", domain: "Payments" },
  { text: "I want to pay rent", intent: "pay", domain: "Payments" },
  { text: "I paid via zelle", intent: "i_paid", domain: "Payments" },
  { text: "lease", intent: "lease", domain: "Leases" },
  { text: "where do I sign my lease", intent: "lease", domain: "Leases" },
  { text: "apply", intent: "applications", domain: "Applications" },
  { text: "application status", intent: "applications", domain: "Applications" },
  { text: "move-in", intent: "move_in", domain: "Move-in" },
  { text: "movein", intent: "move_in", domain: "Move-in" },
  { text: "when do I get my keys", intent: "move_in", domain: "Move-in" },
  { text: "maintenance", intent: "maintenance", domain: "Services" },
  { text: "work order", intent: "maintenance", domain: "Services" },
  { text: "repair", intent: "maintenance", domain: "Services" },
  { text: "my toilet is broken", intent: "maintenance", domain: "Services" },
  { text: "can I request reserved parking", intent: "service_request", domain: "Services" },
  { text: "message my manager", intent: "inbox", domain: "Inbox" },
  { text: "thanks for yesterday", intent: "unknown", domain: "Inbox" },
];

const LEASING_COMMAND_MATRIX: Array<{
  text: string;
  intent: ReturnType<typeof classifyLeasingIntent>;
}> = [
  { text: "hi", intent: "greeting" },
  { text: "help", intent: "help" },
  { text: "I'd like a tour", intent: "tour" },
  { text: "can I apply", intent: "apply" },
  { text: "ready to sign the lease", intent: "lease" },
  { text: "what's the rent", intent: "unknown" },
];

describe("resident SMS command matrix", () => {
  for (const row of RESIDENT_COMMAND_MATRIX) {
    it(`classifies "${row.text}" as ${row.intent}`, () => {
      const c = classifyResidentSmsIntent(row.text);
      expect(c.intent).toBe(row.intent);
      if (row.domain) expect(c.domain).toBe(row.domain);
      if (row.skipBrief !== undefined) expect(c.skipManagerBrief).toBe(row.skipBrief);
    });
  }
});

describe("leasing prospect command matrix", () => {
  for (const row of LEASING_COMMAND_MATRIX) {
    it(`classifies "${row.text}" as ${row.intent}`, () => {
      expect(classifyLeasingIntent(row.text)).toBe(row.intent);
    });
  }
});

const createWorkOrder = vi.fn();
const createServiceRequest = vi.fn();
const reportManualPayment = vi.fn();

vi.mock("@/lib/claw-maintenance-work-order.server", () => ({
  createWorkOrderFromResidentSms: (...args: unknown[]) => createWorkOrder(...args),
  maintenanceWorkOrderResidentAck: () => null,
}));

vi.mock("@/lib/claw-service-request-sms.server", () => ({
  createServiceRequestFromResidentSms: (...args: unknown[]) => createServiceRequest(...args),
  serviceRequestResidentAck: () => "Service request filed.",
}));

vi.mock("@/lib/resident-report-manual-payment.server", () => ({
  reportManualPaymentForResident: (...args: unknown[]) => reportManualPayment(...args),
}));

vi.mock("@/lib/supabase/service", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    const self = () => c;
    for (const m of ["select", "eq", "in", "order", "limit", "gte"]) c[m] = self;
    c.maybeSingle = async () => ({ data: null });
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [] }).then(res, rej);
    return c;
  };
  return { createSupabaseServiceRoleClient: () => ({ from: () => chain() }) };
});

describe("runResidentSmsAction command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWorkOrder.mockResolvedValue({ created: false, error: "not_maintenance" });
    createServiceRequest.mockResolvedValue({ created: true, requestId: "SR-1", title: "Parking" });
    reportManualPayment.mockResolvedValue({ ok: true, channel: "zelle", charges: [{ id: "c1" }] });
  });

  it("help returns human menu without manager brief noise", async () => {
    const { runResidentSmsAction } = await import("@/lib/claw-resident-actions.server");
    const result = await runResidentSmsAction({
      text: "help",
      residentPhone: "+15105551234",
      managerUserId: "mgr-1",
      residentEmail: "r@example.com",
      residentUserId: "res-1",
    });
    expect(result.classification.intent).toBe("help");
    expect(result.classification.skipManagerBrief).toBe(true);
    expect(result.residentReply.toLowerCase()).toContain("text me");
  });

  it("rent routes to payment balance flow", async () => {
    const { runResidentSmsAction } = await import("@/lib/claw-resident-actions.server");
    const result = await runResidentSmsAction({
      text: "rent",
      residentPhone: "+15105551234",
      managerUserId: "mgr-1",
      residentEmail: "r@example.com",
      residentUserId: "res-1",
    });
    expect(result.classification.intent).toBe("pay");
    expect(result.residentReply).toMatch(/caught up|open:|pay here/i);
    expect(result.threadTopic).toBe("payment");
  });

  it("maintenance keyword prompts for detail when text is too vague to auto-file", async () => {
    const { runResidentSmsAction } = await import("@/lib/claw-resident-actions.server");
    const result = await runResidentSmsAction({
      text: "maintenance",
      residentPhone: "+15105551234",
      managerUserId: "mgr-1",
      residentEmail: "r@example.com",
      residentUserId: "res-1",
    });
    expect(result.classification.intent).toBe("maintenance");
    expect(createWorkOrder).toHaveBeenCalled();
    expect(result.residentReply).toMatch(/detail|work order/i);
  });

  it("i_paid reports offline payment", async () => {
    const { runResidentSmsAction } = await import("@/lib/claw-resident-actions.server");
    const result = await runResidentSmsAction({
      text: "I paid via zelle",
      residentPhone: "+15105551234",
      managerUserId: "mgr-1",
      residentEmail: "r@example.com",
      residentUserId: "res-1",
    });
    expect(reportManualPayment).toHaveBeenCalled();
    expect(result.residentReply.toLowerCase()).toMatch(/noted|zelle/);
  });
});
