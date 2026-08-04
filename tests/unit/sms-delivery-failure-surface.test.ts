/**
 * Honest delivery: an outbound SMS whose carrier status came back
 * failed/undelivered (Twilio status webhook → `sms_delivery_log`) is stamped
 * `deliveryFailed` in the conversation payload, so the thread shows "Not
 * delivered" instead of silently reading as sent. Absence of a status row
 * stamps nothing — no adverse report is NOT delivery proof, and it must never
 * flag a message either way.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: vi.fn(async () => ({ ownerIds: [] as string[] })),
}));
vi.mock("@/lib/twilio-provisioning", () => ({
  resolveManagerWorkNumber: vi.fn(async () => "+12065550999"),
  ensureManagerSmsNumber: vi.fn(async () => ({ ok: false, error: "not in tests" })),
}));

import { fetchManagerSmsConversations } from "@/lib/manager-sms-messages.server";

const MGR = "11111111-1111-1111-1111-111111111111";
const RESIDENT_UID = "22222222-2222-2222-2222-222222222222";
const PHONE = "+12065550100";

type Fixture = Record<string, unknown[]>;

/** Minimal PostgREST-ish stub: ignores filters, returns the table fixture. */
function makeDb(fixtures: Fixture) {
  const builder = (table: string) => {
    const state = { maybeSingle: false };
    const result = () => {
      if (table === "profiles") {
        return state.maybeSingle
          ? { data: (fixtures.profiles_self ?? [])[0] ?? null, error: null }
          : { data: fixtures.profiles_by_email ?? [], error: null };
      }
      return { data: fixtures[table] ?? [], error: null };
    };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "in", "order", "limit", "eq", "is", "range", "delete", "or"]) {
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () => {
      state.maybeSingle = true;
      return result();
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return chain;
  };
  return { from: (table: string) => builder(table) } as never;
}

const base: Fixture = {
  manager_application_records: [
    {
      manager_user_id: MGR,
      resident_email: "jane@example.com",
      row_data: { bucket: "approved", name: "Jane Resident", property: "Unit A", phone: PHONE },
    },
  ],
  profiles_self: [
    { phone: null, phone_verified_at: null, sms_forward_inbound: true, sms_from_number: null },
  ],
  profiles_by_email: [
    { id: RESIDENT_UID, email: "jane@example.com", phone: PHONE, full_name: "Jane Resident" },
  ],
  inbound_sms_log: [
    {
      id: "in-1",
      manager_user_id: MGR,
      from_phone: PHONE,
      to_phone: "+12065550999",
      body: "hi it's Jane",
      message_sid: "SM-IN",
      matched_sender_user_id: RESIDENT_UID,
      counterparty_role: "resident",
      conversation_key: `${MGR}:resident:${RESIDENT_UID}`,
      created_at: "2026-07-20T00:00:00.000Z",
    },
  ],
  manager_sms_messages: [
    {
      id: "out-1",
      manager_user_id: MGR,
      resident_user_id: RESIDENT_UID,
      resident_phone: PHONE,
      direction: "outbound",
      body: "Rent reminder",
      from_phone: "+12065550999",
      to_phone: PHONE,
      message_sid: "SM-FAILED",
      source: "work_number",
      counterparty_role: "resident",
      conversation_key: `${MGR}:resident:${RESIDENT_UID}`,
      created_at: "2026-07-21T00:00:00.000Z",
    },
    {
      id: "out-2",
      manager_user_id: MGR,
      resident_user_id: RESIDENT_UID,
      resident_phone: PHONE,
      direction: "outbound",
      body: "Second message, no adverse report",
      from_phone: "+12065550999",
      to_phone: PHONE,
      message_sid: "SM-OK",
      source: "work_number",
      counterparty_role: "resident",
      conversation_key: `${MGR}:resident:${RESIDENT_UID}`,
      created_at: "2026-07-22T00:00:00.000Z",
    },
  ],
  sms_relay_threads: [],
  // Only adverse rows exist here — the stub ignores filters, and the real
  // query narrows to status in (failed, undelivered).
  sms_delivery_log: [{ message_sid: "SM-FAILED", status: "undelivered", error_code: "30034" }],
};

describe("delivery-failure surfacing in fetchManagerSmsConversations", () => {
  it("stamps deliveryFailed only on outbound messages the carrier rejected", async () => {
    const payload = await fetchManagerSmsConversations(makeDb(base), MGR);
    const jane = payload.residents.find((r) => r.name === "Jane Resident");
    expect(jane).toBeTruthy();

    const failed = jane!.messages.find((m) => m.messageSid === "SM-FAILED");
    expect(failed?.deliveryFailed).toBe(true);
    expect(failed?.deliveryErrorCode).toBe("30034");

    // No adverse report → no stamp (absence is not proof of delivery, and it
    // must not be rendered as failure either).
    const ok = jane!.messages.find((m) => m.messageSid === "SM-OK");
    expect(ok?.deliveryFailed).toBeUndefined();

    const inbound = jane!.messages.find((m) => m.messageSid === "SM-IN");
    expect(inbound?.deliveryFailed).toBeUndefined();
  });
});
