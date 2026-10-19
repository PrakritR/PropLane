// Communication routes added for the one-number work check the teammate's Communication (inbox)
// module on the house, not house membership: view reads, edit writes, calendar-only gets nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeFakeDb, type Row } from "../helpers/knowledge-fake-db";

vi.mock("server-only", () => ({}));

type Grants = Record<string, Record<string, string[]>>;
const h = vi.hoisted(() => ({
  user: { id: "mate" } as { id: string; user_metadata?: Record<string, unknown> } | null,
  manager: true,
  provisioned: 0,
  db: null as unknown,
  workspace: { id: "ws-1", name: "W", ownerUserId: "owner", owned: false, isDefault: true, propertyIds: ["h1", "h2"] } as {
    id: string; name: string; ownerUserId: string; owned: boolean; isDefault: boolean; propertyIds: string[];
  },
  grants: {} as Grants,
  grantReadFails: false,
  announce: vi.fn(async () => ({ ok: true, sent: 1, houses: [] })),
  approve: vi.fn(async () => ({ ok: true })),
  dismiss: vi.fn(async () => true),
  run: { property_id: "h1" } as Record<string, unknown> | null,
  createCode: vi.fn(async (_db: unknown, input: { propertyId: string }) => ({ ok: true, record: { code: "ABC1", propertyId: input.propertyId, active: true } })),
  setActive: vi.fn(async (_db: unknown, input: { allowedPropertyIds: string[] }) => ({ ok: true, record: { code: "ABC1", propertyId: input.allowedPropertyIds[0] ?? "h1", active: true } })),
  listCodes: vi.fn(async () => [{ code: "A1", propertyId: "h1", active: true }, { code: "B2", propertyId: "h2", active: true }]),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => h.db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "ok" }) }));
vi.mock("@/lib/manager-route-guard.server", () => ({
  userHoldsManagerRole: async () => h.manager,
  requireManagerRouteUser: async () => (h.user && h.manager ? { db: h.db, userId: h.user.id } : null),
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: async () => {
    h.provisioned += 1;
    return h.workspace;
  },
  resolveWorkspaceFromSettingsRequest: async () => h.workspace,
}));
vi.mock("@/lib/manager-communication-access.server", () => ({ assertManagerCommunicationAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerScopeForModule: async (_db: unknown, _user: string, module: string, level: string) => {
    if (h.grantReadFails) throw new Error("grant read failed");
    const ids = h.grants[module]?.[level] ?? [];
    return { ownerIds: new Set(ids.length ? ["owner"] : []), propertyIdsByOwner: new Map(ids.length ? [["owner", new Set(ids)]] : []), propertyIds: new Set(ids) };
  },
}));
vi.mock("@/lib/automations/announce.server", () => ({ announceToHouses: h.announce, listAnnounceHouses: async () => [] }));
vi.mock("@/lib/automations/fire.server", () => ({ approveHeldRun: h.approve, dismissHeldRun: h.dismiss }));
vi.mock("@/lib/automations/store.server", () => ({ loadRun: async () => h.run }));
vi.mock("@/lib/one-number/entry-codes.server", () => ({
  createEntryCode: h.createCode,
  setEntryCodeActive: h.setActive,
  listEntryCodes: h.listCodes,
  suggestEntryCode: async () => null,
}));
vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: async () => ({ mode: "shared", sharedNumber: "+12065550100", dedicatedWorkspaceIds: [] }),
  workspaceHasDedicatedNumber: () => false,
}));
vi.mock("@/lib/one-number/entry-codes-api.server", () => ({
  ENTRY_CODE_ERROR_STATUS: {},
  entryCodeErrorMessage: () => "x",
  presentEntryCode: (r: unknown) => r,
}));

import { POST as announce } from "@/app/api/portal/automations/announce/route";
import { POST as runAction } from "@/app/api/portal/automations/runs/[id]/route";
import { GET as listCodes, POST as createCode } from "@/app/api/portal/one-number/entry-codes/route";
import { PATCH as patchCode } from "@/app/api/portal/one-number/entry-codes/[code]/route";
import { GET as getEscalations, PATCH as patchEscalation } from "@/app/api/portal/one-number/escalations/route";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

const json = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patchReq = (body: unknown) => new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const runCtx = { params: Promise.resolve({ id: "run-1" }) };
const codeCtx = { params: Promise.resolve({ code: "ABC1" }) };

beforeEach(() => {
  h.user = { id: "mate" };
  h.manager = true;
  h.provisioned = 0;
  h.grantReadFails = false;
  h.grants = {};
  h.run = { property_id: "h1" };
  h.workspace = { id: "ws-1", name: "W", ownerUserId: "owner", owned: false, isDefault: true, propertyIds: ["h1", "h2"] };
  h.db = knowledgeFakeDb({
    manager_property_records: [
      { id: "h1", manager_user_id: "owner", workspace_id: "ws-1" },
      { id: "h2", manager_user_id: "owner", workspace_id: "ws-1" },
    ],
    sms_escalated_questions: [{ id: "e1", workspace_id: "ws-1", property_id: "h1", source: "agent", topic: "tour", question: "q", escalated_at: "2026-10-18T00:00:00Z", resolved_at: null }],
  } as Record<string, Row[]>).db;
  for (const fn of [h.announce, h.approve, h.dismiss, h.createCode, h.setActive, h.listCodes]) fn.mockClear();
});

const calendarOnly: Grants = { calendar: { read: ["h1", "h2"], edit: ["h1", "h2"] } };
const inboxView: Grants = { inbox: { read: ["h1"] } };
const inboxEdit: Grants = { inbox: { read: ["h1"], edit: ["h1"] } };

