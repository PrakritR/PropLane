import { beforeEach, describe, expect, it, vi } from "vitest";
import { knowledgeFakeDb, type Row } from "../helpers/knowledge-fake-db";

const mocks = vi.hoisted(() => ({
  createPendingActionForUser: vi.fn(async () => "action-1"),
  notifyManagerFromAgent: vi.fn(async () => ({ delivered: true, suppressed: false })),
  resolveOpenSmsProposal: vi.fn(async () => ({ status: "none" as const })),
  findOrCreatePortalAssistantSmsSession: vi.fn(async () => ({ id: "sess-1" })),
}));
vi.mock("@/lib/tools/pending-actions", () => ({ createPendingActionForUser: mocks.createPendingActionForUser }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: mocks.notifyManagerFromAgent }));
vi.mock("@/lib/sms/agent-confirmation.server", () => ({ resolveOpenSmsProposal: mocks.resolveOpenSmsProposal }));
vi.mock("@/lib/agent/sms-agent-turn.server", () => ({ findOrCreatePortalAssistantSmsSession: mocks.findOrCreatePortalAssistantSmsSession }));

import { captureFromManagerSend, isCapturableAnswer, recordEscalatedQuestion } from "@/lib/one-number/knowledge/capture.server";
import { approveSuggestedEntry, dismissSuggestedEntry } from "@/lib/one-number/knowledge/approval.server";
import { buildSaveOfferText, offerSaveBySms } from "@/lib/one-number/knowledge/sms-offer.server";
import { learnFromManagerSend } from "@/lib/one-number/knowledge/send-hook.server";
import { saveKnowledgeAnswerTool } from "@/lib/tools/domains/knowledge";
import { buildManagerSmsRegistry, agentRegistry, leasingSmsAgentRegistry, vendorWorkOrderAgentRegistry } from "@/lib/tools";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import type { AgentContext } from "@/lib/tools/context";

const WS = "ws-a";
const PHONE = "+12065550123";

function base(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    portal_workspaces: [{ id: WS, owner_user_id: "owner", is_default: true }],
    manager_property_records: [{ id: "p1", manager_user_id: "owner", workspace_id: WS, property_data: { title: "5259 Brooklyn" }, row_data: {} }],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ONE_NUMBER_KNOWLEDGE_SMS_OFFER;
});

describe("isCapturableAnswer", () => {
  it("keeps real answers and drops acknowledgements", () => {
    expect(isCapturableAnswer("The Wi-Fi password is tea-kettle-42")).toBe(true);
    expect(isCapturableAnswer("ok")).toBe(false);
    expect(isCapturableAnswer("Thanks!")).toBe(false);
    expect(isCapturableAnswer("on my way")).toBe(false);
    expect(isCapturableAnswer("yes it is")).toBe(false);
  });
});

