// PropLane Jobs on the PropLane line: "any work?" lists the priced jobs with codes (general area only), a YES takes one,
// and a prospect or an unrelated text is never captured by any of it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";
import { BOARD_FIXTURE, boardService } from "../helpers/vendor-line-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));
const notify = vi.fn(async () => ({ delivered: true, suppressed: false }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: (...a: unknown[]) => (notify as (...x: unknown[]) => unknown)(...a) }));
const submitBid = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/work-order-bids.server", () => ({ submitWorkOrderBid: (...a: unknown[]) => (submitBid as (...x: unknown[]) => unknown)(...a) }));

import { handlePropLaneVendorText } from "@/lib/one-number/vendor-jobs/vendor-line.server";

const OWNER = "svc-owner";
const PHONE = "+12065550142";
const NOW = new Date("2026-10-19T18:00:00Z");
let fake: ReturnType<typeof createFakeDb>;
let sid = 0;

function seed(known: boolean) {
  fake = createFakeDb({
    portal_work_order_records: [
      ...BOARD_FIXTURE,
      boardService("wo-gig", {}, { title: "Tour showing - Room 3", category: "tours", publishCategory: "tours", propertyAddress: "1420 Alder St, Seattle, WA 98115", publishBudgetCents: 4000, preferredArrival: "Saturday 2pm", publishRef: "pub_" + "c".repeat(32) }),
    ],
    work_order_vendor_offers: [],
    work_order_bids: [],
    gig_posts: [{ id: "gig-1", work_order_id: "wo-gig", manager_user_id: "mgr-1", workspace_id: null, kind: "tour_showing", offered_cents: 4000, window_text: "Saturday 2pm", code: "K7Q2", status: "open" }],
    gig_offers: known ? [{ id: "o1", gig_id: "gig-1", vendor_user_id: "vendor-1", status: "sent", sent_at: NOW.toISOString() }] : [],
    vendor_business_profiles: known ? [{ user_id: "vendor-1", trades: ["Tours", "Cleaning"], service_area_zips: ["98115"], service_radius_miles: 25, onboarding_completed_at: "2026-09-01T00:00:00Z", directory_listed: true }] : [],
    profiles: known ? [{ id: "vendor-1", email: "v@x.test", full_name: "Maria Lopez", phone: PHONE, phone_verified_at: "2026-09-01T00:00:00Z" }] : [],
    sms_vendor_leads: [],
    sms_setup_links: [],
    agent_sessions: [],
    agent_messages: [],
    manager_vendor_records: [],
  });
}
const say = (body: string, mode: "service_line" | "shared" = "service_line") =>
  handlePropLaneVendorText(fake as never, { ownerUserId: OWNER, phoneE164: PHONE, body, messageSid: `SM${++sid}`, mode }, { now: () => NOW, origin: "https://proplane.ai" });

beforeEach(() => { sid = 0; notify.mockClear(); submitBid.mockClear(); });

describe("'any work in the area?'", () => {
  it("lists the priced job with its code, the pay and the general area - never the street, unit or resident", async () => {
    seed(false);
    const turn = await say("hey is there any work in the area I can do?");
    expect(turn.handled).toBe(true);
    const reply = turn.reply!;
    expect(reply).toMatch(/K7Q2 - Tour showing/);
    expect(reply).toContain("pays $40");
    expect(reply).toContain("Reply YES and the code");
    expect(reply).not.toMatch(/Alder|1420|Room 3|SECRET|mgr-1|wo-gig/);
    // the same job is not repeated in the numbered list
    expect(reply.match(/Tour/g)!.length).toBe(1);
    // an unknown number is still invited to sign up as a vendor, by one link
    expect(reply).toContain("Create your free vendor account");
  });
});

describe("a YES on the line", () => {
  it("from a known vendor with one open offer files a submitted bid at the offered price and tells the manager", async () => {
    seed(true);
    const turn = await say("YES");
    expect(turn).toMatchObject({ handled: true, vendorUserId: "vendor-1" });
    expect(turn.reply).toContain("$40");
    expect(submitBid).toHaveBeenCalledTimes(1);
    expect((submitBid.mock.calls[0] as unknown[])[2]).toMatchObject({ workOrderId: "wo-gig", amountCents: 4000 });
    expect(notify).toHaveBeenCalledTimes(1);
    // nobody was hired by a text
    expect(fake.tables.portal_work_order_records!.find((r) => r.id === "wo-gig")!.vendor_user_id).toBeNull();
  });

  it("from a stranger with a real code is an invitation to sign up, never an acceptance", async () => {
    seed(false);
    const turn = await say("YES K7Q2");
    expect(turn.handled).toBe(true);
    expect(turn.reply).toContain("free vendor account");
    expect(submitBid).not.toHaveBeenCalled();
    expect(fake.tables.sms_vendor_leads).toEqual([]);
  });
});

describe("nobody else is captured", () => {
  it("a stranger's plain yes, or a prospect looking for a room, falls through untouched (no lead, no offer, no bid)", async () => {
    seed(false);
    expect(await say("yes")).toMatchObject({ handled: false });
    expect(await say("Hi, I'm looking for a room near UW, around $900")).toMatchObject({ handled: false });
    expect(await say("Is the room at 4709A still available?")).toMatchObject({ handled: false });
    expect(fake.tables.sms_vendor_leads).toEqual([]);
    expect(submitBid).not.toHaveBeenCalled();
    expect(fake.tables.gig_offers).toEqual([]);
  });
});
