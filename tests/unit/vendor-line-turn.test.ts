// The vendor flow on the PropLane line, end to end over an in-memory database: an unknown vendor gets jobs + a sign-up
// link and is captured once; a known vendor gets jobs + the Find work page; the chat is saved and read back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type Row } from "../helpers/fake-table-db";
import { BOARD_FIXTURE } from "../helpers/vendor-line-fixtures";

vi.mock("server-only", () => ({}));
const rl = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: rl.ok })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { handlePropLaneVendorText, SIGNUP_LINK_WINDOW_MS } from "@/lib/one-number/vendor-jobs/vendor-line.server";
import { VENDOR_LINE_COPY } from "@/lib/one-number/vendor-jobs/reply";

const SERVICE_OWNER = "svc-owner";
const PHONE = "+12065550142";
const KEY = "2065550142";
const ORIGIN = "https://proplane.ai";
let sid = 0;
let t = new Date("2026-10-19T18:00:00Z");
let fake: ReturnType<typeof createFakeDb>;

function seed(extra: Record<string, Row[]> = {}) {
  fake = createFakeDb({
    portal_work_order_records: BOARD_FIXTURE,
    work_order_vendor_offers: [],
    vendor_business_profiles: [],
    profiles: [],
    sms_vendor_leads: [],
    sms_setup_links: [],
    agent_sessions: [],
    agent_messages: [],
    manager_vendor_records: [],
    ...extra,
  });
}
const db = () => fake as never;
const say = (body: string, over: { messageSid?: string; mode?: "service_line" | "shared"; force?: boolean } = {}) =>
  handlePropLaneVendorText(
    db(),
    { ownerUserId: SERVICE_OWNER, phoneE164: PHONE, body, messageSid: over.messageSid ?? `SM${++sid}`, mode: over.mode ?? "service_line", force: over.force },
    { now: () => t, origin: ORIGIN },
  );

beforeEach(() => {
  sid = 0;
  rl.ok = true;
  t = new Date("2026-10-19T18:00:00Z");
  seed();
});