describe("capturing a manager's answer to an escalation", () => {
  it("files a SUGGESTED entry from the texter's question and the manager's text", async () => {
    const fake = knowledgeFakeDb(base());
    await recordEscalatedQuestion(fake.db, { ownerUserId: "owner", phone: PHONE, role: "prospect", question: "Is there a place to park a bike?", propertyId: "p1" });
    const captured = await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "Yes, there is a locked bike room off the alley." });
    expect(captured).toMatchObject({ captured: true, via: "escalation", houseLabel: "5259 Brooklyn" });
    const row = fake.rows.property_knowledge_entries![0]!;
    expect(row).toMatchObject({
      workspace_id: WS, property_id: "p1", status: "suggested", source: "manager_answer",
      question: "Is there a place to park a bike?", answer: "Yes, there is a locked bike room off the alley.",
    });
    expect(row.topic).toBe("parking");
    expect(fake.rows.sms_escalated_questions![0]!.resolved_at).toBeTruthy();
  });

  it("never approves anything by itself", async () => {
    const fake = knowledgeFakeDb(base());
    await recordEscalatedQuestion(fake.db, { ownerUserId: "owner", phone: PHONE, role: "resident", question: "Where do I put the kayak?" });
    await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "There is a rack in the basement for kayaks." });
    expect(fake.rows.property_knowledge_entries!.every((e) => e.status === "suggested")).toBe(true);
  });

  it("ignores acknowledgements, other people, other owners and stale escalations", async () => {
    const fake = knowledgeFakeDb(base());
    await recordEscalatedQuestion(fake.db, { ownerUserId: "owner", phone: PHONE, role: "prospect", question: "Is there a gym nearby?" });
    expect(await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "ok" })).toEqual({ captured: false });
    expect(await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: "+12065559999", text: "There is a gym two blocks away." })).toEqual({ captured: false });
    expect(await captureFromManagerSend(fake.db, { ownerUserId: "someone-else", actorUserId: "someone-else", toPhone: PHONE, text: "There is a gym two blocks away." })).toEqual({ captured: false });
    fake.rows.sms_escalated_questions![0]!.escalated_at = new Date(Date.now() - 9 * 86_400_000).toISOString();
    expect(await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "There is a gym two blocks away." })).toEqual({ captured: false });
    expect(fake.rows.property_knowledge_entries ?? []).toEqual([]);
  });

  it("answers one escalation once: a second reply captures nothing new", async () => {
    const fake = knowledgeFakeDb(base());
    await recordEscalatedQuestion(fake.db, { ownerUserId: "owner", phone: PHONE, role: "prospect", question: "Is there a gym nearby?" });
    await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "There is a gym two blocks away." });
    const again = await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "It is open until midnight every day." });
    expect(again.captured).toBe(false);
    expect(fake.rows.property_knowledge_entries).toHaveLength(1);
  });

  it("does not break an escalation when the learning tables are missing", async () => {
    const fake = knowledgeFakeDb(base(), { broken: ["sms_escalated_questions"] });
    await expect(recordEscalatedQuestion(fake.db, { ownerUserId: "owner", phone: PHONE, role: "prospect", question: "Is there a gym nearby?" })).resolves.toBeUndefined();
    expect(await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "There is a gym two blocks away." })).toEqual({ captured: false });
  });
});

describe("capturing an edit of an AI draft", () => {
  const draft = { id: "d1", workspace_id: WS, owner_user_id: "owner", phone_key: "2065550123", topic: "parking", mode: "draft", status: "pending", inbound_text: "Can I park two cars?", body: "Street parking only.", property_id: "p1", created_at: "2026-10-18T00:00:00Z" };

  it("an edited draft becomes a suggested entry and counts as an edit", async () => {
    const fake = knowledgeFakeDb(base({ sms_ai_reply_drafts: [draft] }));
    const result = await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "Street parking only, two cars fit on the block." });
    expect(result).toMatchObject({ captured: true, via: "draft_edit" });
    expect(fake.rows.sms_ai_reply_drafts![0]).toMatchObject({ status: "edited_sent" });
    expect(fake.rows.sms_ai_reply_outcomes![0]).toMatchObject({ outcome: "edited", topic: "parking", mode: "draft" });
    expect(fake.rows.property_knowledge_entries![0]).toMatchObject({ source: "draft_edit", status: "suggested", question: "Can I park two cars?" });
  });

  it("a draft sent as written is a clean send and files nothing", async () => {
    const fake = knowledgeFakeDb(base({ sms_ai_reply_drafts: [draft] }));
    const result = await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "Street  parking only." });
    expect(result).toEqual({ captured: false });
    expect(fake.rows.sms_ai_reply_outcomes![0]).toMatchObject({ outcome: "sent_as_is" });
    expect(fake.rows.property_knowledge_entries ?? []).toEqual([]);
  });

  it("an auto-review flag is not a draft a manager's next text edits", async () => {
    const fake = knowledgeFakeDb(base({ sms_ai_reply_drafts: [{ ...draft, mode: "auto_review" }] }));
    const result = await captureFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "Actually two cars fit on the block." });
    expect(result).toEqual({ captured: false });
    expect(fake.rows.sms_ai_reply_drafts![0]!.status).toBe("pending");
  });
});

