// An unknown number's first conversation: role inference, ask once, searchers to the lead qualifier,
// landlords to the DEMO and the finish link, vendors to the intake. Flag safety with the table missing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadFakeDb, LEAD_CONSTRAINTS } from "../helpers/lead-fake-db";

const lead = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ leadId: "lead-1" as string | null, reply: "LEAD: budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(), lookupRecordTestWorkspaceId: vi.fn(async () => null) }));
vi.mock("@/lib/one-number/unassigned-leads.server", () => ({ handleUnassignedLeadInbound: lead }));

import { handleUnknownSenderInbound, ONBOARDING_COPY } from "@/lib/one-number/onboarding/unknown-sender.server";
import { VENDOR_COPY } from "@/lib/one-number/onboarding/vendor-intake";

const PHONE = "2065550142";
const NOW = new Date("2026-10-18T20:00:00Z");
let sid = 0;
const text = (body: string) => ({ fromPhone: "+12065550142", phoneKey: PHONE, body, messageSid: `SM${++sid}`, mediaCount: 0 });
const deps = { now: () => NOW, origin: "https://proplane.ai" };
const run = (db: never, body: string) => handleUnknownSenderInbound(db, text(body), deps);

beforeEach(() => {
  lead.mockClear();
  sid = 0;
});

describe("role inference on the first text", () => {
  it("a searcher goes straight to the lead qualifier", async () => {
    const f = leadFakeDb();
    const turn = await run(f.db, "Is Room 3 available?");
    expect(turn.reply).toBe("LEAD: budget?");
    expect(lead).toHaveBeenCalledTimes(1);
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ phone_key: PHONE, role: "searcher" });
  });

  it("a searcher stays a searcher on later texts without being asked anything", async () => {
    const f = leadFakeDb();
    await run(f.db, "Is Room 3 available?");
    await run(f.db, "900");
    expect(lead).toHaveBeenCalledTimes(2);
  });

  it("a landlord is offered the sample house, with the STOP notice on the first reply only", async () => {
    const f = leadFakeDb();
    const turn = await run(f.db, "I own a 4 bedroom house at 123 Main St");
    expect(turn.reply).toBe(`Hi, this is PropLane. Reply STOP to opt out. ${ONBOARDING_COPY.offerDemo}`);
    expect(lead).not.toHaveBeenCalled();
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ role: "landlord", stage: "offered", hints: { address: "123 Main St", rooms: 4 } });
    const again = await run(f.db, "what does it cost");
    expect(again.reply).toBe(ONBOARDING_COPY.reofferDemo);
    expect(again.reply).not.toContain("STOP");
  });

  it("a vendor starts the intake and is never sent to the lead queue", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    const turn = await run(f.db, "I do cleaning in Seattle");
    expect(lead).not.toHaveBeenCalled();
    expect(turn.reply).toBe(`${VENDOR_COPY.welcome} ${VENDOR_COPY.rates}`);
    expect(f.rows.sms_vendor_leads![0]).toMatchObject({ phone_key: PHONE, status: "collecting" });
    expect(f.rows.sms_unassigned_leads ?? []).toEqual([]);
  });
});

describe("ask once", () => {
  it("asks the role question once with the STOP notice, then takes the answer", async () => {
    const f = leadFakeDb();
    const asked = await run(f.db, "hi");
    expect(asked.reply).toBe(ONBOARDING_COPY.askRole);
    expect(asked.reply).toContain("Reply STOP");
    expect(asked.reply!.length).toBeLessThanOrEqual(160);
    expect(lead).not.toHaveBeenCalled();

    const answered = await run(f.db, "renting one out");
    expect(answered.reply).toBe(ONBOARDING_COPY.offerDemo);
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ role: "landlord" });
  });

  it("never asks twice: a second unclear answer becomes a searcher", async () => {
    const f = leadFakeDb();
    await run(f.db, "hello");
    const second = await run(f.db, "hmm not sure");
    expect(second.reply).toBe("LEAD: budget?");
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ role: "searcher" });
    await run(f.db, "ok");
    expect(f.log.filter((l) => l.table === "sms_onboarding_state" && l.op === "upsert")).toHaveLength(2);
  });

  it("a vendor answer to the question starts the vendor intake", async () => {
    const f = leadFakeDb();
    await run(f.db, "hello");
    const turn = await run(f.db, "vendor");
    expect(turn.reply).toBe(VENDOR_COPY.trade);
  });

  it("a phone with a lead already open is a searcher and is not asked", async () => {
    const f = leadFakeDb({ sms_unassigned_leads: [{ id: "L1", phone_key: PHONE, status: "open", profile: {} }] });
    const turn = await run(f.db, "ok 900 a month");
    expect(turn.reply).toBe("LEAD: budget?");
    expect(lead).toHaveBeenCalledTimes(1);
  });
});

