/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles stand in for a PostgREST client and untyped .mjs scripts */
import { describe, expect, it, vi } from "vitest";
import { NOTICE_PURPOSE, assertNumberOnService, classifyWorkspaces, movedNoticeText, run } from "../../scripts/one-number/cutover.mjs";
import { DEV_ENV, N1, N2, O1, O2, PROD_ENV, PROD_REF, WS1, WS1B, WS2, harness, world } from "./one-number-migration-fixtures";

const NUMBER = "+12065550100";
const SID = "MG" + "a".repeat(32);
const NOW = Date.parse("2026-10-19T17:00:00Z"); // 10:00 Pacific
const base = ["--target", "dev", "--mode", "shared", "--shared-number", NUMBER, "--service-sid", SID, "--skip-twilio-check"];

async function cut(db: never, args: string[], deps: Record<string, unknown> = {}) {
  const h = harness();
  const code = await run(args, { env: DEV_ENV, db, log: h.log, report: h.report, now: NOW, ...deps });
  return { code, h };
}
const config = (w: { tables: Record<string, any[]> }) => w.tables.sms_runtime_config[0];

const paid = [{ manager_user_id: O2, tier: "pro", status: "active" }];

describe("cutover: the switch", () => {
  it("a dry run reads, prints who moves, and changes nothing", async () => {
    const w = world({ sms_manager_entitlements: paid });
    const { code, h } = await cut(w.db, base);
    expect(code).toBe(0);
    expect(w.writes).toEqual([]);
    expect(config(w).line_mode).toBe("per_workspace");
    expect(h.text()).toMatch(/2 workspace\(s\) text on the shared line, 1 keep a paid personalized number/);
    expect(h.text()).toMatch(/keeps own: Eighth Ave/);
    expect(h.text()).toMatch(/would set/);
  });

  it("--apply sets exactly the four line columns", async () => {
    const w = world();
    const before = { ...config(w) };
    await cut(w.db, [...base, "--apply"]);
    expect(config(w)).toMatchObject({ line_mode: "shared", shared_number_e164: NUMBER, shared_messaging_service_sid: SID, shared_pilot_workspace_ids: [] });
    expect(Object.keys(config(w)).sort()).toEqual([...Object.keys(before), "updated_at"].sort());
  });

  it("shadow mode needs no number", async () => {
    const w = world();
    const { code } = await cut(w.db, ["--target", "dev", "--mode", "shadow", "--apply"]);
    expect(code).toBe(0);
    expect(config(w)).toMatchObject({ line_mode: "shadow", shared_number_e164: null });
  });

  it("validates the number, the service and the pilot list", async () => {
    const w = world();
    await expect(cut(w.db, ["--target", "dev", "--mode", "shared", "--skip-twilio-check", "--service-sid", SID])).rejects.toThrow(/--shared-number/);
    await expect(cut(w.db, ["--target", "dev", "--mode", "shared", "--shared-number", "12345", "--service-sid", SID, "--skip-twilio-check"])).rejects.toThrow(/valid phone/);
    await expect(cut(w.db, ["--target", "dev", "--mode", "shared", "--shared-number", NUMBER, "--service-sid", "SM123", "--skip-twilio-check"])).rejects.toThrow(/Messaging Service/);
    await expect(cut(w.db, [...base, "--pilot", "not-a-uuid"])).rejects.toThrow(/not a workspace id/);
    await expect(cut(w.db, ["--target", "dev"])).rejects.toThrow(/--mode/);
    await expect(cut(w.db, ["--target", "dev", "--mode", "weird"])).rejects.toThrow(/--mode/);
    expect(w.writes).toEqual([]);
  });

  it("a pilot list is recorded and workspaces outside it are not counted as moving", async () => {
    const w = world();
    const { h } = await cut(w.db, [...base, "--apply", "--pilot", WS1]);
    expect(config(w).shared_pilot_workspace_ids).toEqual([WS1]);
    expect(h.text()).toMatch(/1 workspace\(s\) text on the shared line, 0 keep.*2 are outside the pilot/);
  });

  it("will not skip the Twilio check on staging or production", async () => {
    const w = world();
    await expect(cut(w.db, ["--target", "production", "--confirm-ref", PROD_REF, "--mode", "shared", "--shared-number", NUMBER, "--service-sid", SID, "--skip-twilio-check"], { env: PROD_ENV })).rejects.toThrow(/only allowed on --target dev/);
  });

  it("a production apply needs every guard", async () => {
    const w = world();
    const args = ["--target", "production", "--mode", "shared", "--shared-number", NUMBER, "--service-sid", SID, "--apply"];
    await expect(cut(w.db, args, { env: PROD_ENV })).rejects.toThrow(/confirm-ref/);
    await expect(cut(w.db, [...args, "--confirm-ref", PROD_REF], { env: PROD_ENV })).rejects.toThrow(/reason/);
    await expect(cut(w.db, [...args, "--confirm-ref", PROD_REF, "--reason", "switch everyone"], { env: PROD_ENV })).rejects.toThrow(/--backup/);
    await expect(cut(w.db, ["--target", "production", "--rollback", "--apply", "--confirm-ref", PROD_REF, "--reason", "emergency rollback"], { env: PROD_ENV })).rejects.toThrow(/--backup/);
    expect(w.writes).toEqual([]);
  });
});

