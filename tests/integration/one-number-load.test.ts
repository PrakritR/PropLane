 
// Load: thousands of simulated inbound texts through the real seam, router, session store and burst debounce,
// in the SMS test transport (nothing is ever sent to Twilio). The debounce runs on a port of its SQL that is
// checked against the real function (tests/unit/one-number-debounce-sql-parity.test.ts).
//
//   npm run test:one-number-load                       # 5,000 messages
//   ONE_NUMBER_LOAD_COUNT=20000 npm run test:one-number-load
//   ONE_NUMBER_LOAD_REPORT=/path/report.json ...        # also write the numbers to a file
//
// What it proves, per message and in total:
//   * routing: every text lands on the workspace the oracle says (or is asked about, or is a lead);
//   * no drop: every text that reaches an agent is answered, inside exactly one reply;
//   * no duplicate: a burst of texts gets ONE reply, a Twilio redelivery gets none extra, and the transport
//     never sends the same idempotency key twice (it absorbs the retries);
//   * HUMAN and emergency words: one acknowledgement / one safety text, one alert, per text;
//   * isolation: nothing is ever sent from a workspace the recipient does not belong to.
// It reports p50 / p95 / max handling time (under wave concurrency) and the sequential service time.
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig, SharedLineSend } from "@/lib/one-number/contracts";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import { debounceSqlPort } from "../helpers/debounce-sql-port";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";

const sim = vi.hoisted(() => ({
  seamSends: [] as SharedLineSend[],
  seamKeys: new Map<string, number>(),
  alerts: [] as Array<Record<string, unknown>>,
  alertKeys: new Set<string>(),
}));
vi.mock("@/lib/one-number/send.server", () => ({
  sendSharedLineMessage: vi.fn(async (_db: unknown, send: SharedLineSend) => {
    const key = send.idempotencyKey ?? "";
    sim.seamKeys.set(key, (sim.seamKeys.get(key) ?? 0) + 1);
    if (sim.seamKeys.get(key)! > 1) return { ok: true as const, messageSid: "SMdup", segments: 1 };
    sim.seamSends.push(send);
    return { ok: true as const, messageSid: "SMout", segments: 1 };
  }),
}));
vi.mock("@/lib/one-number/team-alerts.server", () => ({
  alertWorkspaceTeam: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    const key = String(input.idempotencyKey ?? "");
    if (key && sim.alertKeys.has(key)) return { sent: false };
    if (key) sim.alertKeys.add(key);
    sim.alerts.push(input);
    return { sent: true };
  }),
}));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({
  handleUnknownSenderInbound: vi.fn(async () => ({ leadId: "lead", reply: "Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?", assignedWorkspaceId: null })),
}));

import { bubbleDedupeKey, deliverAgentReply } from "@/lib/one-number/bubble-delivery.server";
import { debounceInbound, type DebounceRole } from "@/lib/one-number/debounce.server";
import { handleSharedLineInbound, HUMAN_ACK_REPLY } from "@/lib/one-number/inbound-seam.server";
import { loadThreadPause } from "@/lib/one-number/session.server";

const TOTAL = Math.max(500, Number(process.env.ONE_NUMBER_LOAD_COUNT) || 5000);
const WORKSPACES = 40;
const RESIDENTS_PER_WS = 10;
const WAVE = 64;
const VERIFIED = "2026-10-01T00:00:00.000Z";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };

/* ------------------------------ deterministic world ------------------------------ */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "resident" | "vendor" | "manager" | "two_team_question" | "two_team_resident" | "two_team_vendor" | "stranger_code" | "stranger" | "human" | "emergency";
type Msg = {
  sid: string;
  from: string;
  key: string;
  body: string;
  kind: Kind;
  /** Texts of one burst share a unit; a redelivery repeats the same sid inside the unit. */
  unit: number;
  expectWs: string | null;
  debounceRole: DebounceRole | null;
  duplicateOf?: string;
  /** The person said HUMAN earlier: the assistant is paused for them, so no agent may answer this text. */
  paused?: boolean;
  /** Skip the "[sid]" tag (a keyword text must be the whole body). */
  bare?: boolean;
};