describe("an unknown vendor on the PropLane line", () => {
  it("'any available jobs in the area' gets open jobs, the welcome, and ONE sign-up link", async () => {
    const turn = await say("hey is there any available jobs in the area to do");
    expect(turn.handled).toBe(true);
    const reply = turn.reply!;
    expect(reply).toContain("Hi, this is PropLane. Reply STOP to opt out.");
    expect(reply).toContain("Open jobs right now. Text me your neighborhood or zip to narrow them:");
    expect(reply).toMatch(/1\. (Plumbing|Cleaning)/);
    expect(reply).toContain("Create your free vendor account to request jobs: https://proplane.ai/start/");
    expect(reply.match(/https:\/\//g)).toHaveLength(1);
    expect(reply).not.toMatch(/1420 Alder|88 Pike|500 Pine|rent|room/i);
  });

  it("is captured in sms_vendor_leads once (pending), with no roster row written", async () => {
    await say("hey is there any available jobs in the area to do");
    await say("I'm a plumber near Ballard");
    await say("any jobs?");
    const leads = fake.tables.sms_vendor_leads!;
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ phone_key: KEY, status: "pending" });
    expect(leads[0]!.profile).toMatchObject({ source: "propline_line", trade: "plumbing" });
    expect(fake.tables.manager_vendor_records).toEqual([]);
  });

  it("mints the link once per window: later texts point back to it, LINK mints a new one", async () => {
    const first = await say("any jobs available");
    expect(first.reply).toContain("/start/");
    const second = await say("anything in Ravenna");
    expect(second.reply).toContain(VENDOR_LINE_COPY.linkSent);
    expect(second.reply).not.toContain("/start/");
    expect(fake.tables.sms_setup_links).toHaveLength(1);
    const asked = await say("send me the link");
    expect(asked.reply).toContain("/start/");
    expect(fake.tables.sms_setup_links).toHaveLength(2);
    expect(fake.tables.sms_setup_links!.filter((l) => !l.revoked_at)).toHaveLength(1);
  });

  it("mints a new link after the window", async () => {
    await say("any jobs available");
    t = new Date(t.getTime() + SIGNUP_LINK_WINDOW_MS + 60_000);
    const later = await say("any jobs near Ravenna");
    expect(later.reply).toContain("/start/");
  });

  it("is told when links are rate limited, and still gets the jobs", async () => {
    rl.ok = false;
    const turn = await say("any jobs available");
    expect(turn.reply).toContain(VENDOR_LINE_COPY.linkBusy);
    expect(turn.reply).toMatch(/1\. /);
    expect(fake.tables.sms_setup_links).toHaveLength(0);
  });

  it("narrows by the place and trade named, and reads an earlier text on the next one", async () => {
    const first = await say("I'm a cleaner, any work available");
    expect(first.reply).toContain("Open cleaning jobs");
    const second = await say("Ballard");
    expect(second.reply).toContain("near");
    expect(second.reply).toContain("Ballard");
    expect(second.reply).toMatch(/1\. Cleaning/);
    expect(second.reply).not.toMatch(/Plumbing/);
  });

  it("a place with no jobs says so and still offers the sign-up", async () => {
    const turn = await say("any jobs near West Seattle");
    expect(turn.reply).toContain("No open jobs near");
    expect(turn.reply).toContain("/start/");
  });

  it("a place outside the table is named back, no jobs from elsewhere", async () => {
    const turn = await say("any jobs in Tacoma");
    expect(turn.reply).toContain("near Tacoma");
    expect(turn.reply).not.toMatch(/1\. /);
  });

  it("a retried webhook gets the same reply and adds nothing", async () => {
    const a = await say("any jobs available", { messageSid: "SMretry" });
    const linksBefore = fake.tables.sms_setup_links!.length;
    const b = await say("any jobs available", { messageSid: "SMretry" });
    expect(b.reply).toBe(a.reply);
    expect(fake.tables.sms_setup_links).toHaveLength(linksBefore);
    expect(fake.tables.agent_messages).toHaveLength(2);
  });

  it("STOP and HELP are the route's, and a non-vendor text is not taken", async () => {
    expect((await say("STOP")).handled).toBe(false);
    expect((await say("Is Room 3 available?")).handled).toBe(false);
    expect(fake.tables.sms_vendor_leads).toHaveLength(0);
  });

  it("every text from a lead on the line is answered, even a thank-you", async () => {
    await say("any jobs available");
    const turn = await say("ok thanks");
    expect(turn.handled).toBe(true);
    expect(turn.reply).toContain("plumbing in Ballard");
  });
});

describe("a trade word alone on the PropLane line", () => {
  it.each(["I do plumbing", "handyman here", "cleaner"])("%s gets jobs, a sign-up link and a lead, never a silent roster add", async (text) => {
    const turn = await say(text);
    expect(turn.handled).toBe(true);
    // The board has plumbing and cleaning only: a handyman is told there is nothing yet, and still gets the link.
    expect(turn.reply).toMatch(text === "handyman here" ? /No open general maintenance jobs/ : /1\. /);
    expect(turn.reply).toContain("/start/");
    expect(fake.tables.sms_vendor_leads).toHaveLength(1);
    expect(fake.tables.manager_vendor_records).toEqual([]);
  });

  it("the trade narrows the list", async () => {
    const turn = await say("cleaner");
    expect(turn.reply).toContain("Open cleaning jobs");
    expect(turn.reply).not.toContain("Plumbing");
  });

  it("shared mode does not take a bare trade word from a placed sender", async () => {
    expect((await say("cleaner", { mode: "shared" })).handled).toBe(false);
  });
});

describe("what vendors ask about PropLane", () => {
  it("how it works: jobs are offered in Find work; a stranger gets the sign-up link", async () => {
    await say("any jobs available");
    const turn = await say("how does it work?");
    expect(turn.reply).toContain("Property managers publish jobs");
    expect(turn.reply).toContain("Find work");
    expect(turn.reply).not.toMatch(/1\. /);
  });

  it("pay: through the vendor account; a known vendor is sent to Payouts", async () => {
    seed({
      profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: "2026-09-01T00:00:00Z" }],
      vendor_business_profiles: [{ user_id: "vendor-7", trades: ["Plumbing"], service_area_zips: ["98115"] }],
    });
    const turn = await say("how do I get paid?");
    expect(turn.reply).toContain("paid through your PropLane vendor account");
    expect(turn.reply).toContain("https://proplane.ai/vendor/financials/payouts");
    expect(turn.reply).not.toContain("/start/");
  });

  it("coverage: the Seattle area by neighborhood or zip, with the link", async () => {
    await say("any jobs available");
    const turn = await say("what areas do you cover");
    expect(turn.reply).toContain("Seattle area");
    expect(turn.reply).not.toMatch(/1\. /);
  });

  it("a question that also asks for jobs gets the jobs", async () => {
    const turn = await say("how do I get paid, and any jobs near Ballard?");
    expect(turn.reply).toMatch(/1\. Cleaning/);
  });

  it("a stranger's bare question is not taken (it is not a vendor yet)", async () => {
    expect((await say("how does it work?")).handled).toBe(false);
  });
});

