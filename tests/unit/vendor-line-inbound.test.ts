// The pipeline's vendor branch on the PropLane line: which lines it engages on, what it sends, and that a vendor is
// never handed to the leasing fallback.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "../helpers/fake-table-db";
import { BOARD_FIXTURE } from "../helpers/vendor-line-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
const m = vi.hoisted(() => ({
  config: { mode: "per_workspace", sharedNumber: null as string | null },
  serviceLine: true,
  serviceOwner: "svc-owner" as string | null,
  sendOk: true,
  consent: "allowed" as "allowed" | "suppressed" | "unavailable",
  sent: [] as Record<string, unknown>[],
  shared: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/one-number/config.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/one-number/config.server")>()),
  loadSharedLineConfig: vi.fn(async () => m.config),
}));
vi.mock("@/lib/service/service-catalog.server", () => ({
  isPropLaneServiceLine: vi.fn(async () => m.serviceLine),
  readPlatformServiceOwnerId: vi.fn(async () => m.serviceOwner),
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: vi.fn(async (args: Record<string, unknown>) => {
    m.sent.push(args);
    return m.sendOk ? { ok: true, outboxId: "ob-1" } : { ok: false, error: "x" };
  }),
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  recordVendorInboundReplyConsent: vi.fn(async () => m.consent),
  VENDOR_CONVERSATION_PURPOSE: "vendor_conversation",
}));
vi.mock("@/lib/one-number/send.server", () => ({
  sendSharedLineMessage: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
    m.shared.push(args);
    return m.sendOk ? { ok: true, messageSid: "SMx", segments: 2 } : { ok: false, reason: "provider_error" };
  }),
}));

import { handlePropLaneLineVendorInbound } from "@/lib/sms/vendor-line-inbound.server";

const LINE = "+12065551909";
const FROM = "+12065550142";
let fake: ReturnType<typeof createFakeDb>;
const project = vi.fn(async (_vendorUserId: string | null) => "t");
const run = (body: string, to = LINE, sid = "SM1") =>
  handlePropLaneLineVendorInbound(fake as never, {
    managerUserId: "svc-owner", workspaceId: "ws-1", fromPhone: FROM, toPhone: to, messageSid: sid, body, projectInbound: project,
  });

beforeEach(() => {
  m.config = { mode: "per_workspace", sharedNumber: null };
  m.serviceLine = true;
  m.serviceOwner = "svc-owner";
  m.sendOk = true;
  m.consent = "allowed";
  m.sent.length = 0;
  m.shared.length = 0;
  project.mockClear();
  fake = createFakeDb({
    portal_work_order_records: BOARD_FIXTURE, work_order_vendor_offers: [], vendor_business_profiles: [], profiles: [],
    sms_vendor_leads: [], sms_setup_links: [], agent_sessions: [], agent_messages: [],
  });
});

describe("per_workspace PropLane line (production today)", () => {
  it("an unknown vendor gets jobs and the sign-up link from the line, is captured and projected, and is never a prospect", async () => {
    const out = await run("hey is there any available jobs in the area to do");
    expect(out).toEqual({ handled: true, sent: true, vendorUserId: null });
    expect(project).toHaveBeenCalledWith(null);
    expect(m.sent).toHaveLength(1);
    const sent = m.sent[0]!;
    expect(sent).toMatchObject({ managerUserId: "svc-owner", to: FROM, fromNumber: LINE, counterpartyRole: "vendor", dedupeKey: "vendor_line_reply_SM1" });
    expect(String(sent.conversationKey)).toContain(":vendor:");
    const text = String(sent.text);
    expect(text).toMatch(/1\. (Plumbing|Cleaning)/);
    expect(text).toContain("/start/");
    expect(text).not.toMatch(/room|rent|tour|apply/i);
    expect(fake.tables.sms_vendor_leads).toHaveLength(1);
  });

  it("sends in the vendor consent purpose, and a vendor who texted STOP gets no reply", async () => {
    await run("any jobs available");
    expect(m.sent[0]).toMatchObject({ purpose: "vendor_conversation", sendClass: "transactional" });
    m.sent.length = 0;
    m.consent = "suppressed";
    expect(await run("any jobs available", LINE, "SM2")).toMatchObject({ handled: true, sent: true });
    expect(m.sent).toHaveLength(0);
  });

  it("a renter's text is not taken: the pipeline continues to the leasing fallback", async () => {
    expect(await run("Is Room 3 available?")).toEqual({ handled: false });
    expect(m.sent).toHaveLength(0);
    expect(project).not.toHaveBeenCalled();
  });

  it("another workspace's own number is untouched", async () => {
    m.serviceLine = false;
    expect(await run("any jobs available", "+12065557777")).toEqual({ handled: false });
    expect(fake.tables.sms_vendor_leads).toHaveLength(0);
  });

  it("a send that fails is reported so the webhook retries, and the retry says the same thing", async () => {
    m.sendOk = false;
    const first = await run("any jobs available", LINE, "SMretry");
    expect(first).toMatchObject({ handled: true, sent: false });
    m.sendOk = true;
    const second = await run("any jobs available", LINE, "SMretry");
    expect(second).toMatchObject({ handled: true, sent: true });
    expect(m.sent[0]!.text).toBe(m.sent[1]!.text);
    expect(fake.tables.sms_setup_links).toHaveLength(1);
  });
});

describe("shared PropLane line", () => {
  beforeEach(() => {
    m.config = { mode: "shared", sharedNumber: LINE };
    m.serviceLine = false;
  });

  it("a placed vendor's jobs ask is answered from the shared number through the shared sender", async () => {
    const out = await run("any jobs available");
    expect(out).toMatchObject({ handled: true, sent: true });
    expect(m.shared).toHaveLength(1);
    expect(m.shared[0]).toMatchObject({ workspaceId: "ws-1", toPhone: FROM, role: "vendor" });
    expect(m.sent).toHaveLength(0);
  });

  it("an ordinary text from a stranger on the shared number is not taken", async () => {
    expect(await run("ok thanks")).toEqual({ handled: false });
  });
});