describe("cutover: the read-only Twilio check", () => {
  const env = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok" };
  const page = (numbers: string[], next: string | null = null) => ({ ok: true, status: 200, json: async () => ({ phone_numbers: numbers.map((phone_number) => ({ phone_number })), meta: { next_page_url: next } }) });

  it("passes when the number is attached, using GET only and basic auth", async () => {
    const fetchImpl = vi.fn(async () => page(["+12065550100"]));
    await expect(assertNumberOnService({ number: NUMBER, sid: SID, env, fetchImpl })).resolves.toBe(true);
    const [url, init] = (fetchImpl.mock.calls as any[])[0];
    expect(url).toBe(`https://messaging.twilio.com/v1/Services/${SID}/PhoneNumbers?PageSize=100`);
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
  });

  it("follows pages, and prefers an API key when one is configured", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(["+12065550999"], "https://messaging.twilio.com/page2"))
      .mockResolvedValueOnce(page(["(206) 555-0100"]));
    await expect(assertNumberOnService({ number: NUMBER, sid: SID, env: { ...env, TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "sec" }, fetchImpl })).resolves.toBe(true);
    expect((fetchImpl.mock.calls as any[])[0][1].headers.Authorization).toBe(`Basic ${Buffer.from("SK1:sec").toString("base64")}`);
  });

  it("refuses when the number is not on the service, when Twilio errors, or when there are no credentials", async () => {
    await expect(assertNumberOnService({ number: NUMBER, sid: SID, env, fetchImpl: async () => page(["+12065550999"]) as never })).rejects.toThrow(/not attached/);
    await expect(assertNumberOnService({ number: NUMBER, sid: SID, env, fetchImpl: async () => ({ ok: false, status: 401 }) as never })).rejects.toThrow(/HTTP 401/);
    await expect(assertNumberOnService({ number: NUMBER, sid: SID, env: {}, fetchImpl: async () => page([]) as never })).rejects.toThrow(/credentials/);
  });

  it("a failed check stops the run before any write", async () => {
    const w = world();
    await expect(cut(w.db, ["--target", "dev", "--mode", "shared", "--shared-number", NUMBER, "--service-sid", SID, "--apply"], { env: { ...DEV_ENV, ...env }, fetch: async () => page([]) })).rejects.toThrow(/not attached/);
    expect(w.writes).toEqual([]);
    expect(config(w).line_mode).toBe("per_workspace");
  });
});

describe("cutover: rollback", () => {
  it("flips back to per_workspace, keeps the number recorded, and cancels unsent notices only", async () => {
    const w = world({
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: NUMBER, shared_messaging_service_sid: SID, shared_pilot_workspace_ids: [] }],
      sms_outbox: [
        { id: "n1", manager_user_id: O1, purpose: NOTICE_PURPOSE, status: "queued" },
        { id: "n2", manager_user_id: O1, purpose: NOTICE_PURPOSE, status: "deferred" },
        { id: "n3", manager_user_id: O1, purpose: NOTICE_PURPOSE, status: "sent" },
        { id: "x1", manager_user_id: O1, purpose: "rent_reminder", status: "queued" },
      ],
    });
    const dry = await cut(w.db, ["--target", "dev", "--rollback"]);
    expect(dry.h.text()).toMatch(/2 unsent move notice/);
    expect(w.writes).toEqual([]);
    await cut(w.db, ["--target", "dev", "--rollback", "--apply"]);
    expect(config(w)).toMatchObject({ line_mode: "per_workspace", shared_number_e164: NUMBER });
    const status = Object.fromEntries((w.tables.sms_outbox as any[]).map((r) => [r.id, r.status]));
    expect(status).toEqual({ n1: "canceled", n2: "canceled", n3: "sent", x1: "queued" });
  });

  it("stands alone", async () => {
    await expect(cut(world().db, ["--target", "dev", "--rollback", "--mode", "shadow"])).rejects.toThrow(/stands alone/);
  });
});

describe("cutover: classifyWorkspaces", () => {
  const workspaces = [
    { id: "a", owner_user_id: "o1", name: "A" },
    { id: "b", owner_user_id: "o2", name: "B" },
    { id: "c", owner_user_id: "o3", name: "C" },
  ];
  const numbers = [
    { id: "n1", workspace_id: "a", phone_number: "+1", provision_state: "active", released_at: null },
    { id: "n2", workspace_id: "b", phone_number: "+2", provision_state: "active", released_at: null },
    { id: "n3", workspace_id: "c", phone_number: "+3", provision_state: "released", released_at: "2026-01-01" },
  ];
  it("keeps a workspace on its own number only with a live number AND a paid plan", () => {
    const out = classifyWorkspaces({ workspaces, numbers, entitlements: [{ manager_user_id: "o1", tier: "pro", status: "active" }, { manager_user_id: "o2", tier: "free", status: "active" }], pilot: [] });
    expect(out.keepsOwn.map((k: any) => k.ws.id)).toEqual(["a"]);
    expect(out.shared.map((s: any) => s.ws.id)).toEqual(["b", "c"]);
    expect(out.shared[0].oldNumbers).toHaveLength(1);
    expect(out.shared[1].oldNumbers).toHaveLength(0);
  });
  it("a trial or canceled plan is not paid", () => {
    const out = classifyWorkspaces({ workspaces, numbers, entitlements: [{ manager_user_id: "o1", tier: "pro", status: "trialing" }, { manager_user_id: "o2", tier: "business", status: "canceled" }], pilot: [] });
    expect(out.keepsOwn).toEqual([]);
  });
});