describe("a known vendor on the PropLane line", () => {
  beforeEach(() => {
    seed({
      profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: "2026-09-01T00:00:00Z" }],
      vendor_business_profiles: [
        { user_id: "vendor-7", trades: ["Plumbing"], service_area_zips: ["98115"], service_radius_miles: 10, onboarding_completed_at: "2026-09-01", directory_listed: true, license_number: null },
      ],
    });
  });

  it("gets their jobs (saved trade and area) and the Find work page, not a sign-up link", async () => {
    const turn = await say("any jobs available?");
    expect(turn.vendorUserId).toBe("vendor-7");
    expect(turn.reply).toContain("Request jobs in Find work: https://proplane.ai/vendor/work-orders/find-work");
    expect(turn.reply).not.toContain("/start/");
    expect(turn.reply).toContain("Plumbing");
    expect(turn.reply).toContain("Plumbing, Ravenna");
    expect(turn.reply).not.toMatch(/\d{5}/);
    expect(turn.reply).not.toContain("Cleaning");
    expect(fake.tables.sms_vendor_leads).toHaveLength(0);
    expect(fake.tables.sms_setup_links).toHaveLength(0);
  });

  it("any text from them is answered, with the same page", async () => {
    const turn = await say("hello");
    expect(turn.handled).toBe(true);
    expect(turn.reply).toContain("/vendor/work-orders/find-work");
  });

  it("an unverified phone is a stranger", async () => {
    seed({ profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: null }], vendor_business_profiles: [{ user_id: "vendor-7", trades: ["Plumbing"], service_area_zips: ["98115"] }] });
    const turn = await say("any jobs available");
    expect(turn.vendorUserId).toBeNull();
    expect(turn.reply).toContain("/start/");
  });
});

describe("the chat history", () => {
  it("is saved as one agent session per phone, both sides, and read back on the next text", async () => {
    await say("any jobs available");
    await say("Ballard");
    const sessions = fake.tables.agent_sessions!;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ landlord_id: SERVICE_OWNER, kind: "vendor_line_sms", vendor_phone_e164: PHONE });
    const messages = fake.tables.agent_messages!;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[0]!.content).toBe("any jobs available");
    // The second text carried the first's welcome only once.
    expect(String(messages[1]!.content)).toContain("Reply STOP");
    expect(String(messages[3]!.content)).not.toContain("Reply STOP");
  });

  it("without a service owner nothing is saved and the reply still goes", async () => {
    const turn = await handlePropLaneVendorText(db(), { ownerUserId: null, phoneE164: PHONE, body: "any jobs available", messageSid: "SMx", mode: "service_line" }, { now: () => t, origin: ORIGIN });
    expect(turn.handled).toBe(true);
    expect(fake.tables.agent_sessions).toHaveLength(0);
  });
});

describe("shared mode", () => {
  it("only a jobs or link ask from a placed vendor is taken; the caller's force takes the rest", async () => {
    seed({ profiles: [{ id: "vendor-7", phone: PHONE, phone_verified_at: "2026-09-01T00:00:00Z" }], vendor_business_profiles: [{ user_id: "vendor-7", trades: ["Plumbing"], service_area_zips: ["98115"] }] });
    expect((await say("ok thanks", { mode: "shared" })).handled).toBe(false);
    expect((await say("any jobs available", { mode: "shared" })).handled).toBe(true);
    seed();
    const forced = await say("ok", { mode: "shared", force: true });
    expect(forced.handled).toBe(true);
  });
});
