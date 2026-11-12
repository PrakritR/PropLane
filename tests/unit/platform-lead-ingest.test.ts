/**
 * design-1112 §6 acceptance 7 (platform): a fixture inquiry mail -> ONE thread tagged with the site and the exact room ->
 * notified like a text -> an inbound text quoting the stitch code merges it into the phone-keyed record and the platform
 * thread is MOVED -> the platform is never answered again.
 *
 * The prospect spine (Package A) is replaced by an in-memory stand-in that implements the contract in design §3.0
 * (recordInbound idempotent on eventId, mintStitchCode, stitchByCode / stitchByPhone, moved state): this proves the
 * lead module's use of the contract, not Package A's implementation.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent/leasing-email-agent.server", () => ({ runLeasingEmailAgentTurn: vi.fn() }));
vi.mock("@/lib/agent/manager-email-agent.server", () => ({ deliverManagerEmailReply: vi.fn() }));
vi.mock("@/lib/automation-send-mode.server", () => ({ partyFacingAnswerHold: vi.fn() }));
vi.mock("@/lib/inbound-email/inbound-email-headers.server", () => ({ fetchResendReceivedEmailHeaders: vi.fn() }));
vi.mock("@/lib/listing-text-number.server", () => ({ resolveListingTextNumbers: vi.fn(), listingTextNumberKey: vi.fn() }));
vi.mock("@/lib/manager-assistant-email/channel-guest-message.server", () => ({ formatUsPhone: vi.fn(), storeChannelMailUnanswered: vi.fn() }));
vi.mock("@/lib/manager-assistant-email/channel-guest-thread.server", () => ({ stampThreadRowData: vi.fn() }));
vi.mock("@/lib/manager-assistant-email/email-auto-reply-credit.server", () => ({ finishEmailAutoReplyCredit: vi.fn(), reserveEmailAutoReplyCredit: vi.fn() }));
vi.mock("@/lib/marketing/public-texting.server", () => ({ getPublicTextingConfig: vi.fn() }));
vi.mock("@/lib/prospect-spine/index.server", () => ({ contextLabel: vi.fn(), mintStitchCode: vi.fn(), recordInbound: vi.fn(), recordOutbound: vi.fn(), stitchByPhone: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/service/service-catalog.server", () => ({ loadServiceWorkspaceIds: vi.fn() }));

import { ingestPlatformLead, type LeadAnswer, type LeadIngestDeps, type LeadIngestInput } from "@/lib/platform-leads/ingest.server";
import type { ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";
import type { RecordInboundInput, RecordInboundResult, StitchResult } from "@/lib/prospect-spine/contracts";
import { ROOMIES_INQUIRY, SPAREROOM_INQUIRY } from "../fixtures/platform-mail";

const WS = "ws-1";
const OWNER = "owner-1";
const CANDIDATES: ChannelRoomCandidate[] = [
  { propertyId: "p-4709a", propertyLabel: "4709a 8th Ave NE", roomId: "r8", roomLabel: "Room 8", reservationCodes: [] },
  { propertyId: "p-4709a", propertyLabel: "4709a 8th Ave NE", roomId: "r9", roomLabel: "Room 9", reservationCodes: [] },
  { propertyId: "p-5259", propertyLabel: "5259 Brooklyn Ave NE", roomId: "r4", roomLabel: "Room 4", reservationCodes: [] },
];

/** The spine contract of design §3.0, in memory. */
class FakeSpine {
  threads = new Map<string, { id: string; key: string; messages: Array<{ eventId: string; channel: string; body: string; outbound: boolean }>; row: Record<string, unknown> }>();
  contexts = new Map<string, { id: string; handle: string | null; phone: string | null; threadId: string; source: string; state: "active" | "moved"; code: string | null; tag: string }>();
  alerts: string[] = [];
  outbound: string[] = [];
  seq = 0;

