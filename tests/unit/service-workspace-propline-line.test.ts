/**
 * Captain, Nov 24: a PropLane-managed workspace (`portal_workspaces.is_service`) that holds its OWN active, registered number
 * (Ambika: +1 814 679 3694) texts on THAT number; a managed workspace without one (Vinod) texts on the PropLane line (206),
 * in both line modes. One decision, `resolveServiceLine(db, columns, workspaceId)`, feeds the dispatcher's readiness check,
 * the number resolvers and the Settings status. An unreadable or unsendable own number fails closed to the PropLane line
 * (never another workspace's number); a PropLane line that cannot be resolved refuses. Self-serve workspaces are untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  requireManagerRouteUser: vi.fn(),
  getEffectiveManagerSmsEntitlement: vi.fn(),
  reconcileManagerSmsEntitlement: vi.fn(),
  getManagerPortalNavSubscriptionTier: vi.fn(),
  provision: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
vi.mock("@/lib/number-subscription/availability.server", () => ({ getNumberAvailability: vi.fn(async () => ({ available: true })) }));
vi.mock("@/lib/auth/route-actor.server", () => ({
  resolveManagerRouteActor: async () => {
    const actor = await mocks.requireManagerRouteUser();
    return actor ? { ok: true, ...actor } : { ok: false, status: 401, error: "Sign in again." };
  },
}));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: mocks.requireManagerRouteUser }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPortalNavSubscriptionTier: mocks.getManagerPortalNavSubscriptionTier }));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  getEffectiveManagerSmsEntitlement: mocks.getEffectiveManagerSmsEntitlement,
  reconcileManagerSmsEntitlement: mocks.reconcileManagerSmsEntitlement,
}));
vi.mock("@/lib/sms/work-numbers.server", () => ({
  provisionNumberForWorkspace: mocks.provision,
  listWorkspaceNumbers: vi.fn(async () => []),
  assignNumberToWorkspace: vi.fn(),
  unassignNumber: vi.fn(),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
}));

import { GET, PATCH, POST } from "@/app/api/manager/messaging-number/route";
import { managedWorkspaceOwningLine, resolveAdminLine, resolveServiceLine } from "@/lib/one-number/service-line.server";
import { resolveActiveManagerSendNumber, resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { resolveOwnedWorkNumber } from "@/lib/sms/resolve-owned-work-number.server";
import { evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";

const SVC_OWNER = "00000000-0000-4000-8000-0000000000a0";
const AMBIKA = "00000000-0000-4000-8000-0000000000a1";
const SELF = "00000000-0000-4000-8000-0000000000a2";
const LINE_206 = "+12066781909";
const SHARED = "+12066781909";
const AMBIKA_OLD = "+18146793694";
const AMBIKA_OWN = AMBIKA_OLD;
const VINOD = "00000000-0000-4000-8000-0000000000a3";
const SELF_OWN = "+15025550142";

const numberRow = (over: Record<string, unknown>) => ({
  phone_number_sid: "PN1", messaging_service_sid: "MGdefault", campaign_sid: "CP1", provision_state: "active", registration_state: "approved",
  registration_ref: null, attachment_state: "attached", number_registration_state: "registered", released_at: null,
  grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null, ...over,
});

function world(mode: "shared" | "per_workspace" | "shadow", over: { noServiceOwner?: boolean; releasedLine?: boolean; noAmbikaNumber?: boolean; ambikaUnregistered?: boolean } = {}) {
  return createMemoryDb({
    sms_runtime_config: [{
      singleton: true, mode: "automatic", pilot_manager_user_ids: [],
      line_mode: mode, shared_number_e164: SHARED, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [],
    }],
    platform_service_settings: over.noServiceOwner ? [] : [{ singleton: true, owner_user_id: SVC_OWNER }],
    portal_workspaces: [
      { id: "ws-svc-home", name: "PropLane", owner_user_id: SVC_OWNER, is_default: true, is_service: false },
      { id: "ws-ambika", name: "Ambika Homes", owner_user_id: AMBIKA, is_default: true, is_service: true },
      { id: "ws-self", name: "Self Serve", owner_user_id: SELF, is_default: true, is_service: false },
      { id: "ws-vinod", name: "Vinod Homes", owner_user_id: VINOD, is_default: true, is_service: true },
    ],
    manager_sms_numbers: [
      numberRow({ id: "n-206", manager_user_id: SVC_OWNER, workspace_id: "ws-svc-home", phone_number: LINE_206, released_at: over.releasedLine ? "2026-10-01" : null }),
      ...(over.noAmbikaNumber ? [] : [numberRow({ id: "n-ambika", manager_user_id: AMBIKA, workspace_id: "ws-ambika", phone_number: AMBIKA_OLD, ...(over.ambikaUnregistered ? { registration_state: "pending" } : {}) })]),
      numberRow({ id: "n-self", manager_user_id: SELF, workspace_id: "ws-self", phone_number: SELF_OWN }),
    ],
    workspace_work_numbers: [
      { workspace_id: "ws-ambika", number_id: "n-ambika", is_primary: true },
      { workspace_id: "ws-self", number_id: "n-self", is_primary: true },
    ],
    manager_property_records: [
      { id: "h-ambika", manager_user_id: AMBIKA, workspace_id: "ws-ambika" },
      { id: "h-self", manager_user_id: SELF, workspace_id: "ws-self" },
    ],
    profiles: [{ id: AMBIKA, email: "a@example.com", phone: "+15105550123", phone_verified_at: "2026-08-25T12:00:00.000Z", sms_forward_inbound: true }],
    sms_manager_entitlements: [],
    account_link_invites: [],
  });
}

type Db = ReturnType<typeof world>;
const readiness = (db: Db, ownerUserId: string, over: Record<string, unknown>) =>
  evaluateWorkspaceSendReadiness({ db: db as never, ownerUserId, requiredCents: 3, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGdefault";
  process.env.TWILIO_CAMPAIGN_SID = "CP1";
  process.env.SMS_PROVISIONING_ENABLED = "1";
  mocks.rateLimit.mockResolvedValue({ ok: true });
  mocks.getManagerPortalNavSubscriptionTier.mockResolvedValue("pro");
  mocks.getEffectiveManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
  mocks.reconcileManagerSmsEntitlement.mockResolvedValue({ eligible: true, tier: "pro", source: "stripe" });
  mocks.provision.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
});
afterEach(() => {
  delete process.env.SMS_PROVISIONING_ENABLED;
});

describe("outbound: a managed workspace with its own registered number sends from it; one without sends from the 206", () => {
  it("per_workspace: Ambika sends from the 814, billed to the managed workspace", async () => {
    const result = await readiness(world("per_workspace"), AMBIKA, { workspaceId: "ws-ambika" });
    expect(result).toMatchObject({ canSend: true, workspaceId: "ws-ambika" });
    expect(result.canSend && result.numberRow.phone_number).toBe(AMBIKA_OWN);
    expect(result.canSend && result.viaSharedLine).toBeFalsy();
  });

  it("per_workspace: however the workspace is named - a house, a stamped outbox workspace, a pinned line, or the owner's default", async () => {
    const db = world("per_workspace");
    for (const hint of [{ propertyId: "h-ambika" }, { sharedLineWorkspaceId: "ws-ambika" }, { workLineId: "n-ambika" }, {}]) {
      const result = await readiness(db, AMBIKA, hint);
      expect(result.canSend && result.numberRow.phone_number, JSON.stringify(hint)).toBe(AMBIKA_OWN);
    }
  });

  it("shadow mode behaves like per_workspace", async () => {
    const result = await readiness(world("shadow"), AMBIKA, { workspaceId: "ws-ambika" });
    expect(result.canSend && result.numberRow.phone_number).toBe(AMBIKA_OWN);
  });

  it("shared mode: Ambika still sends from its own 814, not through the shared sender", async () => {
    const result = await readiness(world("shared"), AMBIKA, { workspaceId: "ws-ambika" });
    expect(result.canSend && result.numberRow.phone_number).toBe(AMBIKA_OWN);
    expect(result.canSend && result.viaSharedLine).toBeFalsy();
  });

  it("Vinod (managed, no number of its own) sends from the 206 in per_workspace and the shared sender in shared mode", async () => {
    const perWorkspace = await readiness(world("per_workspace"), VINOD, { workspaceId: "ws-vinod" });
    expect(perWorkspace.canSend && perWorkspace.numberRow.phone_number).toBe(LINE_206);
    const shared = await readiness(world("shared"), VINOD, { workspaceId: "ws-vinod" });
    expect(shared).toMatchObject({ canSend: true, viaSharedLine: true, workspaceId: "ws-vinod", providerMessagingServiceSid: "MGshared" });
    expect(shared.canSend && shared.numberRow.phone_number).toBe(SHARED);
  });

  it("an own number that is not registered is not the line: the workspace falls back to the 206", async () => {
    const result = await readiness(world("per_workspace", { ambikaUnregistered: true }), AMBIKA, { workspaceId: "ws-ambika" });
    expect(result.canSend && result.numberRow.phone_number).toBe(LINE_206);
  });

  it("the number resolvers agree: Ambika is the 814, Vinod the 206", async () => {
    for (const mode of ["per_workspace", "shared"] as const) {
      const db = world(mode);
      expect(await resolveActiveManagerSendNumber(db as never, AMBIKA, "ws-ambika")).toBe(AMBIKA_OWN);
      expect((await resolveWorkspaceSendLine(db as never, AMBIKA, "ws-ambika"))?.phoneNumber).toBe(AMBIKA_OWN);
      expect(await resolveActiveManagerSendNumber(db as never, AMBIKA, "ws-ambika", { ownLineOnly: true })).toBe(AMBIKA_OWN);
      expect(await resolveActiveManagerSendNumber(db as never, VINOD, "ws-vinod")).toBe(mode === "shared" ? SHARED : LINE_206);
    }
    expect(await resolveWorkspaceSendLine(world("per_workspace") as never, AMBIKA, "ws-ambika")).toEqual({ phoneNumber: AMBIKA_OWN, numberId: "n-ambika" });
  });

  it("resolveServiceLine names the source of the line", async () => {
    const db = world("per_workspace");
    expect(await resolveServiceLine(db as never, "phone_number", "ws-ambika")).toMatchObject({ ok: true, kind: "owner_number", source: "workspace", phoneNumber: AMBIKA_OWN, serviceOwnerUserId: AMBIKA });
    expect(await resolveServiceLine(db as never, "phone_number", "ws-vinod")).toMatchObject({ ok: true, kind: "owner_number", source: "service_owner", phoneNumber: LINE_206 });
  });
});

describe("fail closed: an unresolvable line refuses the send; an unreadable own number falls to the PropLane line", () => {
  it("no service owner configured: a managed workspace without its own number refuses", async () => {
    const result = await readiness(world("per_workspace", { noServiceOwner: true }), VINOD, { workspaceId: "ws-vinod" });
    expect(result).toEqual({ canSend: false, reason: WORKSPACE_NO_WORK_NUMBER_CODE });
  });

  it("the service owner's line is released: Vinod refuses, Ambika still sends from its own 814", async () => {
    const db = world("per_workspace", { releasedLine: true });
    expect(await readiness(db, VINOD, { workspaceId: "ws-vinod" })).toEqual({ canSend: false, reason: WORKSPACE_NO_WORK_NUMBER_CODE });
    const ambika = await readiness(db, AMBIKA, { workspaceId: "ws-ambika" });
    expect(ambika.canSend && ambika.numberRow.phone_number).toBe(AMBIKA_OWN);
  });

  it("the line cannot be read at all", async () => {
    const db = world("per_workspace");
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          if (table !== "platform_service_settings") return (target as unknown as { from: (t: string) => unknown }).from(table);
          const failed = { select: () => failed, eq: () => failed, maybeSingle: async () => ({ data: null, error: { message: "boom" } }) };
          return failed;
        };
      },
    });
    const result = await readiness(failing as never, VINOD, { workspaceId: "ws-vinod" });
    expect(result).toEqual({ canSend: false, reason: "control_plane_unreadable" });
  });

  it("an unreadable own-number read resolves the PropLane line, never another workspace's number", async () => {
    const db = world("per_workspace");
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "from") return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const real = (target as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }).from(table);
          if (table !== "manager_sms_numbers") return real;
          return new Proxy(real, {
            get(t, p) {
              if (p !== "select") return t[p as string];
              return (columns: string) => {
                const q = t.select!(columns) as Record<string, unknown>;
                return new Proxy(q, {
                  get(qt, qp) {
                    if (qp === "eq") {
                      return (col: string, val: unknown) =>
                        col === "workspace_id" ? { then: (ok: (v: unknown) => void) => ok({ data: null, error: { message: "boom" } }) } : (qt.eq as (...a: unknown[]) => unknown)(col, val);
                    }
                    return qt[qp as string];
                  },
                });
              };
            },
          });
        };
      },
    });
    const line = await resolveServiceLine(failing as never, "phone_number", "ws-ambika");
    expect(line).toMatchObject({ ok: true, phoneNumber: LINE_206, source: "service_owner" });
  });

  it("with the PropLane line released and no own number, the resolvers return nothing", async () => {
    const db = world("per_workspace", { releasedLine: true, noAmbikaNumber: true });
    expect(await resolveActiveManagerSendNumber(db as never, AMBIKA, "ws-ambika")).toBeNull();
    expect(await resolveWorkspaceSendLine(db as never, AMBIKA, "ws-ambika")).toBeNull();
    expect(await resolveServiceLine(db as never)).toEqual({ ok: false, reason: "no_service_line" });
  });
});

describe("the admin line: the portal always operates the managed operator's registered number", () => {
  it("is the 814 while the 206 history stays listed elsewhere; unreadable or absent falls to the PropLane line", async () => {
    expect(await resolveAdminLine(world("shared") as never)).toMatchObject({ ok: true, phoneNumber: AMBIKA_OWN });
    expect(await resolveAdminLine(world("per_workspace") as never)).toMatchObject({ ok: true, phoneNumber: AMBIKA_OWN });
    expect(await resolveAdminLine(world("shared", { noAmbikaNumber: true }) as never)).toMatchObject({ ok: true, kind: "shared", phoneNumber: SHARED });
    expect(await resolveAdminLine(world("shared", { ambikaUnregistered: true }) as never)).toMatchObject({ ok: true, kind: "shared", phoneNumber: SHARED });
  });

  it("recognises a managed workspace's own line for inbound, and nothing else", async () => {
    const db = world("per_workspace");
    expect(await managedWorkspaceOwningLine(db as never, AMBIKA_OWN)).toBe("ws-ambika");
    expect(await managedWorkspaceOwningLine(db as never, SELF_OWN)).toBeNull();
    expect(await managedWorkspaceOwningLine(db as never, LINE_206)).toBeNull();
  });
});

describe("self-serve workspaces are unchanged", () => {
  it("per_workspace: its own number", async () => {
    const result = await readiness(world("per_workspace"), SELF, { workspaceId: "ws-self" });
    expect(result.canSend && result.numberRow.phone_number).toBe(SELF_OWN);
    expect(await resolveActiveManagerSendNumber(world("per_workspace") as never, SELF, "ws-self")).toBe(SELF_OWN);
  });

  it("shared: a dedicated self-serve workspace still sends from its own number", async () => {
    const result = await readiness(world("shared"), SELF, { workspaceId: "ws-self" });
    expect(result.canSend && result.numberRow.phone_number).toBe(SELF_OWN);
    expect(result.canSend && result.viaSharedLine).toBeFalsy();
  });
});

describe("inbound: a text arriving on the managed workspace's own 814 routes to that workspace's agents", () => {
  it("resolves the 814 to its workspace, and the reply leaves from the 814", async () => {
    const db = world("per_workspace");
    expect(await resolveOwnedWorkNumber(db as never, AMBIKA_OLD)).toMatchObject({ managerId: AMBIKA, workspaceId: "ws-ambika" });
    const reply = await readiness(db, AMBIKA, { workLineId: "n-ambika" });
    expect(reply.canSend && reply.numberRow.phone_number).toBe(AMBIKA_OWN);
  });
});

describe("Settings > Communication > Work identity", () => {
  const ambikaStatus = async (mode: "shared" | "per_workspace") => {
    mocks.requireManagerRouteUser.mockResolvedValue({ db: world(mode), userId: AMBIKA });
    return (await GET(new Request("http://localhost"))).json();
  };

  it("shows the workspace's own 814 as its line in both modes and offers no request", async () => {
    for (const mode of ["per_workspace", "shared"] as const) {
      const body = await ambikaStatus(mode);
      expect(body.sharedLine, mode).toEqual({ number: AMBIKA_OWN, onSharedLine: false });
      expect(body.number, mode).toMatchObject({ phoneNumber: AMBIKA_OWN });
      expect(body.canRequest, mode).toBe(false);
      expect(body.lineReady, mode).toBe(false); // the runtime env switches are off in a unit run: the same state a send would report
      const own = body.workspaces.find((w: { workspaceId: string }) => w.workspaceId === "ws-ambika");
      expect(own).toMatchObject({ phoneNumber: AMBIKA_OWN });
    }
  });

  it("Ready when the send path is ready", async () => {
    process.env.SMS_RUNTIME_ENABLED = "1";
    process.env.SMS_OUTBOX_SCHEDULER_READY = "1";
    try {
      const body = await ambikaStatus("per_workspace");
      expect(body).toMatchObject({ lineReady: true, canSend: true, sharedLine: { number: AMBIKA_OWN, onSharedLine: false } });
    } finally {
      delete process.env.SMS_RUNTIME_ENABLED;
      delete process.env.SMS_OUTBOX_SCHEDULER_READY;
    }
  });

  it("refuses to request a number, share one in, or remove one for a managed workspace", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue({ db: world("per_workspace"), userId: AMBIKA });
    const post = await POST(new Request("https://prop-lane.test/api/manager/messaging-number", { method: "POST", body: JSON.stringify({ action: "request_number" }) }));
    expect(post.status).toBe(403);
    expect((await post.json()).error).toBe("This workspace texts from the PropLane line.");
    expect(mocks.provision).not.toHaveBeenCalled();
    const patch = await PATCH(new Request("https://prop-lane.test/api/manager/messaging-number", {
      method: "PATCH", body: JSON.stringify({ numberId: "n-ambika", workspaceId: "ws-ambika", action: "unassign" }),
    }));
    expect(patch.status).toBe(403);
  });

  it("a self-serve workspace's Settings are unchanged: its own number, no PropLane line row in per_workspace", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue({ db: world("per_workspace"), userId: SELF });
    const body = await (await GET(new Request("http://localhost"))).json();
    expect(body.sharedLine).toBeNull();
    expect(body.number).toMatchObject({ phoneNumber: SELF_OWN });
  });
});