describe("requireKnowledgeActor", () => {
  it("checks the manager role before any workspace is resolved (no workspace is provisioned for a non-manager)", async () => {
    h.manager = false;
    const res = await requireKnowledgeActor("read");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
    expect(h.provisioned).toBe(0);
  });

  it("refuses a teammate who holds house membership but only the calendar module", async () => {
    h.grants = calendarOnly;
    for (const level of ["read", "edit"] as const) {
      const res = await requireKnowledgeActor(level);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.response.status).toBe(403);
    }
  });

  it("view access reads, edit access writes, and the houses are the granted ones in this workspace", async () => {
    h.grants = inboxView;
    const read = await requireKnowledgeActor("read");
    expect(read.ok && read.actor.allowedPropertyIds).toEqual(["h1"]);
    const write = await requireKnowledgeActor("edit");
    expect(write.ok).toBe(false);
    h.grants = { inbox: { read: ["h1", "h-elsewhere"], edit: ["h1", "h-elsewhere"] } };
    const edit = await requireKnowledgeActor("edit");
    expect(edit.ok && edit.actor.allowedPropertyIds).toEqual(["h1"]);
  });

  it("keeps the owner whole and fails closed when the grant cannot be read", async () => {
    h.user = { id: "owner" };
    h.workspace = { ...h.workspace, owned: true };
    const owner = await requireKnowledgeActor("edit");
    expect(owner.ok && owner.actor.isOwner).toBe(true);
    expect(owner.ok && owner.actor.allowedPropertyIds).toBeNull();
    h.user = { id: "mate" };
    h.workspace = { ...h.workspace, owned: false };
    h.grantReadFails = true;
    const failed = await requireKnowledgeActor("read");
    expect(!failed.ok && failed.response.status).toBe(503);
  });
});

describe("a calendar-only teammate is refused on every Communication write", () => {
  beforeEach(() => {
    h.grants = calendarOnly;
  });

  it("announce, automation approve, entry-code create/toggle, escalation resolve", async () => {
    expect((await announce(json({ text: "Hi", houseIds: ["h1"] }))).status).toBe(403);
    expect((await runAction(json({ action: "send" }), runCtx)).status).toBe(403);
    expect((await createCode(json({ propertyId: "h1" }))).status).toBe(403);
    expect((await patchCode(patchReq({ active: false }), codeCtx)).status).toBe(403);
    expect((await patchEscalation(patchReq({ id: "e1", action: "resolve" }))).status).toBe(403);
    expect((await getEscalations(new Request("http://x"))).status).toBe(403);
    expect((await listCodes(new Request("http://x?propertyId=h1"))).status).toBe(403);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.createCode).not.toHaveBeenCalled();
    expect(h.setActive).not.toHaveBeenCalled();
  });
});

describe("inbox view access reads but never writes", () => {
  beforeEach(() => {
    h.grants = inboxView;
  });

  it("reads escalations and entry codes for the granted house only", async () => {
    expect((await getEscalations(new Request("http://x"))).status).toBe(200);
    const res = await listCodes(new Request("http://x"));
    expect(res.status).toBe(200);
    expect((await res.json()).codes.map((c: { propertyId: string }) => c.propertyId)).toEqual(["h1"]);
    expect((await listCodes(new Request("http://x?propertyId=h2"))).status).toBe(404);
  });

  it("refuses announce, approve, create, toggle and resolve (403)", async () => {
    expect((await announce(json({ text: "Hi", houseIds: ["h1"] }))).status).toBe(403);
    expect((await runAction(json({ action: "send" }), runCtx)).status).toBe(403);
    expect((await createCode(json({ propertyId: "h1" }))).status).toBe(403);
    expect((await patchCode(patchReq({ active: true }), codeCtx)).status).toBe(403);
    expect((await patchEscalation(patchReq({ id: "e1", action: "resolve" }))).status).toBe(403);
    expect(h.announce).not.toHaveBeenCalled();
    expect(h.createCode).not.toHaveBeenCalled();
  });
});

describe("inbox edit access writes on the granted house only", () => {
  beforeEach(() => {
    h.grants = inboxEdit;
  });

  it("announce is narrowed to the granted houses", async () => {
    expect((await announce(json({ text: "Hi", houseIds: "all" }))).status).toBe(200);
    expect(h.announce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowedPropertyIds: ["h1"] }));
  });

  it("approves a held run on a granted house, 404s one on another house", async () => {
    expect((await runAction(json({ action: "send" }), runCtx)).status).toBe(200);
    h.run = { property_id: "h2" };
    expect((await runAction(json({ action: "send" }), runCtx)).status).toBe(404);
    expect(h.approve).toHaveBeenCalledTimes(1);
  });

  it("creates an entry code for the granted house, 404 for the other", async () => {
    expect((await createCode(json({ propertyId: "h1" }))).status).toBe(201);
    expect((await createCode(json({ propertyId: "h2" }))).status).toBe(404);
    expect(h.createCode).toHaveBeenCalledTimes(1);
  });

  it("toggles a code only within the granted houses", async () => {
    expect((await patchCode(patchReq({ active: false }), codeCtx)).status).toBe(200);
    expect(h.setActive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowedPropertyIds: ["h1"] }));
  });

  it("resolves an escalation", async () => {
    expect((await patchEscalation(patchReq({ id: "e1", action: "resolve" }))).status).toBe(200);
  });
});

describe("the workspace owner keeps full access", () => {
  it("announces to every house and creates a code for any house", async () => {
    h.user = { id: "owner" };
    h.workspace = { ...h.workspace, owned: true };
    expect((await announce(json({ text: "Hi", houseIds: "all" }))).status).toBe(200);
    expect(h.announce).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowedPropertyIds: null }));
    expect((await createCode(json({ propertyId: "h2" }))).status).toBe(201);
  });
});