  recordInbound = async (input: RecordInboundInput): Promise<RecordInboundResult> => {
    if (input.identity.kind !== "handle") return { ok: false, reason: "invalid_identity" };
    const handle = input.identity.contactHandle;
    let ctx = [...this.contexts.values()].find((c) => c.handle === handle);
    let created = false;
    if (!ctx) {
      this.seq += 1;
      const thread = { id: `thread-${this.seq}`, key: `handle:${handle}`, messages: [], row: {} as Record<string, unknown> };
      this.threads.set(thread.id, thread);
      const tag = `${input.identity.site === "spareroom" ? "SpareRoom" : "Roomies"} · ${input.context.roomLabel ? `${input.context.propertyId ?? ""} ${input.context.roomLabel}` : ""}`.trim();
      ctx = { id: `ctx-${this.seq}`, handle, phone: null, threadId: thread.id, source: input.context.source, state: "active", code: null, tag };
      this.contexts.set(ctx.id, ctx);
      created = true;
    }
    const thread = this.threads.get(ctx.threadId)!;
    if (thread.messages.some((m) => m.eventId === input.eventId)) return { ok: true, threadId: thread.id, messageId: input.eventId, contextId: ctx.id, created: false, duplicate: true, label: ctx.tag };
    thread.messages.push({ eventId: input.eventId, channel: input.channel, body: input.body, outbound: false });
    thread.row.prospectContext = { propertyId: input.context.propertyId, roomId: input.context.roomId, roomLabel: input.context.roomLabel, source: input.context.source };
    if (input.notify !== false) this.alerts.push(`${ctx.tag}: ${input.body.slice(0, 40)}`);
    return { ok: true, threadId: thread.id, messageId: input.eventId, contextId: ctx.id, created, duplicate: false, label: ctx.tag };
  };
  mintStitchCode = async (contextId: string) => {
    const ctx = this.contexts.get(contextId)!;
    ctx.code ??= createHash("sha256").update(contextId).digest("hex").slice(0, 5).toUpperCase();
    return ctx.code;
  };
  private foldInto(ctxId: string, phoneE164: string): string {
    const ctx = this.contexts.get(ctxId)!;
    const platform = this.threads.get(ctx.threadId)!;
    const existing = [...this.threads.values()].find((t) => t.key === `phone:${phoneE164}` && t.id !== platform.id);
    ctx.phone = phoneE164;
    if (existing) {
      existing.messages.push(...platform.messages);
      this.threads.delete(platform.id);
      ctx.threadId = existing.id;
      return existing.id;
    }
    platform.key = `phone:${phoneE164}`;
    return platform.id;
  }
  stitchByPhone = async ({ contextId, phoneE164 }: { contextId: string; phoneE164: string }): Promise<StitchResult> => ({ ok: true, threadId: this.foldInto(contextId, phoneE164), movedContextIds: [] });
  stitchByCode = async ({ code, phoneE164 }: { code: string; phoneE164: string; workspaceId: string }): Promise<StitchResult> => {
    const ctx = [...this.contexts.values()].find((c) => c.code === code);
    if (!ctx) return { ok: false, reason: "unknown_code" };
    const threadId = this.foldInto(ctx.id, phoneE164);
    ctx.state = "moved";
    const thread = this.threads.get(threadId)!;
    thread.row.platformState = { site: ctx.source, state: "moved", movedAt: "2026-11-12T20:00:00Z", stitchCode: code };
    return { ok: true, threadId, movedContextIds: [ctx.id] };
  };
  /** Stand-in for Package A's inbound pipeline: a text to the line quoting a stitch code is stitched; any other text goes to its phone thread. */
  inboundText = async (from: string, body: string) => {
    const token = (body.match(/\b[A-Z0-9]{4,8}\b/g) ?? []).find((t) => [...this.contexts.values()].some((c) => c.code === t));
    if (token) return this.stitchByCode({ code: token, phoneE164: from, workspaceId: WS });
    return null;
  };
}

function harness(over: Partial<{ answer: LeadAnswer; stateOverride: "moved" }> = {}) {
  const spine = new FakeSpine();
  const calls = { relay: [] as Array<{ to: string; text: string }>, stamps: [] as Array<{ threadId: string; patch: Record<string, unknown> }>, notices: [] as string[], unanswered: [] as string[], generated: 0 };
  const seen = new Set<string>();
  const deps: LeadIngestDeps = {
    loadCandidates: async () => CANDIDATES,
    textNumber: async () => ({ e164: "+12066781909", display: "(206) 678-1909" }),
    spine: {
      recordInbound: spine.recordInbound,
      mintStitchCode: spine.mintStitchCode,
      stitchByPhone: spine.stitchByPhone,
      recordOutbound: async (i) => { spine.outbound.push(i.body); },
    },
    contextState: async (id) => spine.contexts.get(id)!.state,
    generateAnswer: async () => { calls.generated += 1; return over.answer ?? { reply: "Thanks Aiko! Room 9 at 4709a 8th Ave NE is a furnished room. Visit https://prop-lane.space/rent/4709a or email host@example.com.", violations: [], approvalHold: false, produced: true }; },
    sendRelay: async ({ to, text }) => { calls.relay.push({ to, text }); return true; },
    stampThread: async (threadId, patch) => { calls.stamps.push({ threadId, patch }); Object.assign(spine.threads.get(threadId)?.row ?? {}, patch.platformDraft ? { platformDraft: patch.platformDraft } : {}); if (patch.platformState && !(spine.threads.get(threadId)?.row.platformState as { state?: string } | undefined)?.state) spine.threads.get(threadId)!.row.platformState = patch.platformState; },
    rateOk: async (key) => { if (seen.has(key) && key.startsWith("platform-lead-msgid")) return false; seen.add(key); return true; },
    storeUnanswered: async (why) => { calls.unanswered.push(why); return { handled: true, replied: false, role: "channel" }; },
    notify: async (text) => { calls.notices.push(text); },
  };
  return { spine, calls, deps };
}

