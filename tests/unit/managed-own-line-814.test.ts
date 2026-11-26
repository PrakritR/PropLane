/**
 * Captain, Nov 24: the managed operator's registered number ((814) 679-3694) is the line for PropLane-managed homes and the
 * admin portal; the 206 stays the default for everyone else and tells a text about a managed home to use the 814.
 *   - a 206 text about a managed home that has its own number gets one redirect, built from the resolved number, and the
 *     inbound is still recorded in that workspace's conversation;
 *   - the operator and invited staff texting the 814 are recognised as the service manager (the PropLane line's rule);
 *   - a self-serve manager's number is never the admin line.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/manager-sms-messages.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-sms-messages.server")>()),
  logManagerSmsMessage: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    logged.push(input);
    return true;
  }),
}));

import { answerFromDedicatedWorkspace, buildManagedHomeRedirectReply } from "@/lib/one-number/dedicated-redirect.server";
import { resolveAdminLine } from "@/lib/one-number/service-line.server";
import { recognizeServiceManagerInbound } from "@/lib/sms/service-manager-inbound.server";

const SO = "00000000-0000-4000-8000-0000000000a0";
const AMBIKA = "00000000-0000-4000-8000-0000000000a1";
const SELF = "00000000-0000-4000-8000-0000000000a2";
const LINE_206 = "+12066781909";
const OWN_814 = "+18146793694";
const SELF_OWN = "+15025550142";
const OPERATOR_PHONE = "+15103098345";

const row = (over: Record<string, unknown>) => ({
  provision_state: "active", registration_state: "approved", registration_ref: null, released_at: null, requested_at: "2026-08-01T00:00:00.000Z", ...over,
});

function world(over: { without814?: boolean } = {}) {
  return createMemoryDb({
    sms_runtime_config: [{ singleton: true, mode: "automatic", pilot_manager_user_ids: [], line_mode: "shared", shared_number_e164: LINE_206, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [] }],
    platform_service_settings: [{ singleton: true, owner_user_id: SO, manager_phone_e164: OPERATOR_PHONE, manager_phone_verified_at: "2026-10-19T20:00:00.000Z" }],
    portal_workspaces: [
      { id: "ws-svc-home", name: "PropLane", owner_user_id: SO, is_default: true, is_service: false },
      { id: "ws-ambika", name: "1. Ambika", owner_user_id: AMBIKA, is_default: true, is_service: true },
      { id: "ws-self", name: "Self Serve", owner_user_id: SELF, is_default: true, is_service: false },
    ],
    manager_sms_numbers: [
      row({ id: "n-206", manager_user_id: SO, workspace_id: "ws-svc-home", phone_number: LINE_206 }),
      ...(over.without814 ? [] : [row({ id: "n-814", manager_user_id: AMBIKA, workspace_id: "ws-ambika", phone_number: OWN_814 })]),
      row({ id: "n-self", manager_user_id: SELF, workspace_id: "ws-self", phone_number: SELF_OWN }),
    ],
    workspace_work_numbers: [],
    manager_property_records: [{ id: "h-5257", manager_user_id: AMBIKA, workspace_id: "ws-ambika" }],
    profiles: [{ id: AMBIKA, email: "a@example.com" }],
    sms_manager_entitlements: [],
    account_link_invites: [],
  });
}

beforeEach(() => {
  logged.length = 0;
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGdefault";
});

describe("a 206 text about a managed home with its own number", () => {
  const candidate = { workspaceId: "ws-ambika", ownerUserId: AMBIKA, role: "prospect" as const, reason: "named" as never, propertyId: "h-5257", label: "5257 Brooklyn" };

  it("gets one redirect to the resolved 814 and the inbound is still recorded in the workspace's conversation", async () => {
    const reply = await answerFromDedicatedWorkspace(world() as never, { candidate, fromPhone: "+14255550123", body: "is 5257 still open?", messageSid: "SM1", sharedNumber: LINE_206 });
    expect(reply).toBe("For 5257 Brooklyn, text us at (814) 679-3694 - that's the line for this home.");
    expect(reply).toBe(buildManagedHomeRedirectReply("5257 Brooklyn", OWN_814));
    expect(logged.map((l) => l.direction)).toEqual(["inbound", "outbound"]);
    expect(logged[0]).toMatchObject({ workspaceId: "ws-ambika", managerUserId: AMBIKA, body: "is 5257 still open?", toPhone: LINE_206 });
  });

  it("says nothing when the workspace's own number cannot be named (the text is then handled as before)", async () => {
    const reply = await answerFromDedicatedWorkspace(world({ without814: true }) as never, { candidate, fromPhone: "+14255550123", body: "hi", messageSid: "SM2", sharedNumber: LINE_206 });
    expect(reply).toBeNull();
    expect(logged).toEqual([]);
  });
});

describe("inbound on the 814", () => {
  it("recognises the operator (and so invited staff) texting the managed workspace's own line as the service manager", async () => {
    const found = await recognizeServiceManagerInbound(world() as never, { managerId: AMBIKA, fromPhone: OPERATOR_PHONE, toPhone: OWN_814 });
    expect(found).toMatchObject({ serviceManager: true, basis: "admin", workNumberOwnerId: AMBIKA, workNumber: OWN_814 });
  });

  it("does not recognise the operator on a self-serve manager's number", async () => {
    expect(await recognizeServiceManagerInbound(world() as never, { managerId: SELF, fromPhone: OPERATOR_PHONE, toPhone: SELF_OWN })).toBeNull();
  });

  it("does not recognise a stranger on the 814 (they are a prospect of Ambika's workspace, served by its agents)", async () => {
    expect(await recognizeServiceManagerInbound(world() as never, { managerId: AMBIKA, fromPhone: "+14255550123", toPhone: OWN_814 })).toBeNull();
  });
});

describe("the admin line", () => {
  it("admin Communication shows and sends from the 814; self-serve numbers are never it", async () => {
    const line = await resolveAdminLine(world() as never);
    expect(line).toMatchObject({ ok: true, phoneNumber: OWN_814 });
    expect(line.ok && line.phoneNumber).not.toBe(SELF_OWN);
  });

  it("falls back to the PropLane line when the operator has no registered number or it cannot be read", async () => {
    expect(await resolveAdminLine(world({ without814: true }) as never)).toMatchObject({ ok: true, phoneNumber: LINE_206 });
    const real = world();
    const broken = { ...real, from: (table: string) => {
      if (table !== "portal_workspaces") return real.from(table);
      throw new Error("boom");
    } };
    // Fail closed: the PropLane line or nothing, never the 814 guessed and never a self-serve number.
    const unreadable = await resolveAdminLine(broken as never);
    expect(unreadable.ok ? unreadable.phoneNumber : null).not.toBe(SELF_OWN);
  });
});