describe("approval", () => {
  const suggestion = { id: "s1", workspace_id: WS, property_id: "p1", topic: "parking", question: "Bike parking?", answer: "Locked bike room off the alley.", status: "suggested", source: "manager_answer", audience: "residents", use_count: 0, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" };

  it("saving for the house keeps the house; saving for the team clears it", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [suggestion, { ...suggestion, id: "s2" }] }));
    const house = await approveSuggestedEntry(fake.db, { workspaceId: WS, ownerUserId: "owner", entryId: "s1", actorUserId: "owner", scope: "house" });
    expect(house).toMatchObject({ ok: true });
    expect(fake.rows.property_knowledge_entries![0]).toMatchObject({ status: "approved", property_id: "p1", decided_by: "owner" });
    const team = await approveSuggestedEntry(fake.db, { workspaceId: WS, ownerUserId: "owner", entryId: "s2", actorUserId: "owner", scope: "team", audience: "all" });
    expect(team).toMatchObject({ ok: true });
    expect(fake.rows.property_knowledge_entries![1]).toMatchObject({ status: "approved", property_id: null, audience: "all" });
  });

  it("refuses an entry from another workspace, one already decided, and a house-less house save", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [{ ...suggestion, workspace_id: "ws-b" }, { ...suggestion, id: "s3", status: "approved" }, { ...suggestion, id: "s4", property_id: null }] }));
    expect(await approveSuggestedEntry(fake.db, { workspaceId: WS, ownerUserId: "owner", entryId: "s1", actorUserId: "owner", scope: "house" })).toEqual({ ok: false, reason: "not_found" });
    expect(await approveSuggestedEntry(fake.db, { workspaceId: WS, ownerUserId: "owner", entryId: "s3", actorUserId: "owner", scope: "house" })).toEqual({ ok: false, reason: "not_suggested" });
    expect(await approveSuggestedEntry(fake.db, { workspaceId: WS, ownerUserId: "owner", entryId: "s4", actorUserId: "owner", scope: "house" })).toEqual({ ok: false, reason: "no_house" });
  });

  it("dismissing marks it rejected", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [suggestion] }));
    expect(await dismissSuggestedEntry(fake.db, { workspaceId: WS, entryId: "s1", actorUserId: "owner" })).toBe(true);
    expect(fake.rows.property_knowledge_entries![0]!.status).toBe("rejected");
    expect(await dismissSuggestedEntry(fake.db, { workspaceId: WS, entryId: "s1", actorUserId: "owner" })).toBe(false);
  });
});