function mail(f: typeof SPAREROOM_INQUIRY, over: Partial<LeadIngestInput> = {}): LeadIngestInput {
  return {
    emailId: `email-${Math.random().toString(36).slice(2)}`,
    messageIdHeader: `<${f.subject}@spareroom>`,
    site: f.expect.site as LeadIngestInput["site"],
    fromEmail: f.fromEmail,
    fromName: f.fromName,
    subject: f.subject,
    rawBody: f.text,
    replyTo: f.replyTo,
    receivedAt: "2026-11-12T18:00:00Z",
    workspaceId: WS,
    ownerUserId: OWNER,
    mailbox: { address: "assistant@work.proplane.test" },
    authenticated: true,
    ...over,
  };
}
const ON = new Set(["spareroom", "roomies"] as const) as never;
const noPhone = { ...SPAREROOM_INQUIRY, text: SPAREROOM_INQUIRY.text.replace(" You can also reach me on (425) 555-0188.", "") };

describe("a SpareRoom inquiry lands in Communication, tagged and notified", () => {
  it("records ONE thread for the exact room, alerts once, and replies by the site's relay with the TEXT line", async () => {
    const h = harness();
    const result = await ingestPlatformLead(h.deps, mail(noPhone), { enabledParsers: ON });
    expect(result).toMatchObject({ handled: true, replied: true, mode: "email_relay" });
    expect(h.spine.threads.size).toBe(1);
    const thread = [...h.spine.threads.values()][0]!;
    expect(thread.row.prospectContext).toMatchObject({ propertyId: "p-4709a", roomId: "r9", roomLabel: "Room 9", source: "spareroom" });
    expect(h.spine.alerts).toHaveLength(1);
    expect(h.calls.relay).toHaveLength(1);
    expect(h.calls.relay[0]!.to).toBe("reply-71ab@spareroom.com");
    const code = [...h.spine.contexts.values()][0]!.code!;
    expect(h.calls.relay[0]!.text).toContain(`Please TEXT (206) 678-1909 and mention ${code}`);
    expect(h.calls.relay[0]!.text).not.toContain("host@example.com");
    expect(h.spine.outbound).toHaveLength(1);
  });

  it("a replayed mail is stored once: no second alert, no second answer", async () => {
    const h = harness();
    const input = mail(noPhone);
    await ingestPlatformLead(h.deps, input, { enabledParsers: ON });
    const again = await ingestPlatformLead(h.deps, { ...input, emailId: "email-replay" }, { enabledParsers: ON });
    expect(again.replied).toBe(false);
    expect(h.calls.unanswered).toEqual(["replayed"]);
    expect(h.spine.alerts).toHaveLength(1);
    expect(h.calls.relay).toHaveLength(1);
    expect(h.calls.generated).toBe(1);
  });

  it("an unauthenticated mail is stored and never answered (no spine write, no model turn)", async () => {
    const h = harness();
    const result = await ingestPlatformLead(h.deps, mail(noPhone, { authenticated: false }), { enabledParsers: ON });
    expect(result.replied).toBe(false);
    expect(h.calls.unanswered).toEqual(["not_authenticated"]);
    expect(h.spine.threads.size).toBe(0);
    expect(h.calls.generated).toBe(0);
  });

  it("a phone number inside the message merges the thread under the phone key at once (still never an account)", async () => {
    const h = harness();
    await ingestPlatformLead(h.deps, mail(SPAREROOM_INQUIRY), { enabledParsers: ON });
    const thread = [...h.spine.threads.values()][0]!;
    expect(thread.key).toBe("phone:+14255550188");
  });
});

