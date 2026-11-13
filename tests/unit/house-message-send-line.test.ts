/**
 * "Message a whole house" is ABOUT one workspace: the text leaves from that workspace's work number, its OWNER's
 * wallet pays, whoever is signed in. These pin the two decisions behind it:
 *   - `resolveHouseSendTarget`: the workspace and the owner are re-derived from the actor's own access to the house
 *     (a body id is a name, never authorization);
 *   - `resolveHouseSmsLine`: the line is the one `resolveWorkspaceSendLine` / `resolveServiceLine` already decide - a
 *     self-serve workspace's own number, the PropLane line for a PropLane-managed (`is_service`) workspace - and a
 *     workspace with no sendable line is a REFUSAL, never another workspace's number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const h = vi.hoisted(() => ({
  workspace: null as null | Record<string, unknown>,
  workspaceError: null as null | Error,
  grant: null as unknown,
}));

vi.mock("@/lib/workspaces/active.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/active.server")>()),
  resolveWorkspaceFromSettingsRequest: async () => {
    if (h.workspaceError) throw h.workspaceError;
    return h.workspace;
  },
}));
vi.mock("@/lib/one-number/communication-grant.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one-number/communication-grant.server")>()),
  resolveCommunicationGrant: async () => h.grant,
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { ManagedReadOnlyError } from "@/lib/workspaces/active.server";
import { resolveHouseSendTarget, resolveHouseSmsLine } from "@/lib/house-message-send.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";

const SVC_OWNER = "00000000-0000-4000-8000-0000000000a0";
const CLIENT = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-0000000000a2";
const TEAMMATE = "00000000-0000-4000-8000-0000000000a3";
const LINE_206 = "+12066781909";
const OWN_A = "+15025550141";
const OWN_B = "+15025550142";
const CLIENT_OLD = "+18146793694";

const numberRow = (over: Record<string, unknown>) => ({
  phone_number_sid: "PN1", messaging_service_sid: "MGdefault", campaign_sid: "CP1", provision_state: "active", registration_state: "approved",
  registration_ref: null, attachment_state: "attached", number_registration_state: "registered", released_at: null,
  grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null, ...over,
});

function world(mode: "shared" | "per_workspace", over: { noServiceOwner?: boolean; noOwnerBNumber?: boolean } = {}) {
  return createMemoryDb({
    sms_runtime_config: [{
      singleton: true, mode: "automatic", pilot_manager_user_ids: [],
      line_mode: mode, shared_number_e164: LINE_206, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [],
    }],
    platform_service_settings: over.noServiceOwner ? [] : [{ singleton: true, owner_user_id: SVC_OWNER }],
    portal_workspaces: [
      { id: "ws-svc-home", name: "PropLane", owner_user_id: SVC_OWNER, is_default: true, is_service: false },
      { id: "ws-client", name: "Client Homes", owner_user_id: CLIENT, is_default: true, is_service: true },
      { id: "ws-a", name: "Workspace A", owner_user_id: OWNER, is_default: true, is_service: false },
      { id: "ws-b", name: "Workspace B", owner_user_id: OWNER, is_default: false, is_service: false },
    ],
    manager_sms_numbers: [
      numberRow({ id: "n-206", manager_user_id: SVC_OWNER, workspace_id: "ws-svc-home", phone_number: LINE_206 }),
      numberRow({ id: "n-client", manager_user_id: CLIENT, workspace_id: "ws-client", phone_number: CLIENT_OLD }),
      numberRow({ id: "n-a", manager_user_id: OWNER, workspace_id: "ws-a", phone_number: OWN_A }),
      ...(over.noOwnerBNumber ? [] : [numberRow({ id: "n-b", manager_user_id: OWNER, workspace_id: "ws-b", phone_number: OWN_B })]),
    ],
    workspace_work_numbers: [],
    manager_property_records: [
      { id: "h-client", manager_user_id: CLIENT, workspace_id: "ws-client", status: "live" },
      { id: "h-a", manager_user_id: OWNER, workspace_id: "ws-a", status: "live" },
      { id: "h-b", manager_user_id: OWNER, workspace_id: "ws-b", status: "live" },
    ],
    profiles: [],
    sms_manager_entitlements: [],
    account_link_invites: [],
  });
}

const target = (propertyId: string, workspaceId: string, ownerUserId: string) => ({ propertyId, workspaceId, ownerUserId });

describe("resolveHouseSmsLine: the line is the HOUSE's workspace's, never the owner's default", () => {
  it("an owner with two workspaces texts a house in workspace B from B's number, not the default workspace A's", async () => {
    const line = await resolveHouseSmsLine(world("per_workspace") as never, target("h-b", "ws-b", OWNER));
    expect(line).toEqual({ ok: true, fromNumber: OWN_B, selectedWorkLineId: "n-b", signOff: null });
    const other = await resolveHouseSmsLine(world("per_workspace") as never, target("h-a", "ws-a", OWNER));
    expect(other).toMatchObject({ ok: true, fromNumber: OWN_A, selectedWorkLineId: "n-a" });
  });

  it("a PropLane-managed (is_service) workspace texts on the PropLane line, not the number it still holds", async () => {
    const line = await resolveHouseSmsLine(world("per_workspace") as never, target("h-client", "ws-client", CLIENT));
    expect(line).toMatchObject({ ok: true, fromNumber: LINE_206 });
    expect(line.ok && line.fromNumber).not.toBe(CLIENT_OLD);
  });

  it("shared line mode: the managed workspace leaves on the PropLane number, never the one it still holds", async () => {
    const line = await resolveHouseSmsLine(world("shared") as never, target("h-client", "ws-client", CLIENT));
    expect(line.ok).toBe(true);
    // A managed workspace never counts as dedicated, so it is on the shared line (no row of its own to pin).
    expect(line.ok && line.fromNumber).not.toBe(CLIENT_OLD);
    expect(line.ok && line.selectedWorkLineId).toBeNull();
  });

  it("shared line mode: a self-serve workspace with a paid number of its own still sends from it", async () => {
    const line = await resolveHouseSmsLine(world("shared") as never, target("h-b", "ws-b", OWNER));
    expect(line).toMatchObject({ ok: true, fromNumber: OWN_B, selectedWorkLineId: "n-b" });
  });

  it("a managed workspace whose PropLane line cannot be resolved REFUSES (never the old number)", async () => {
    const line = await resolveHouseSmsLine(world("per_workspace", { noServiceOwner: true }) as never, target("h-client", "ws-client", CLIENT));
    expect(line).toEqual({ ok: false, error: WORKSPACE_NO_WORK_NUMBER_CODE });
  });

  it("a workspace with no work number refuses; it does not borrow the owner's other workspace's number", async () => {
    const line = await resolveHouseSmsLine(world("per_workspace", { noOwnerBNumber: true }) as never, target("h-b", "ws-b", OWNER));
    expect(line).toEqual({ ok: false, error: WORKSPACE_NO_WORK_NUMBER_CODE });
  });

  it("a line that cannot be READ refuses as unreadable", async () => {
    const db = world("per_workspace");
    const from = db.from.bind(db);
    (db as { from: unknown }).from = (table: string) => {
      if (table !== "manager_sms_numbers") return from(table);
      const broken: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit", "in", "neq", "order"]) broken[m] = () => broken;
      broken.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message: "boom" } });
      broken.maybeSingle = async () => ({ data: null, error: { message: "boom" } });
      return broken;
    };
    const line = await resolveHouseSmsLine(db as never, target("h-b", "ws-b", OWNER));
    expect(line).toEqual({ ok: false, error: "control_plane_unreadable" });
  });
});

describe("resolveHouseSendTarget: derived from the actor's own access, never the body", () => {
  const request = new Request("http://localhost/api/portal/send-inbox-message", { method: "POST" });

  beforeEach(() => {
    h.workspaceError = null;
    h.workspace = { id: "ws-b", name: "Workspace B", ownerUserId: OWNER, owned: true, isDefault: false, propertyIds: ["h-b"] };
    h.grant = { ok: true, grant: { isOwner: true, grantedPropertyIds: null } };
  });

  it("the owner: the workspace and owner come from the house's workspace, not the owner's default", async () => {
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: OWNER, propertyId: "h-b" });
    expect(result).toEqual({ ok: true, target: target("h-b", "ws-b", OWNER) });
  });

  it("a teammate seat: the OWNER (whose wallet pays) is the target, never the teammate", async () => {
    h.grant = { ok: true, grant: { isOwner: false, grantedPropertyIds: new Set(["h-b"]) } };
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: TEAMMATE, propertyId: "h-b" });
    expect(result).toEqual({ ok: true, target: target("h-b", "ws-b", OWNER) });
  });

  it("refuses a house the teammate's Communication grant does not cover", async () => {
    h.grant = { ok: true, grant: { isOwner: false, grantedPropertyIds: new Set(["h-other"]) } };
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: TEAMMATE, propertyId: "h-b" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a teammate with no Communication access to the workspace", async () => {
    h.grant = { ok: false, status: 403, error: "You do not have access to Communication for this workspace." };
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: TEAMMATE, propertyId: "h-b" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a property id that belongs to another workspace, even to the same owner", async () => {
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: OWNER, propertyId: "h-a" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a property id that is another account's entirely", async () => {
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: OWNER, propertyId: "h-client" });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("a view-only (PropLane-managed) client owner cannot send", async () => {
    h.workspaceError = new ManagedReadOnlyError();
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: CLIENT, propertyId: "h-client" });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("a workspace that cannot be read refuses rather than guessing", async () => {
    h.workspaceError = new Error("db down");
    const result = await resolveHouseSendTarget(world("per_workspace") as never, { request, userId: OWNER, propertyId: "h-b" });
    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});
