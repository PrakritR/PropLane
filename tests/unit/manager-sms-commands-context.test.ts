import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findVerifiedProfileByPhone: vi.fn(),
  identifyServiceManagerPhone: vi.fn(),
  listLineMemberships: vi.fn(),
  resolveManagerSmsAccess: vi.fn(),
  holdsAdminRole: vi.fn(),
  buildServiceManagerAgentContext: vi.fn(),
  resolveManagerSmsAgentContext: vi.fn(),
}));

vi.mock("@/lib/one-number/router-lookups.server", () => ({ findVerifiedProfileByPhone: mocks.findVerifiedProfileByPhone }));
vi.mock("@/lib/service/service-manager.server", () => ({ identifyServiceManagerPhone: mocks.identifyServiceManagerPhone }));
vi.mock("@/lib/one-number/line-member-status.server", () => ({ listLineMemberships: mocks.listLineMemberships }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsAccess: mocks.resolveManagerSmsAccess }));
vi.mock("@/lib/sms/service-manager-inbound.server", () => ({
  holdsAdminRole: mocks.holdsAdminRole,
  buildServiceManagerAgentContext: mocks.buildServiceManagerAgentContext,
}));
vi.mock("@/lib/tools/manager-sms-context", () => ({ resolveManagerSmsAgentContext: mocks.resolveManagerSmsAgentContext }));

import { buildCommandContext, phoneBelongsToActor } from "@/lib/manager-sms-commands/context.server";
import { makeCommandDb } from "../helpers/command-fake-db";

const ctx = (id: string) => ({ landlordId: id, userId: id }) as never;
let db: ReturnType<typeof makeCommandDb>;

function workspaces(row: Record<string, unknown>) {
  return makeCommandDb({ portal_workspaces: [{ id: "ws-1", name: "Ambika", owner_user_id: "client-1", is_default: false, is_service: false, ...row }] });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.findVerifiedProfileByPhone.mockResolvedValue(null);
  mocks.identifyServiceManagerPhone.mockResolvedValue(null);
  mocks.holdsAdminRole.mockResolvedValue(false);
  mocks.listLineMemberships.mockResolvedValue([]);
  mocks.resolveManagerSmsAccess.mockResolvedValue(null);
});

describe("phoneBelongsToActor", () => {
  it("is true only for the verified, unique owner of that phone", async () => {
    db = makeCommandDb();
    mocks.findVerifiedProfileByPhone.mockResolvedValue({ id: "staff-1", email: "s@x.test" });
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "staff-1" })).toBe(true);
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "someone-else" })).toBe(false);
  });

  it("an unverified, shared or unknown phone (no unique verified profile) is nobody", async () => {
    db = makeCommandDb();
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "staff-1" })).toBe(false);
  });

  it("accepts the verified phone of the admin Service settings for its owner", async () => {
    db = makeCommandDb();
    mocks.identifyServiceManagerPhone.mockResolvedValue({ ownerUserId: "service-owner" });
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "service-owner" })).toBe(true);
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "intruder" })).toBe(false);
  });

  it("fails closed on an unreadable lookup or a blank input", async () => {
    db = makeCommandDb();
    mocks.findVerifiedProfileByPhone.mockRejectedValue(new Error("db down"));
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "staff-1" })).toBe(false);
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "", actorUserId: "staff-1" })).toBe(false);
    expect(await phoneBelongsToActor(db as never, { staffPhoneE164: "+12065550142", actorUserId: "" })).toBe(false);
  });
});

