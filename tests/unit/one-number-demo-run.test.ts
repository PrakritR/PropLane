// runDemoTurn over a fake database: both channels, sandbox-only writes, the finish link, idle expiry, restart.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadFakeDb } from "../helpers/lead-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(), lookupRecordTestWorkspaceId: vi.fn(async () => null) }));

import { runDemoTurn } from "@/lib/one-number/demo";
import { endDemoForPhone, hasLiveDemo } from "@/lib/one-number/demo/store.server";
import { resolveSetupLink } from "@/lib/one-number/onboarding/setup-links.server";

const PHONE = "2065550142";
const WEB = "web_session_abcdef123456";
const ORIGIN = "https://proplane.ai";
let clock = new Date("2026-10-18T20:00:00Z");
const deps = () => ({ now: () => clock });

/** Tables the demo is allowed to touch. Anything else is a real row. */
const SANDBOX_TABLES = new Set(["sms_demo_sessions", "sms_setup_links", "sms_onboarding_state"]);

async function say(db: never, channel: "sms" | "web", key: string, text: string) {
  const r = await runDemoTurn(db, { channel, sessionKey: key, text, origin: ORIGIN }, deps());
  if (!r.ok) throw new Error(`demo failed: ${r.reason}`);
  return r;
}

beforeEach(() => {
  clock = new Date("2026-10-18T20:00:00Z");
});

