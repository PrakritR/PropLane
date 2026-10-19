import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { knowledgeFakeDb, type Row } from "../helpers/knowledge-fake-db";

const state = vi.hoisted(() => ({ actor: null as unknown }));
vi.mock("@/lib/one-number/knowledge/route-auth.server", () => ({
  requireKnowledgeActor: async () =>
    state.actor ? { ok: true, actor: state.actor } : { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) },
  houseUsableByActor: async (actor: { allowedPropertyIds: string[] | null }, id: string) => !actor.allowedPropertyIds || actor.allowedPropertyIds.includes(id),
}));

import { GET as listKnowledge, POST as createKnowledge } from "@/app/api/portal/knowledge/route";
import { DELETE as deleteKnowledge, PATCH as patchKnowledge } from "@/app/api/portal/knowledge/[id]/route";
import { GET as getModes, PUT as putMode } from "@/app/api/portal/knowledge/reply-modes/route";
import { POST as postDraft } from "@/app/api/portal/knowledge/drafts/[id]/route";

const WS = "ws-a";
const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

function entry(over: Row): Row {
  return { workspace_id: WS, property_id: "p1", topic: "parking", question: "Bike parking?", answer: "Locked bike room.", status: "suggested", source: "manager_answer", audience: "residents", use_count: 0, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", ...over };
}

function setup(opts: { owner?: boolean; allowed?: string[] | null; rows?: Record<string, Row[]> } = {}) {
  const fake = knowledgeFakeDb({
    manager_property_records: [{ id: "p1", manager_user_id: "owner", workspace_id: WS, property_data: {}, row_data: {} }],
    property_knowledge_entries: [
      entry({ id: ID1 }),
      entry({ id: ID2, workspace_id: "ws-b" }),
      entry({ id: ID3, property_id: "p9" }),
    ],
    ...opts.rows,
  });
  state.actor = {
    userId: opts.owner === false ? "co" : "owner", db: fake.db, workspaceId: WS, ownerUserId: "owner",
    isOwner: opts.owner !== false, allowedPropertyIds: opts.owner === false ? (opts.allowed ?? ["p1"]) : null,
  };
  return fake;
}
const json = (body: unknown) => new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  state.actor = null;
});

describe("knowledge routes", () => {
  it("require a signed-in manager", async () => {
    expect((await listKnowledge(new Request("http://x"))).status).toBe(401);
    expect((await patchKnowledge(json({ action: "dismiss" }), ctx(ID1))).status).toBe(401);
    expect((await getModes()).status).toBe(401);
  });

  it("list only this workspace's entries", async () => {
    setup();
    const res = await listKnowledge(new Request("http://x"));
    const body = await res.json();
    expect(body.entries.map((e: { id: string }) => e.id).sort()).toEqual([ID1, ID3].sort());
  });

  it("approve saves for the house; another workspace's id is a 404", async () => {
    const fake = setup();
    const ok = await patchKnowledge(json({ action: "approve", scope: "house" }), ctx(ID1));
    expect(ok.status).toBe(200);
    expect(fake.rows.property_knowledge_entries!.find((e) => e.id === ID1)).toMatchObject({ status: "approved", decided_by: "owner" });
    const other = await patchKnowledge(json({ action: "approve", scope: "house" }), ctx(ID2));
    expect(other.status).toBe(404);
    expect(fake.rows.property_knowledge_entries!.find((e) => e.id === ID2)!.status).toBe("suggested");
  });

  it("approving twice is a conflict, not a second write", async () => {
    setup();
    await patchKnowledge(json({ action: "approve", scope: "house" }), ctx(ID1));
    expect((await patchKnowledge(json({ action: "approve", scope: "house" }), ctx(ID1))).status).toBe(409);
  });

  it("only the owner can make an answer team-wide", async () => {
    setup({ owner: false });
    const res = await patchKnowledge(json({ action: "approve", scope: "team" }), ctx(ID1));
    expect(res.status).toBe(403);
  });

  it("a co-manager can touch only their own houses' entries", async () => {
    const fake = setup({ owner: false });
    expect((await patchKnowledge(json({ action: "dismiss" }), ctx(ID3))).status).toBe(404);
    expect((await patchKnowledge(json({ action: "dismiss" }), ctx(ID1))).status).toBe(200);
    expect(fake.rows.property_knowledge_entries!.find((e) => e.id === ID1)!.status).toBe("rejected");
    expect((await deleteKnowledge(new Request("http://x"), ctx(ID3))).status).toBe(404);
  });

  it("edit changes the text and keeps the workspace", async () => {
    const fake = setup();
    const res = await patchKnowledge(json({ action: "edit", answer: "Locked bike room off the alley." }), ctx(ID1));
    expect(res.status).toBe(200);
    expect(fake.rows.property_knowledge_entries!.find((e) => e.id === ID1)).toMatchObject({ answer: "Locked bike room off the alley.", workspace_id: WS });
  });

  it("delete removes only a row in this workspace", async () => {
    const fake = setup();
    expect((await deleteKnowledge(new Request("http://x"), ctx(ID2))).status).toBe(404);
    expect((await deleteKnowledge(new Request("http://x"), ctx(ID1))).status).toBe(200);
    expect(fake.rows.property_knowledge_entries!.map((e) => e.id).sort()).toEqual([ID2, ID3].sort());
  });

  it("add by hand needs a question and answer, and team-wide is owner only", async () => {
    setup();
    expect((await createKnowledge(json({ question: "", answer: "x" }))).status).toBe(400);
    const made = await createKnowledge(json({ question: "Where is the fuse box?", answer: "Basement, left of the stairs.", propertyId: "p1", audience: "all" }));
    expect(made.status).toBe(201);
    expect((await made.json()).entry).toMatchObject({ status: "approved", source: "manual", audience: "all", propertyId: "p1" });
    setup({ owner: false });
    expect((await createKnowledge(json({ question: "q?", answer: "a long enough answer" }))).status).toBe(403);
  });
});