describe("approval by text (the YES gate)", () => {
  const suggestion = { id: "11111111-1111-4111-8111-111111111111", workspace_id: WS, property_id: "p1", topic: "parking", question: "Bike parking?", answer: "Locked bike room off the alley.", status: "suggested", source: "manager_answer", audience: "residents", use_count: 0, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z" };
  const ctxFor = (db: never, over: Partial<AgentContext> = {}) =>
    ({ landlordId: "owner", userId: "owner", email: "", roles: ["manager"], isAdmin: false, db, workspace: { id: WS, name: "A", isDefault: true, narrowing: false, propertyIds: ["p1"] }, ...over }) as AgentContext;

  it("the offer text is one short segment with no emoji", () => {
    expect(buildSaveOfferText("5259 Brooklyn")).toBe("Save this answer for 5259 Brooklyn? Reply YES.");
    expect(buildSaveOfferText(null)).toBe("Save this answer for this house? Reply YES.");
    expect(buildSaveOfferText("x".repeat(100)).length).toBeLessThan(80);
  });

  it("the save tool previews exactly what will be saved, then saves on confirm", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [suggestion] }));
    const ctx = ctxFor(fake.db);
    const preview = await saveKnowledgeAnswerTool.preview(ctx, { entryId: suggestion.id });
    expect(preview.fields).toEqual(expect.arrayContaining([{ label: "Question", value: "Bike parking?" }, { label: "Answer", value: "Locked bike room off the alley." }]));
    expect(fake.rows.property_knowledge_entries![0]!.status).toBe("suggested");
    const done = (await saveKnowledgeAnswerTool.handler(ctx, { entryId: suggestion.id })) as { reply: string };
    expect(done.reply).toMatch(/Saved/);
    expect(fake.rows.property_knowledge_entries![0]).toMatchObject({ status: "approved", property_id: "p1" });
    expect(fake.rows.audit_log![0]).toMatchObject({ action: "knowledge_answer_saved", landlord_id: "owner" });
  });

  it("another team's entry id cannot be saved", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [{ ...suggestion, workspace_id: "ws-b" }] }));
    await expect(saveKnowledgeAnswerTool.preview(ctxFor(fake.db), { entryId: suggestion.id })).rejects.toThrow(/no longer/);
    const out = (await saveKnowledgeAnswerTool.handler(ctxFor(fake.db), { entryId: suggestion.id })) as { reply: string };
    expect(out.reply).toMatch(/no longer available/);
    expect(fake.rows.property_knowledge_entries![0]!.status).toBe("suggested");
  });

  it("a co-manager can save for their houses but never team-wide", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [suggestion, { ...suggestion, id: "22222222-2222-4222-8222-222222222222", property_id: "p9" }] }));
    const ctx = ctxFor(fake.db, {
      userId: "co",
      managerSmsAccess: { mode: "delegated", workNumberOwnerId: "owner", actorUserId: "co", dataOwnerIds: ["owner"], assignedPropertyIds: ["p1"] } as never,
      workspace: { id: WS, name: "A", isDefault: true, narrowing: true, propertyIds: ["p1"] },
    });
    expect(((await saveKnowledgeAnswerTool.handler(ctx, { entryId: suggestion.id, scope: "team" })) as { reply: string }).reply).toMatch(/assigned to you/);
    expect(((await saveKnowledgeAnswerTool.handler(ctx, { entryId: "22222222-2222-4222-8222-222222222222" })) as { reply: string }).reply).toMatch(/assigned to you/);
    expect(((await saveKnowledgeAnswerTool.handler(ctx, { entryId: suggestion.id })) as { reply: string }).reply).toMatch(/Saved/);
  });

  it("the offer goes through the pending-action gate and is skipped while the shared line is off", async () => {
    const fake = knowledgeFakeDb(base({ property_knowledge_entries: [suggestion] }));
    const entry = { id: suggestion.id, workspaceId: WS, propertyId: "p1", question: "Bike parking?", answer: "Locked bike room off the alley." } as never;
    expect(await offerSaveBySms(fake.db, { ownerUserId: "owner", actorUserId: "owner", entry, houseLabel: "5259 Brooklyn" })).toBe("skipped");
    expect(mocks.createPendingActionForUser).not.toHaveBeenCalled();

    expect(await offerSaveBySms(fake.db, { ownerUserId: "owner", actorUserId: "owner", entry, houseLabel: "5259 Brooklyn", force: true })).toBe("offered");
    expect(mocks.createPendingActionForUser).toHaveBeenCalledWith(fake.db, expect.objectContaining({
      toolName: "save_knowledge_answer", userId: "owner", portal: "manager", sessionId: "sess-1", input: { entryId: suggestion.id, scope: "house" },
    }));
    expect(mocks.notifyManagerFromAgent).toHaveBeenCalledWith(fake.db, expect.objectContaining({
      externalText: "Save this answer for 5259 Brooklyn? Reply YES.", landlordId: "owner", notify: { push: false, sms: true },
    }));
  });

  it("does not stack a second proposal while another is open", async () => {
    mocks.resolveOpenSmsProposal.mockResolvedValueOnce({ status: "one" } as never);
    const fake = knowledgeFakeDb(base());
    const entry = { id: "e", workspaceId: WS, propertyId: "p1", question: "q", answer: "a" } as never;
    expect(await offerSaveBySms(fake.db, { ownerUserId: "owner", actorUserId: "owner", entry, houseLabel: null, force: true })).toBe("skipped");
    expect(mocks.createPendingActionForUser).not.toHaveBeenCalled();
  });

  it("a text to a teammate is never an answer", async () => {
    const fake = knowledgeFakeDb(base());
    await learnFromManagerSend(fake.db, { ownerUserId: "owner", actorUserId: "owner", toPhone: PHONE, text: "There is a gym two blocks away.", counterpartyRole: "manager" });
    expect(fake.touched).toEqual([]);
  });
});

describe("registries", () => {
  it("every texting role can look knowledge up, and only the manager can save it", () => {
    expect(agentRegistry.has("lookup_property_knowledge")).toBe(true);
    expect(leasingSmsAgentRegistry.has("lookup_property_knowledge")).toBe(true);
    expect(vendorWorkOrderAgentRegistry.has("lookup_property_knowledge")).toBe(true);
    expect(residentAgentRegistry.has("lookup_property_knowledge")).toBe(true);
    for (const registry of [leasingSmsAgentRegistry, vendorWorkOrderAgentRegistry, residentAgentRegistry]) {
      expect(registry.has("save_knowledge_answer")).toBe(false);
    }
  });

  it("save is reachable by manager text (non-destructive) but is a write behind a confirmation", () => {
    const tool = buildManagerSmsRegistry().get("save_knowledge_answer");
    expect(tool?.kind).toBe("write");
    expect((tool as { destructive?: boolean }).destructive).toBeFalsy();
  });
});