let phoneSeq = 0;
const newPhone = () => {
  phoneSeq += 1;
  const digits = `206555${String(1000 + phoneSeq).padStart(4, "0")}`;
  // profiles.phone is E.164 text (it was numeric on production until 20261027010000), and rows written while it was
  // numeric kept bare digits with no `+`, so a stored value is any of those digit forms, never punctuation.
  return { key: digits, e164: `+1${digits}`, stored: [`+1${digits}`, digits, `1${digits}`][phoneSeq % 3]! };
};

function buildWorld(total: number, seed = 20261018) {
  phoneSeq = 0;
  const rand = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const tables: Record<string, FakeRow[]> = {
    portal_workspaces: [], manager_property_records: [], profiles: [], manager_application_records: [], agent_sessions: [], portal_work_order_records: [], sms_entry_codes: [],
  };
  const ws: Array<{ id: string; owner: string; prop: string; label: string; code: string; ownerPhone: ReturnType<typeof newPhone> }> = [];
  for (let i = 0; i < WORKSPACES; i += 1) {
    const w = { id: `ws-${i}`, owner: `owner-${i}`, prop: `prop-${i}`, label: `${1000 + i} Brooklyn Court`, code: `BRK${i + 100}`, ownerPhone: newPhone() };
    ws.push(w);
    tables.portal_workspaces!.push({ id: w.id, name: `Team ${i}`, owner_user_id: w.owner, is_default: true });
    tables.manager_property_records!.push({ id: w.prop, manager_user_id: w.owner, workspace_id: w.id, row_data: { buildingName: w.label } });
    tables.profiles!.push({ id: w.owner, email: `owner${i}@x.test`, phone: w.ownerPhone.stored, phone_verified_at: VERIFIED });
    tables.sms_entry_codes!.push({ code: w.code, workspace_id: w.id, owner_user_id: w.owner, property_id: w.prop, label: w.label, active: true });
  }
  const people: Array<{ kind: Kind; phone: ReturnType<typeof newPhone>; ws: (typeof ws)[number]; ws2?: (typeof ws)[number] }> = [];
  const addResident = (phone: ReturnType<typeof newPhone>, w: (typeof ws)[number], id: string) => {
    tables.profiles!.push({ id, email: `${id}@x.test`, phone: phone.stored, phone_verified_at: VERIFIED });
    tables.manager_application_records!.push({ id: `app-${id}`, manager_user_id: w.owner, resident_email: `${id}@x.test`, property_id: w.prop, updated_at: VERIFIED, row_data: { bucket: "approved" } });
  };
  const addVendor = (phone: ReturnType<typeof newPhone>, w: (typeof ws)[number], id: string) => {
    tables.agent_sessions!.push({ id: `sess-${id}`, kind: "vendor_work_order", vendor_phone_e164: phone.e164, landlord_id: w.owner, work_order_id: `wo-${id}`, status: "active", updated_at: VERIFIED });
    tables.portal_work_order_records!.push({ id: `wo-${id}`, property_id: w.prop, row_data: {} });
  };
  for (const w of ws) {
    people.push({ kind: "manager", phone: w.ownerPhone, ws: w });
    for (let r = 0; r < RESIDENTS_PER_WS; r += 1) {
      const phone = newPhone();
      const id = `res-${w.id}-${r}`;
      addResident(phone, w, id);
      people.push({ kind: r === 0 ? "human" : r === 1 ? "emergency" : "resident", phone, ws: w });
    }
    const vphone = newPhone();
    addVendor(vphone, w, `ven-${w.id}`);
    people.push({ kind: "vendor", phone: vphone, ws: w });
  }
  // People in two teams: a resident of one and a vendor of another.
  for (let i = 0; i < 24; i += 1) {
    const a = ws[i % WORKSPACES]!;
    const b = ws[(i * 7 + 3) % WORKSPACES]!;
    if (a.id === b.id) continue;
    const phone = newPhone();
    addResident(phone, a, `two-res-${i}`);
    addVendor(phone, b, `two-ven-${i}`);
    people.push({ kind: "two_team_question", phone, ws: a, ws2: b });
  }
  for (let i = 0; i < 150; i += 1) people.push({ kind: i % 5 === 0 ? "stranger_code" : "stranger", phone: newPhone(), ws: pick(ws) });

  // Per-person scripts, then interleave. Each script entry is one unit (a message or a burst).
  const scripts = new Map<number, Msg[][]>();
  let sidSeq = 0;
  const sid = () => `SM${String(++sidSeq).padStart(32, "0")}`;
  let unitSeq = 0;
  const humanPeople = new Set<(typeof people)[number]>();
  const mk = (p: (typeof people)[number], body: string, kind: Kind, expectWs: string | null, role: DebounceRole | null, bare = false): Msg => {
    const id = sid();
    return { sid: id, from: p.phone.e164, key: p.phone.key, body: bare ? body : `${body} [${id}]`, kind, unit: unitSeq, expectWs, debounceRole: role, bare, paused: humanPeople.has(p) && role === "resident" };
  };
  const weights: Record<Kind, number> = { resident: 1, vendor: 1, manager: 1, two_team_question: 0, two_team_resident: 0, two_team_vendor: 0, stranger_code: 1, stranger: 1, human: 1, emergency: 1 };
  void weights;
  let produced = 0;
  const push = (p: (typeof people)[number], unit: Msg[]) => {
    unitSeq += 1;
    for (const m of unit) m.unit = unitSeq;
    const list = scripts.get(people.indexOf(p)) ?? [];
    list.push(unit);
    scripts.set(people.indexOf(p), list);
    produced += unit.length + unit.filter((m) => m.duplicateOf).length * 0;
  };
  const resTexts = ["the heat is not working", "thanks!", "can I get the wifi password", "trash day?", "my key fob stopped working", "ok great"];
  const venTexts = ["on my way to the job", "running 20 min late", "ok thanks", "finished the job"];
  const mgrTexts = ["who hasn't paid this month", "what's vacant", "who's touring tomorrow"];
  const strangerTexts = ["do you have any rooms", "hi", "looking for a room near UW", "what's the rent"];

  // Deterministic order of people to draw from until the budget is spent.
  let guard = 0;
  while (produced < total && guard < total * 20) {
    guard += 1;
    const p = pick(people);
    const base = scripts.get(people.indexOf(p)) ?? [];
    const redeliver = rand() < 0.03;
    const maybeDup = (m: Msg): Msg[] => (redeliver ? [m, { ...m, duplicateOf: m.sid }] : [m]);
    switch (p.kind) {
      case "resident": {
        const burst = rand() < 0.2 ? 2 + Math.floor(rand() * 2) : 1;
        const unit: Msg[] = [];
        for (let b = 0; b < burst; b += 1) unit.push(mk(p, pick(resTexts), "resident", p.ws.id, "resident"));
        const last = unit.length - 1;
        push(p, redeliver ? [...unit, { ...unit[last]!, duplicateOf: unit[last]!.sid }] : unit);
        break;
      }
      case "vendor":
        push(p, maybeDup(mk(p, pick(venTexts), "vendor", p.ws.id, "vendor")));
        break;
      case "manager":
        push(p, maybeDup(mk(p, pick(mgrTexts), "manager", p.ws.id, "manager")));
        break;
      case "stranger_code":
        push(p, maybeDup(mk(p, `is ${p.ws.code} still available`, "stranger_code", p.ws.id, null)));
        break;
      case "stranger":
        push(p, [mk(p, pick(strangerTexts), "stranger", null, null)]);
        break;
      case "human": {
        // A HUMAN text is its own acknowledgement; others around it are ordinary.
        if (base.length === 0 || rand() < 0.15) { push(p, maybeDup(mk(p, "HUMAN", "human", p.ws.id, null, true))); humanPeople.add(p); }
        else push(p, [mk(p, pick(resTexts), "resident", p.ws.id, "resident")]);
        break;
      }
      case "emergency": {
        if (base.length === 0 || rand() < 0.15) push(p, maybeDup(mk(p, "I smell gas in the hallway", "emergency", p.ws.id, "resident")));
        else push(p, [mk(p, pick(resTexts), "resident", p.ws.id, "resident")]);
        break;
      }
      case "two_team_question": {
        // Fixed script, once: an unclear text (asked), then each team by naming its house or its role's words.
        if (base.length === 0) {
          push(p, [mk(p, "ok thanks", "two_team_question", null, null)]);
          push(p, [mk(p, `${p.ws.label} the heat is out`, "two_team_resident", p.ws.id, "resident")]);
          push(p, [mk(p, "the invoice for the job is ready", "two_team_vendor", p.ws2!.id, "vendor")]);
        }
        break;
      }
    }
  }
  return { tables, ws, people, scripts, sidCount: () => sidSeq };
}