describe("reply mode routes", () => {
  it("default to full auto, unpicked, for every topic", async () => {
    setup();
    const body = await (await getModes()).json();
    expect(body.topics).toHaveLength(11);
    expect(body.topics.every((t: { mode: string; picked: boolean }) => t.mode === "full_auto" && !t.picked)).toBe(true);
  });

  it("the owner picks a ceiling; others cannot; bad input is refused", async () => {
    const fake = setup();
    const put = (body: unknown) => putMode(new Request("http://x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await put({ topic: "tour", mode: "draft" })).status).toBe(200);
    expect(fake.rows.sms_topic_reply_modes!.find((r) => r.topic === "tour")).toMatchObject({ mode: "draft", ceiling: "draft", workspace_id: WS });
    expect((await put({ topic: "nope", mode: "draft" })).status).toBe(400);
    expect((await put({ topic: "tour", mode: "wild" })).status).toBe(400);
    setup({ owner: false });
    expect((await put({ topic: "tour", mode: "draft" })).status).toBe(403);
  });
});

describe("draft routes", () => {
  it("reject a held draft in this workspace only", async () => {
    const fake = setup({ rows: { sms_ai_reply_drafts: [
      { id: ID1, workspace_id: WS, topic: "tour", mode: "draft", status: "pending" },
      { id: ID2, workspace_id: "ws-b", topic: "tour", mode: "draft", status: "pending" },
    ] } });
    expect((await postDraft(json({ action: "reject" }), ctx(ID1))).status).toBe(200);
    expect((await postDraft(json({ action: "reject" }), ctx(ID2))).status).toBe(404);
    expect(fake.rows.sms_ai_reply_drafts!.find((d) => d.id === ID2)!.status).toBe("pending");
    expect((await postDraft(json({ action: "bogus" }), ctx(ID1))).status).toBe(400);
  });

  it("a teammate can reject or review only drafts about a house they hold", async () => {
    const fake = setup({ owner: false, rows: { sms_ai_reply_drafts: [
      { id: ID1, workspace_id: WS, topic: "tour", mode: "draft", status: "pending", property_id: "p1" },
      { id: ID2, workspace_id: WS, topic: "tour", mode: "draft", status: "pending", property_id: "p9" },
      { id: ID3, workspace_id: WS, topic: "tour", mode: "auto_review", status: "pending", property_id: null },
    ] } });
    expect((await postDraft(json({ action: "reject" }), ctx(ID2))).status).toBe(404);
    expect((await postDraft(json({ action: "ok" }), ctx(ID3))).status).toBe(404);
    expect(fake.rows.sms_ai_reply_drafts!.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    expect((await postDraft(json({ action: "reject" }), ctx(ID1))).status).toBe(200);
    expect(fake.rows.sms_ai_reply_drafts!.find((d) => d.id === ID1)!.status).toBe("rejected");
  });
});
