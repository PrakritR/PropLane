import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";
import type { HouseholdCharge } from "@/lib/household-charges";
import { executeSendRentReminder, sendRentReminderTool } from "@/lib/tools/domains/payments";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";

const confirmationMocks = vi.hoisted(() => ({
  resolveOpen: vi.fn(),
  denyOpen: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/sms/agent-confirmation.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/agent-confirmation.server")>()),
  resolveOpenSmsProposal: confirmationMocks.resolveOpen,
  denyOpenSmsProposal: confirmationMocks.denyOpen,
}));
vi.mock("@/lib/agent/pending-action-decision", () => ({
  decidePendingAction: confirmationMocks.decide,
}));

import { findOrCreateSmsAgentTestSession, runSmsAgentTurn, type SmsAgentSurface } from "@/lib/agent/sms-agent-turn.server";
import { createMemoryDb } from "./support/memory-supabase";

const MANAGER = "manager-a";
const ACTOR = "actor-a";
const TEST_KIND = `resident_sms_test:${MANAGER}:listing-a`;

function charge(id: string, email: string): HouseholdCharge {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    residentEmail: email,
    residentName: id === "charge-1" ? "Pat Resident" : "Taylor Resident",
    residentUserId: null,
    propertyId: "property-a",
    propertyLabel: "12 Main St",
    managerUserId: MANAGER,
    kind: "rent",
    title: "Monthly rent",
    amountLabel: "$1,500.00",
    balanceLabel: "$1,500.00",
    status: "pending",
    dueDateLabel: "Jan 1, 2020",
  };
}

type Row = Record<string, unknown>;

function reminderDb(charges: HouseholdCharge[]) {
  const audit: Row[] = [];
  const inbox: Row[] = [];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let update: Row | null = null;
      const matches = () => {
        const rows = table === "portal_household_charge_records" ? charges.map((row) => ({ manager_user_id: MANAGER, row_data: row }))
          : table === "audit_log" ? audit : inbox;
        return rows.filter((row) => filters.every(([key, value]) => String(row[key] ?? "") === String(value)));
      };
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        order: () => builder,
        range: async (from: number, to: number) => ({ data: matches().slice(from, to + 1), error: null }),
        limit: async () => ({ data: matches(), error: null }),
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        insert: async (row: Row) => { (table === "audit_log" ? audit : inbox).push({ ...row }); return { error: null }; },
        update: (patch: Row) => {
          update = patch;
          return { eq: async (key: string, value: unknown) => {
            for (const row of matches()) if (String(row[key] ?? "") === String(value)) Object.assign(row, update);
            return { error: null };
          } };
        },
        upsert: async (row: Row) => { inbox.push({ ...row }); return { error: null }; },
        then: <T>(resolve: (value: { data: Row[]; error: null }) => T) => Promise.resolve(resolve({ data: matches(), error: null })),
      };
      return builder;
    },
  };
  return { db, audit, inbox };
}

const managerCtx = (db: unknown) => ({
  landlordId: MANAGER,
  userId: MANAGER,
  email: "manager@example.com",
  roles: ["manager"],
  isAdmin: false,
  db,
}) as unknown as AgentContext;

describe("authenticated SMS test provider boundaries", () => {
  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    process.env.RESEND_API_KEY = "re_test_key";
    confirmationMocks.resolveOpen.mockResolvedValue({
      status: "one",
      actionId: "action-1",
      toolName: "update_automation_settings",
    });
    confirmationMocks.denyOpen.mockResolvedValue({ denied: true, toolName: "update_automation_settings" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  it("captures a single non-demo rent reminder before Resend", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = reminderDb([charge("charge-1", "pat@example.com")]);
    const result = await runWithSmsTestTransport(
      { actorUserId: ACTOR, managerUserId: MANAGER, sessionId: "session-1" },
      () => executeSendRentReminder(managerCtx(db), "charge-1"),
    );

    expect(result.result).toMatchObject({
      ok: true,
      delivery: { email: "sent", portal: "skipped", sms: "skipped" },
    });
    expect(result.effects).toEqual([expect.objectContaining({ kind: "email", status: "captured" })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("captures every recipient in a batch without invoking the provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { db } = reminderDb([
      charge("charge-1", "pat@example.com"),
      charge("charge-2", "taylor@example.com"),
    ]);
    const result = await runWithSmsTestTransport(
      { actorUserId: ACTOR, managerUserId: MANAGER, sessionId: "session-2" },
      () => sendRentReminderTool.handler(managerCtx(db), { chargeIds: ["charge-1", "charge-2"] }),
    );

    expect(result.result.reply).toContain("email sent for 2");
    expect(result.effects).toHaveLength(2);
    expect(result.effects.every((effect) => effect.kind === "email" && effect.status === "captured")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses automation changes before mutation, so an outside-ALS worker has no changed settings to apply", async () => {
    const db = createMemoryDb({
      agent_sessions: [{
        id: "session-3",
        landlord_id: MANAGER,
        user_id: ACTOR,
        kind: TEST_KIND,
        vendor_phone_e164: null,
        status: "active",
        test_actor_user_id: ACTOR,
        sms_test_manager_user_id: MANAGER,
        sms_test_mode: "resident",
        sms_test_target_listing_id: "listing-a",
      }],
      agent_messages: [],
      agent_pending_actions: [],
    });
    const baseFrom = db.from.bind(db);
    db.from = ((table: string) => {
      const query = baseFrom(table) as typeof baseFrom extends (table: string) => infer T ? T : never;
      if (table === "agent_messages") {
        Object.defineProperty(query, "gte", { value: () => query });
      }
      return query;
    }) as typeof db.from;
    const surface: SmsAgentSurface = {
      sessionKind: "resident_sms",
      portal: "resident",
      basePrompt: "test",
      promptId: "resident-sms-agent",
      traceName: "resident-sms-agent-turn",
      analytics: { messageIn: "test_in", messageOut: "test_out", actionProposed: "test_action" },
    };
    await expect(findOrCreateSmsAgentTestSession(db as never, {
      kind: TEST_KIND,
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      mode: "resident",
      portal: "resident",
      sessionId: "session-3",
      targetListingId: "listing-a",
    })).resolves.toMatchObject({ id: "session-3" });
    const result = await runWithSmsTestTransport(
      { actorUserId: ACTOR, managerUserId: MANAGER, sessionId: "session-3" },
      () => runSmsAgentTurn(db as never, {
        ctx: { userId: ACTOR, landlordId: MANAGER, email: "actor@example.com", db } as never,
        surface,
        registry: new Map() as never,
        sessionLandlordId: MANAGER,
        phoneE164: null,
        inboundText: "YES",
        traceActor: { userId: ACTOR, metadata: {} },
        traceMetadata: {},
        testActor: {
          userId: ACTOR,
          managerUserId: MANAGER,
          mode: "resident",
          sessionKind: TEST_KIND,
          sessionId: "session-3",
          targetListingId: "listing-a",
        },
      }),
    );

    expect(result.result?.reply).toContain("unavailable in SMS test mode");
    expect(result.result?.toolTrace).toEqual([{ tool: "update_automation_settings", ok: false }]);
    expect(confirmationMocks.denyOpen).toHaveBeenCalledWith(db, { userId: ACTOR, actionId: "action-1" });
    expect(confirmationMocks.decide).not.toHaveBeenCalled();
    expect(db.__tables.manager_automation_settings ?? []).toHaveLength(0);
    expect(result.effects).toEqual([expect.objectContaining({ kind: "reminder", status: "refused" })]);
  });
});