describe("cutover --notify-moved", () => {
  const convWs = (id: string, owner: string, line: string, phone: string, role = "resident", extra: Record<string, unknown> = {}) => ({
    id, owner_manager_user_id: owner, counterparty_role: role, work_line_id: line, counterparty_phone: phone, conversation_key: `key-${id}`,
    legacy_conversation_key: null, merged_into_id: null, line_kind: "work_number", last_event_at: "2026-10-10T00:00:00Z", ...extra,
  });
  const extra = () => ({
    sms_projection_conversations: [
      convWs("c-a", O1, N1, "+12065550142"),
      convWs("c-b", O1, N1, "+12065550143", "prospect"),
      convWs("c-opt", O1, N1, "+12065550144"),
      convWs("c-mgr", O1, N1, "+12065550145", "manager"),
      convWs("c-old", O1, N1, "+12065550146", "resident", { last_event_at: "2024-01-01T00:00:00Z" }),
      convWs("c-merged", O1, N1, "+12065550147", "resident", { merged_into_id: "c-a" }),
      convWs("c-paid", O2, N2, "+12065550999"),
    ],
    sms_consent: [{ phone: "2065550144", opted_in_at: null, opted_out_at: "2026-09-01T00:00:00Z" }],
    sms_manager_entitlements: paid,
  });

  it("a dry run counts and writes nothing", async () => {
    const w = world(extra());
    const { h } = await cut(w.db, [...base, "--notify-moved", "--since-days", "365"]);
    expect(w.writes).toEqual([]);
    expect(h.report.notify).toMatchObject({ recipients: 2, skippedOptOut: 1, skippedStale: 1 });
    expect(h.text()).toContain(`"We've moved to (206) 555-0100. Save this number."`);
  });

  it("queues one daytime outbox row per contact, from the OLD number, never to an opted-out phone, a manager or a paid workspace", async () => {
    const w = world(extra());
    await cut(w.db, [...base, "--apply", "--notify-moved", "--since-days", "365"]);
    const rows = (w.tables.sms_outbox as any[]).filter((r) => r.purpose === NOTICE_PURPOSE);
    expect(rows.map((r) => r.recipient_phone).sort()).toEqual(["+12065550142", "+12065550143"]);
    for (const r of rows) {
      expect(r).toMatchObject({
        body: "We've moved to (206) 555-0100. Save this number.", send_class: "transactional", status: "queued",
        selected_work_line_id: N1, workspace_id: WS1B, manager_user_id: O1, segment_count: 1,
      });
      expect(r.dedupe_key).toBe(`number-moved:${WS1B}:${r.recipient_phone.slice(2)}`);
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: false }).format(new Date(r.available_at)));
      expect(hour).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(20);
    }
    expect(new Date(rows[1].available_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[0].available_at).getTime());
  });

  it("is idempotent: a second run queues nothing new", async () => {
    const w = world(extra());
    await cut(w.db, [...base, "--apply", "--notify-moved"]);
    const first = (w.tables.sms_outbox as any[]).length;
    const again = await cut(w.db, [...base, "--apply", "--notify-moved"]);
    expect((w.tables.sms_outbox as any[]).length).toBe(first);
    expect(again.h.report.notify.queued).toBe(0);
  });

  it("only with --mode shared", async () => {
    await expect(cut(world().db, ["--target", "dev", "--mode", "shadow", "--notify-moved"])).rejects.toThrow(/only makes sense with --mode shared/);
  });

  it("never queues to a phone with a scoped revoke for that manager", async () => {
    const w = world({
      ...extra(),
      sms_consent_events: [{ id: "e", recipient_phone_key: "2065550142", manager_user_id: O1, purpose: "p", send_class: "automated", conversation_key: null, event_type: "revoked", occurred_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }],
    });
    const { h } = await cut(w.db, [...base, "--notify-moved"]);
    expect(h.report.notify.recipients).toBe(2); // +0143 and the stale one (no --since-days)
    expect(h.report.notify.skippedOptOut).toBe(2);
  });

  it("text is one GSM-7 segment", () => {
    const text = movedNoticeText(NUMBER);
    expect(text.length).toBeLessThanOrEqual(160);
    expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
    expect(text).not.toMatch(/[‘’“”–—]/);
    expect(WS2).toBeTruthy();
  });
});