describe("runDemoTurn", () => {
  it("rejects a malformed session key before touching the database", async () => {
    const f = leadFakeDb();
    expect(await runDemoTurn(f.db, { channel: "web", sessionKey: "short", text: "" })).toEqual({ ok: false, reason: "invalid_session" });
    expect(await runDemoTurn(f.db, { channel: "sms", sessionKey: "+12065550142", text: "DEMO" })).toEqual({ ok: false, reason: "invalid_session" });
    expect(await runDemoTurn(f.db, { channel: "web", sessionKey: "bad key with spaces!!", text: "" })).toEqual({ ok: false, reason: "invalid_session" });
    expect(f.log).toEqual([]);
  });

  it("web: an empty first turn starts the demo; an empty later turn repeats the prompt", async () => {
    const f = leadFakeDb();
    const first = await say(f.db, "web", WEB, "");
    expect(first.step).toBe("applicant");
    expect(first.bubbles.some((b) => b.kind === "sample")).toBe(true);
    expect(first.suggestions).toEqual(["NEXT"]);
    const again = await say(f.db, "web", WEB, "");
    expect(again.step).toBe("applicant");
    expect(again.bubbles).toHaveLength(1);
    expect(f.rows.sms_demo_sessions).toHaveLength(1);
    expect(f.rows.sms_demo_sessions[0]).toMatchObject({ channel: "web", session_key: WEB, phone_key: null });
  });

  it("sms: the full demo end to end, ending on a phone-bound finish link built from the answers", async () => {
    const f = leadFakeDb();
    const start = await say(f.db, "sms", PHONE, "DEMO");
    expect(start.messages[0]).toContain("61 Willow Court");
    expect(start.messages.some((m) => m.startsWith("Sample text to you: Tour booked"))).toBe(true);
    expect((await say(f.db, "sms", PHONE, "next")).step).toBe("leak");
    const approved = await say(f.db, "sms", PHONE, "Y");
    expect(approved.step).toBe("rent");
    expect(approved.messages[0]).toContain("Approved");
    expect((await say(f.db, "sms", PHONE, "next")).step).toBe("ask_address");
    await say(f.db, "sms", PHONE, "88 Pine Street");
    await say(f.db, "sms", PHONE, "5");
    const done = await say(f.db, "sms", PHONE, "$900");
    expect(done.finished).toBe(true);
    expect(done.finishUrl).toMatch(/^https:\/\/proplane\.ai\/start\/[A-Za-z0-9_-]{43}$/);
    expect(done.messages[0]).toBe(`Want this for your real properties? Tap to finish setup: ${done.finishUrl}`);
    expect(done.messages[0].length).toBeLessThanOrEqual(160);

    const link = await resolveSetupLink(f.db, done.finishUrl!.split("/start/")[1]!, clock);
    expect(link).toMatchObject({ kind: "landlord", phoneKey: PHONE, context: { address: "88 Pine Street", rooms: 5, rent: 900, source: "demo" } });
    // The session is closed once finished, so a later text is not captured by the demo.
    expect(await hasLiveDemo(f.db, PHONE, clock)).toBe(false);
  });

  it("writes only sandbox tables: never a property, resident, charge, lease, message or alert", async () => {
    const f = leadFakeDb();
    for (const t of ["DEMO", "next", "Y", "next", "1 A Street", "3", "800"]) await say(f.db, "sms", PHONE, t);
    const written = new Set(f.log.filter((l) => l.op !== "select").map((l) => l.table));
    expect([...written].filter((t) => !SANDBOX_TABLES.has(t))).toEqual([]);
    expect([...written].sort()).toEqual(["sms_demo_sessions", "sms_setup_links"]);
    const touched = new Set(f.log.map((l) => l.table));
    for (const real of ["manager_property_records", "portal_workspaces", "manager_sms_messages", "sms_outbox", "manager_application_records", "portal_household_charge_records"]) {
      expect(touched.has(real)).toBe(false);
    }
  });

  it("restarts from the top on DEMO mid-demo", async () => {
    const f = leadFakeDb();
    await say(f.db, "sms", PHONE, "DEMO");
    await say(f.db, "sms", PHONE, "next");
    const restart = await say(f.db, "sms", PHONE, "demo");
    expect(restart.step).toBe("applicant");
    expect(f.rows.sms_demo_sessions!.filter((r) => r.finished_at == null)).toHaveLength(1);
    expect(f.rows.sms_demo_sessions).toHaveLength(2);
  });

  it("exit ends it; STOP's endDemoForPhone ends it from outside", async () => {
    const f = leadFakeDb();
    await say(f.db, "sms", PHONE, "DEMO");
    const ended = await say(f.db, "sms", PHONE, "exit");
    expect(ended.ended).toBe(true);
    expect(await hasLiveDemo(f.db, PHONE, clock)).toBe(false);

    await say(f.db, "sms", PHONE, "DEMO");
    expect(await hasLiveDemo(f.db, PHONE, clock)).toBe(true);
    await endDemoForPhone(f.db, PHONE, clock);
    expect(await hasLiveDemo(f.db, PHONE, clock)).toBe(false);
    expect(f.rows.sms_demo_sessions!.at(-1)).toMatchObject({ step: "ended" });
  });

  it("an idle demo is over: the next text starts fresh", async () => {
    const f = leadFakeDb();
    await say(f.db, "sms", PHONE, "DEMO");
    await say(f.db, "sms", PHONE, "next");
    f.rows.sms_demo_sessions![0]!.updated_at = new Date(clock.getTime()).toISOString();
    clock = new Date(clock.getTime() + 3 * 60 * 60 * 1000);
    expect(await hasLiveDemo(f.db, PHONE, clock)).toBe(false);
    const fresh = await say(f.db, "sms", PHONE, "hello");
    expect(fresh.step).toBe("applicant");
  });

  it("web finish mints an open link with no phone", async () => {
    const f = leadFakeDb();
    await say(f.db, "web", WEB, "");
    for (const t of ["next", "y", "next", "skip"]) await say(f.db, "web", WEB, t);
    const link = f.rows.sms_setup_links![0]!;
    expect(link.phone_key).toBeNull();
    expect(link.kind).toBe("landlord");
  });

  it("is unavailable, not a crash, when the demo table is missing", async () => {
    const f = leadFakeDb({}, { broken: ["sms_demo_sessions"] });
    expect(await runDemoTurn(f.db, { channel: "web", sessionKey: WEB, text: "" }, deps())).toEqual({ ok: false, reason: "unavailable" });
  });
});