/* ------------------------------ the pipeline stand-in ------------------------------ */

type Transport = { byKey: Map<string, { to: string; body: string; workspaceId: string; at: number }>; attempts: Map<string, number> };

async function pipeline(
  db: never,
  rpcDb: ReturnType<typeof debounceSqlPort>,
  transport: Transport,
  tasks: Promise<void>[],
  owned: { managerId: string; workspaceId: string },
  msg: Msg,
  batches: Array<{ winner: string; sids: string[]; workspaceId: string }>,
): Promise<void> {
  if (msg.paused) {
    // The real pipeline skips every agent for a (phone, workspace) the team has taken over.
    expect(await loadThreadPause(db, msg.key, owned.workspaceId)).not.toBeNull();
    return;
  }
  if (!msg.debounceRole) return; // prospects keep their own durable burst queue; nothing to debounce here
  const dbWithRpc = Object.assign(Object.create(db as object), { rpc: rpcDb.rpc, from: rpcDb.from });
  const out = await debounceInbound(dbWithRpc as never, {
    ownerUserId: owned.managerId, role: msg.debounceRole, phone: msg.from, messageSid: msg.sid, body: msg.body, waitMs: 1500,
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  if (!out.proceed) return;
  const sids = [...out.body.matchAll(/\[(SM\d{32})\]/g)].map((m) => m[1]!);
  batches.push({ winner: msg.sid, sids, workspaceId: owned.workspaceId });
  const long = sids.length % 3 === 0;
  const reply = `Got it. We have ${sids.length} message${sids.length === 1 ? "" : "s"} from you.${long ? " Someone from the team will look at the details today and text you back with a time. If anything changes before then, just reply here and we will update it." : ""}`;
  const base = `inbound_reply_${msg.sid}`;
  await deliverAgentReply({
    bubbles: true, text: reply, inboundText: out.body,
    send: async (text, index) => {
      const key = bubbleDedupeKey(base, index)!;
      transport.attempts.set(key, (transport.attempts.get(key) ?? 0) + 1);
      if (!transport.byKey.has(key)) transport.byKey.set(key, { to: msg.from, body: text, workspaceId: owned.workspaceId, at: performance.now() });
      return { ok: true };
    },
    runtime: {
      sleep: async () => undefined, gapMs: () => 0,
      schedule: (task) => { tasks.push(task().catch(() => undefined)); },
    },
  });
  await out.settle();
}

const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

beforeEach(() => {
  sim.seamSends.length = 0; sim.seamKeys.clear(); sim.alerts.length = 0; sim.alertKeys.clear();
});

describe(`${TOTAL} simulated texts through the router and the debounce`, () => {
  it("routes every text correctly, drops none, duplicates none, isolates teams, and reports the timings", { timeout: 300_000 }, async () => {
    const world = buildWorld(TOTAL);
    const { db } = fakeSharedLineDb(world.tables);
    const rpcDb = debounceSqlPort();
    const transport: Transport = { byKey: new Map(), attempts: new Map() };
    const tasks: Promise<void>[] = [];
    const batches: Array<{ winner: string; sids: string[]; workspaceId: string }> = [];
    const latencies: number[] = [];
    const failures: string[] = [];
    const seen = { continued: 0, handled: 0, deliveries: 0 };
    const results = new Map<string, Awaited<ReturnType<typeof handleSharedLineInbound>>>();
    const receipts = new Set<string>();
    let receiptReplays = 0;

    // Interleave the per-person scripts into waves of distinct people, keeping each person's order.
    const queues = [...world.scripts.values()].map((units) => [...units]);
    const waves: Msg[][] = [];
    while (queues.some((qs) => qs.length)) {
      const wave: Msg[] = [];
      let people = 0;
      for (const qs of queues) {
        if (!qs.length || people >= WAVE) continue;
        const unit = qs.shift()!;
        wave.push(...unit);
        people += 1;
      }
      waves.push(wave);
    }
    const delivered = waves.flat();

    async function handle(msg: Msg) {
      const t0 = performance.now();
      const res = await handleSharedLineInbound(db, { config, fromPhone: msg.from, body: msg.body, messageSid: msg.sid, mediaCount: 0, phoneKey: msg.key });
      seen.deliveries += 1;
      if (!msg.duplicateOf) results.set(msg.sid, res);
      if (res.kind === "continue") {
        seen.continued += 1;
        // The webhook claims the receipt (sms_inbound_receipts, unique on MessageSid) before any agent runs; a
        // Twilio redelivery finds it claimed and is acknowledged without a second run.
        if (receipts.has(msg.sid)) {
          receiptReplays += 1;
          latencies.push(performance.now() - t0);
          return;
        }
        receipts.add(msg.sid);
        await pipeline(db, rpcDb, transport, tasks, res.owned, msg, batches);
      } else seen.handled += 1;
      latencies.push(performance.now() - t0);
    }

    const wallStart = performance.now();
    for (const wave of waves) {
      await Promise.all(wave.map(handle));
      await Promise.all(tasks.splice(0));
    }
    const wallMs = performance.now() - wallStart;

    // ---- routing oracle
    const byKind = new Map<Kind, number>();
    for (const msg of delivered.filter((m) => !m.duplicateOf)) {
      byKind.set(msg.kind, (byKind.get(msg.kind) ?? 0) + 1);
      const res = results.get(msg.sid)!;
      switch (msg.kind) {
        case "resident": case "vendor": case "manager": case "stranger_code": case "human": case "emergency": case "two_team_resident": case "two_team_vendor":
          if (res.kind !== "continue" || res.owned.workspaceId !== msg.expectWs) failures.push(`${msg.kind} ${msg.sid} expected ${msg.expectWs} got ${JSON.stringify(res).slice(0, 120)}`);
          break;
        case "two_team_question":
          if (res.kind !== "handled") failures.push(`question ${msg.sid} should be asked, got ${res.kind}`);
          break;
        case "stranger":
          if (res.kind !== "handled" || !res.twiml?.includes("Reply STOP to opt out")) failures.push(`stranger ${msg.sid} should hit the lead queue`);
          break;
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);

    // ---- no drop, no duplicate reply
    const debounced = delivered.filter((m) => m.debounceRole && !m.duplicateOf && !m.paused);
    for (const m of delivered.filter((x) => x.paused)) expect(batches.some((b) => b.sids.includes(m.sid)), `paused text ${m.sid} was answered`).toBe(false);
    const covered = new Map<string, number>();
    const winners = new Map<string, { sids: string[]; workspaceId: string }>();
    for (const b of batches) {
      // The receipt claim means a redelivery never starts a second agent run.
      expect(winners.has(b.winner), `agent ran twice for ${b.winner}`).toBe(false);
      winners.set(b.winner, b);
      for (const s of b.sids) covered.set(s, (covered.get(s) ?? 0) + 1);
    }
    const dropped = debounced.filter((m) => !covered.has(m.sid)).map((m) => m.sid);
    const doubled = [...covered].filter(([, n]) => n > 1).map(([s]) => s);
    expect(dropped.slice(0, 5)).toEqual([]);
    expect(doubled.slice(0, 5)).toEqual([]);
    // One reply per burst: the number of winning invocations equals the number of units that reached an agent.
    const unitsWithAgent = new Set(debounced.map((m) => `${m.from}|${m.unit}`)).size;
    expect(winners.size).toBe(unitsWithAgent);
    // Every burst is answered once, in full: a winner covers exactly its unit's texts.
    const unitSids = new Map<string, string[]>();
    for (const m of debounced) unitSids.set(`${m.from}|${m.unit}`, [...(unitSids.get(`${m.from}|${m.unit}`) ?? []), m.sid]);
    for (const sids of unitSids.values()) {
      const winner = [...winners.values()].find((w) => w.sids.includes(sids[0]!));
      expect(winner?.sids.slice().sort()).toEqual(sids.slice().sort());
    }

    // ---- transport: a key is stored once however many times it was attempted
    const redeliveries = delivered.filter((m) => m.duplicateOf).length;
    const absorbed = [...transport.attempts.values()].reduce((n, c) => n + Math.max(0, c - 1), 0);
    expect(absorbed).toBe(0); // with the receipt claim the transport is never even asked twice
    expect(transport.byKey.size).toBeGreaterThanOrEqual(winners.size);
    for (const key of transport.byKey.keys()) expect(key).toMatch(/^inbound_reply_SM\d{32}(_b[23])?$/);
    for (const [, n] of sim.seamKeys) expect(n).toBeGreaterThan(0);
    const seamDuplicateKeys = new Set(sim.seamSends.map((s) => s.idempotencyKey));
    expect(seamDuplicateKeys.size).toBe(sim.seamSends.length); // the door never sent one key twice

    // ---- HUMAN and emergency: one text each, one alert each
    const humans = delivered.filter((m) => m.kind === "human" && !m.duplicateOf);
    for (const m of humans) {
      expect(sim.seamSends.filter((s) => s.idempotencyKey === `shared-line:human:${m.sid}`)).toHaveLength(1);
      expect(sim.alerts.filter((a) => a.idempotencyKey === `human:${m.sid}:${m.expectWs}`)).toHaveLength(1);
      expect(await loadThreadPause(db, m.key, m.expectWs!)).not.toBeNull();
    }
    expect(sim.seamSends.filter((s) => s.body === HUMAN_ACK_REPLY)).toHaveLength(humans.length);
    const emergencies = delivered.filter((m) => m.kind === "emergency" && !m.duplicateOf);
    for (const m of emergencies) {
      expect(sim.seamSends.filter((s) => s.idempotencyKey === `shared-line:emergency:${m.sid}`)).toHaveLength(1);
      expect(sim.alerts.filter((a) => a.idempotencyKey === `emergency:${m.sid}:${m.expectWs}`)).toHaveLength(1);
    }
    expect(sim.seamSends.filter((s) => s.body === EMERGENCY_SAFETY_REPLY)).toHaveLength(emergencies.length);

    // ---- isolation: every text anyone received came from a workspace they belong to
    const teamsOf = new Map<string, Set<string>>();
    for (const m of delivered) if (m.expectWs) teamsOf.set(m.from, (teamsOf.get(m.from) ?? new Set()).add(m.expectWs));
    for (const person of world.people) if (person.ws2) teamsOf.set(person.phone.e164, new Set([person.ws.id, person.ws2.id]));
    for (const [, out] of transport.byKey) expect(teamsOf.get(out.to)?.has(out.workspaceId), `${out.to} got a text from ${out.workspaceId}`).toBe(true);
    for (const send of sim.seamSends) expect(teamsOf.get(send.toPhone)?.has(send.workspaceId), `${send.toPhone} got a text from ${send.workspaceId}`).toBe(true);
    // The question names houses, never people or other teams' houses.
    for (const send of sim.seamSends.filter((s) => s.idempotencyKey?.startsWith("shared-line:question:"))) {
      expect(send.body).toMatch(/^Is this about .+ or .+\?$/);
      const named = world.ws.filter((w) => send.body.includes(w.label));
      expect(named.length).toBeLessThanOrEqual(2);
    }

    // ---- sequential service time on a fresh world (no concurrency): what one text costs
    const sample = buildWorld(400, 7);
    const sampleDb = fakeSharedLineDb(sample.tables).db;
    const serviceMs: number[] = [];
    const sampleRpc = debounceSqlPort();
    const sampleTransport: Transport = { byKey: new Map(), attempts: new Map() };
    for (const unit of [...sample.scripts.values()].flat().slice(0, 300)) {
      for (const msg of unit.filter((m) => !m.duplicateOf)) {
        const t0 = performance.now();
        const res = await handleSharedLineInbound(sampleDb, { config, fromPhone: msg.from, body: msg.body, messageSid: msg.sid, mediaCount: 0, phoneKey: msg.key });
        if (res.kind === "continue") await pipeline(sampleDb, sampleRpc, sampleTransport, [], res.owned, msg, []);
        serviceMs.push(performance.now() - t0);
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const service = [...serviceMs].sort((a, b) => a - b);
    const report = {
      messages: delivered.length,
      uniqueTexts: delivered.filter((m) => !m.duplicateOf).length,
      redeliveries,
      byKind: Object.fromEntries(byKind),
      continued: seen.continued, handledByRouter: seen.handled,
      agentBatches: winners.size, repliesStored: transport.byKey.size, redeliveriesAnsweredFromReceipt: receiptReplays,
      seamTextsSent: sim.seamSends.length, teamAlerts: sim.alerts.length,
      wallSeconds: Number((wallMs / 1000).toFixed(2)), throughputPerSecond: Math.round(delivered.length / (wallMs / 1000)),
      concurrentWaveMs: { p50: Number(q(sorted, 0.5).toFixed(2)), p95: Number(q(sorted, 0.95).toFixed(2)), max: Number((sorted.at(-1) ?? 0).toFixed(2)), waveSize: WAVE },
      sequentialServiceMs: { p50: Number(q(service, 0.5).toFixed(2)), p95: Number(q(service, 0.95).toFixed(2)), samples: service.length },
      note: "in-memory database: these measure the code path (routing, session, debounce, bubbles), not network or Postgres time",
    };
    console.info(`ONE-NUMBER LOAD REPORT ${JSON.stringify(report)}`);
    if (process.env.ONE_NUMBER_LOAD_REPORT) writeFileSync(process.env.ONE_NUMBER_LOAD_REPORT, `${JSON.stringify(report, null, 2)}\n`);

    expect(delivered.length).toBeGreaterThanOrEqual(TOTAL);
    expect(report.uniqueTexts).toBeGreaterThan(TOTAL * 0.9);
    expect(seen.deliveries).toBe(delivered.length);
    // Generous ceilings: a regression to an accidental O(n^2) fails, machine load does not.
    expect(report.sequentialServiceMs.p95).toBeLessThan(500);
  });
});