describe("buildCommandContext", () => {
  it("owner of a self-serve workspace: the ordinary owner context", async () => {
    db = workspaces({});
    mocks.resolveManagerSmsAgentContext.mockResolvedValue({ ok: true, ctx: ctx("client-1") });
    expect(await buildCommandContext(db as never, { actorUserId: "client-1", workspaceId: "ws-1" })).toEqual(ctx("client-1"));
  });

  it("the client owner of a PropLane-managed workspace is view-only: no context", async () => {
    db = workspaces({ is_service: true });
    expect(await buildCommandContext(db as never, { actorUserId: "client-1", workspaceId: "ws-1" })).toBeNull();
    expect(mocks.resolveManagerSmsAgentContext).not.toHaveBeenCalled();
  });

  it("admin-owned managed workspace (owner IS the service owner): that admin runs it in owner mode, never null", async () => {
    db = workspaces({ is_service: true, owner_user_id: "admin-1" });
    mocks.holdsAdminRole.mockResolvedValue(true);
    mocks.buildServiceManagerAgentContext.mockResolvedValue({ ok: true, ctx: ctx("admin-1") });
    expect(await buildCommandContext(db as never, { actorUserId: "admin-1", workspaceId: "ws-1" })).toEqual(ctx("admin-1"));
    expect(mocks.buildServiceManagerAgentContext.mock.calls[0]![1]).toMatchObject({ serviceOwnerId: "admin-1", workspace: { id: "ws-1", ownerUserId: "admin-1" } });
  });

  it("a non-admin owner of a managed workspace stays view-only", async () => {
    db = workspaces({ is_service: true, owner_user_id: "client-1" });
    mocks.holdsAdminRole.mockResolvedValue(false);
    expect(await buildCommandContext(db as never, { actorUserId: "client-1", workspaceId: "ws-1" })).toBeNull();
  });

  it("an admin runs a managed workspace; a seat holder gets their own seat's context; a stranger gets nothing", async () => {
    db = workspaces({ is_service: true });
    mocks.holdsAdminRole.mockResolvedValueOnce(true);
    mocks.buildServiceManagerAgentContext.mockResolvedValue({ ok: true, ctx: ctx("admin-1") });
    expect(await buildCommandContext(db as never, { actorUserId: "admin-1", workspaceId: "ws-1" })).toEqual(ctx("admin-1"));
    expect(mocks.buildServiceManagerAgentContext.mock.calls[0]![1]).toMatchObject({ serviceOwnerId: "admin-1", workspace: { id: "ws-1" } });
    expect(mocks.buildServiceManagerAgentContext.mock.calls[0]![1].seat).toBeUndefined();

    mocks.listLineMemberships.mockResolvedValue([{ kind: "teammate", isService: true, workspaceId: "ws-1", teamRole: "viewer" }]);
    mocks.buildServiceManagerAgentContext.mockResolvedValue({ ok: true, ctx: ctx("seat-1") });
    expect(await buildCommandContext(db as never, { actorUserId: "seat-1", workspaceId: "ws-1" })).toEqual(ctx("seat-1"));
    expect(mocks.buildServiceManagerAgentContext.mock.calls[1]![1].seat).toMatchObject({ viewerRole: true });

    mocks.listLineMemberships.mockResolvedValue([]);
    expect(await buildCommandContext(db as never, { actorUserId: "stranger", workspaceId: "ws-1" })).toBeNull();
  });

  it("a seat with no houses here (or any lookup failure) gets nothing", async () => {
    db = workspaces({ is_service: true });
    mocks.listLineMemberships.mockResolvedValue([{ kind: "teammate", isService: true, workspaceId: "ws-1", teamRole: "property_manager" }]);
    mocks.buildServiceManagerAgentContext.mockResolvedValue({ ok: false, reason: "no_houses" });
    expect(await buildCommandContext(db as never, { actorUserId: "seat-1", workspaceId: "ws-1" })).toBeNull();
    mocks.listLineMemberships.mockRejectedValue(new Error("db"));
    expect(await buildCommandContext(db as never, { actorUserId: "seat-1", workspaceId: "ws-1" })).toBeNull();
  });

  it("a co-manager of a self-serve workspace needs a delegated access", async () => {
    db = workspaces({});
    expect(await buildCommandContext(db as never, { actorUserId: "co-1", workspaceId: "ws-1" })).toBeNull();
    mocks.resolveManagerSmsAccess.mockResolvedValue({ mode: "delegated" });
    mocks.resolveManagerSmsAgentContext.mockResolvedValue({ ok: true, ctx: ctx("co-1") });
    expect(await buildCommandContext(db as never, { actorUserId: "co-1", workspaceId: "ws-1" })).toEqual(ctx("co-1"));
  });

  it("an unknown workspace gets nothing", async () => {
    db = workspaces({});
    expect(await buildCommandContext(db as never, { actorUserId: "client-1", workspaceId: "nope" })).toBeNull();
  });
});