describe("landlord: sample house then finish setup", () => {
  async function landlord() {
    const f = leadFakeDb();
    await run(f.db, "I own a house at 61 Elm Street");
    return f;
  }

  it("DEMO starts the sandbox: several bubbles, and the offer stage moves to the finish link when it ends", async () => {
    const f = await landlord();
    const demo = await run(f.db, "DEMO");
    expect(demo.replies?.length).toBe(4);
    expect(demo.reply).toContain("61 Willow Court");
    expect(f.rows.sms_demo_sessions).toHaveLength(1);
    await run(f.db, "next");
    await run(f.db, "Y");
    await run(f.db, "next");
    const finish = await run(f.db, "skip");
    expect(finish.replies?.[0]).toMatch(/Tap to finish setup: https:\/\/proplane\.ai\/start\//);
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ stage: "finish_sent" });
  });

  it("the hints the landlord typed first ride into the finish link, and their address question is skipped", async () => {
    const f = leadFakeDb();
    await run(f.db, "I own a 3 bedroom house at 61 Elm Street, $700 a room");
    await run(f.db, "DEMO");
    await run(f.db, "next");
    await run(f.db, "y");
    const done = await run(f.db, "next");
    expect(done.replies?.[0]).toContain("Tap to finish setup");
    expect(f.rows.sms_setup_links![0]).toMatchObject({ kind: "landlord", phone_key: PHONE, context: { address: "61 Elm Street", rooms: 3, rent: 700, source: "demo" } });
  });

  it("'yes' to the offer starts the demo", async () => {
    const f = await landlord();
    const turn = await run(f.db, "sure");
    expect(turn.reply).toContain("61 Willow Court");
  });

  it("'no' skips the demo and sends the setup link", async () => {
    const f = await landlord();
    const turn = await run(f.db, "no thanks");
    expect(turn.reply).toMatch(/^No problem\. Set up your own properties here: https:\/\/proplane\.ai\/start\//);
    expect(f.rows.sms_setup_links).toHaveLength(1);
    const later = await run(f.db, "hello?");
    expect(later.reply).toMatch(/^Tap to finish setup: https:\/\/proplane\.ai\/start\//);
    // A newer link replaces the older one.
    expect(f.rows.sms_setup_links!.filter((l) => l.revoked_at == null)).toHaveLength(1);
  });

  it("the homepage prefill puts any phone straight into the demo", async () => {
    const f = leadFakeDb();
    const turn = await run(f.db, "Hi PropLane, show me the demo");
    expect(turn.reply).toContain("61 Willow Court");
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ role: "landlord" });
  });

  it("mid-demo texts stay in the demo, not the lead queue or the vendor intake", async () => {
    const f = leadFakeDb();
    await run(f.db, "DEMO");
    await run(f.db, "I do cleaning in Seattle");
    expect(lead).not.toHaveBeenCalled();
    expect(f.rows.sms_vendor_leads ?? []).toEqual([]);
  });

  it("never writes a real table while demoing", async () => {
    const f = leadFakeDb();
    for (const t of ["DEMO", "next", "y", "next", "5 B Road", "2", "700"]) await run(f.db, t);
    const written = new Set(f.log.filter((l) => l.op !== "select").map((l) => l.table));
    expect([...written].every((t) => ["sms_demo_sessions", "sms_setup_links", "sms_onboarding_state"].includes(t))).toBe(true);
  });
});

describe("vendor intake", () => {
  it("collects trade, area, rates and insurance, then waits for review with a phone-bound profile link", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    await run(f.db, "I'm a plumber");
    const area = await run(f.db, "Seattle and Bellevue");
    expect(area.reply).toBe(VENDOR_COPY.rates);
    const rates = await run(f.db, "$90/hr");
    expect(rates.reply).toBe(VENDOR_COPY.insurance);
    const done = await run(f.db, "yes");
    expect(done.reply).toMatch(/^Thanks, that is everything\. PropLane will review your details and text you\. Finish your profile here: https:\/\/proplane\.ai\/start\//);
    expect(f.rows.sms_vendor_leads![0]).toMatchObject({
      status: "pending",
      profile: { trade: "plumbing", area: "Seattle and Bellevue", rates: "$90/hr", insurance: "yes" },
    });
    expect(f.rows.sms_setup_links![0]).toMatchObject({ kind: "vendor", phone_key: PHONE, context: { vendorLeadId: f.rows.sms_vendor_leads![0]!.id } });
    const after = await run(f.db, "any news?");
    expect(after.reply).toContain("reviewing");
  });

  it("repeats a question with 'Sorry' on a non answer and replays a webhook retry", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    await run(f.db, "I do cleaning in Seattle");
    await run(f.db, "$40/hr");
    const retry = await run(f.db, "what do you mean");
    expect(retry.reply).toBe(`${VENDOR_COPY.retry} ${VENDOR_COPY.insurance}`);
    const sameSid = { ...text("yes"), messageSid: "SM-fixed" };
    const first = await handleUnknownSenderInbound(f.db, sameSid, deps);
    const replay = await handleUnknownSenderInbound(f.db, sameSid, deps);
    expect(replay.reply).toBe(first.reply);
    expect(f.rows.sms_setup_links).toHaveLength(1);
  });

  it("stores no card number", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    await run(f.db, "I do cleaning in Seattle");
    await run(f.db, "my card 4111 1111 1111 1111");
    expect(JSON.stringify(f.rows.sms_vendor_leads)).not.toContain("4111");
  });

  it("every vendor line is one GSM-7 segment", () => {
    for (const line of Object.values(VENDOR_COPY)) {
      expect(line.length).toBeLessThanOrEqual(160);
      expect(line).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});

describe("flag safety", () => {
  it("with the onboarding table missing it is exactly the old lead path", async () => {
    const f = leadFakeDb({}, { broken: ["sms_onboarding_state"] });
    expect((await run(f.db, "hi")).reply).toBe("LEAD: budget?");
    expect((await run(f.db, "I own a house")).reply).toBe("LEAD: budget?");
    expect((await run(f.db, "DEMO")).reply).toBe("LEAD: budget?");
    expect(lead).toHaveBeenCalledTimes(3);
  });
});