describe("manual_copy sites keep a draft instead of sending", () => {
  it("Roomies: nothing leaves PropLane, the draft sits on the thread with the open-link, the manager is told", async () => {
    const h = harness();
    const result = await ingestPlatformLead(h.deps, mail(ROOMIES_INQUIRY, { site: "roomies", messageIdHeader: "<r1>" }), { enabledParsers: ON });
    expect(result).toMatchObject({ replied: false, mode: "manual_copy" });
    expect(h.calls.relay).toHaveLength(0);
    const draft = h.calls.stamps.find((s) => s.patch.platformDraft)!.patch.platformDraft as { body: string; openUrl: string; site: string; replyMode: string };
    expect(draft).toMatchObject({ site: "roomies", replyMode: "manual_copy", openUrl: "https://www.roomies.com/messages/ab12cd34" });
    expect(draft.body).toContain("(206) 678-1909");
    expect(h.calls.notices[0]).toContain("Reply ready to copy");
  });

  it("a money / refund message is held as a draft even on a relay site", async () => {
    const h = harness();
    const refund = { ...noPhone, text: noPhone.text.replace("is this room still available for December?", "I want a refund of my deposit.") };
    const result = await ingestPlatformLead(h.deps, mail(refund, { messageIdHeader: "<m2>" }), { enabledParsers: ON });
    expect(result.replied).toBe(false);
    expect(result.held).toEqual(expect.arrayContaining(["money or a refund"]));
    expect(h.calls.relay).toHaveLength(0);
  });
});

describe("acceptance 7: the stitch code moves the conversation to text", () => {
  it("platform mail -> tagged thread -> inbound text quoting the code -> ONE record, platform thread MOVED, no more platform answers", async () => {
    const h = harness();
    await ingestPlatformLead(h.deps, mail(noPhone, { messageIdHeader: "<a1>" }), { enabledParsers: ON });
    const code = [...h.spine.contexts.values()][0]!.code!;
    expect(h.spine.threads.size).toBe(1);

    // the prospect texts the line, quoting the code
    const stitched = await h.spine.inboundText("+14255550188", `Hi, Aiko here. ${code}`);
    expect(stitched).toMatchObject({ ok: true });
    expect(h.spine.threads.size).toBe(1);
    const thread = [...h.spine.threads.values()][0]!;
    expect(thread.key).toBe("phone:+14255550188");
    expect(thread.row.platformState).toMatchObject({ site: "spareroom", state: "moved", stitchCode: code });
    expect(thread.messages.some((m) => m.channel === "email")).toBe(true);

    // a late mail on the platform is stored and alerts, but is never answered there
    const late = await ingestPlatformLead(h.deps, mail({ ...noPhone, text: noPhone.text.replace("Hi, is this", "Hello again, is this") }, { messageIdHeader: "<a2>" }), { enabledParsers: ON });
    expect(late).toMatchObject({ replied: false, mode: "moved", held: ["They moved to text"] });
    expect(h.calls.relay).toHaveLength(1);
    expect(h.calls.generated).toBe(1);
    expect(h.calls.notices.at(-1)).toContain("They moved to text");
  });
});

describe("moved is set only when the prospect is on the text line", () => {
  it("a fresh inquiry (even one that carries a phone) is ACTIVE and answered on the platform; only the stitching text moves it", async () => {
    const h = harness();
    const result = await ingestPlatformLead(h.deps, mail(SPAREROOM_INQUIRY, { messageIdHeader: "<f1>" }), { enabledParsers: ON });
    expect(result).toMatchObject({ replied: true, mode: "email_relay" });
    const ctx = [...h.spine.contexts.values()][0]!;
    expect(ctx.state).toBe("active");
    const thread = [...h.spine.threads.values()][0]!;
    expect((thread.row.platformState as { state?: string } | undefined)?.state).toBe("active");
    await h.spine.inboundText("+14255550188", `Hi, Aiko here. ${ctx.code}`);
    expect([...h.spine.contexts.values()][0]!.state).toBe("moved");
    expect(([...h.spine.threads.values()][0]!.row.platformState as { state?: string }).state).toBe("moved");
  });

  it("a phone that ALREADY has an SMS thread is moved at once: stored, alerted, never answered on the platform", async () => {
    const h = harness();
    h.deps.spine.stitchByPhone = async ({ contextId, phoneE164 }) => ({ ok: true, threadId: [...h.spine.threads.values()][0]!.id, movedContextIds: [contextId], moved: true, ...(phoneE164 ? {} : {}) });
    const result = await ingestPlatformLead(h.deps, mail(SPAREROOM_INQUIRY, { messageIdHeader: "<f2>" }), { enabledParsers: ON });
    expect(result).toMatchObject({ replied: false, mode: "moved", held: ["They moved to text"] });
    expect(h.calls.relay).toHaveLength(0);
    expect(h.calls.generated).toBe(0);
    expect(h.calls.notices.at(-1)).toContain("They moved to text");
  });
});
