/**
 * Core of the end-to-end scenario harness: dev-only guard, the dev server, signed Twilio posts and
 * the captured outbound texts. See e2e-scenarios.mjs for how to run it.
 *
 * Safety, in three layers: (1) resolveTarget refuses anything but the dev Supabase project; (2) the dev
 * server is started with a FAKE Twilio account and SMS_E2E_CAPTURE_FILE set, so a text is written to a
 * file instead of sent (src/lib/sms/e2e-transport.server.ts) and even a missed gate would hit Twilio with
 * credentials that do not exist; (3) every fixture phone is a +1206555 01xx number.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import { resolveTarget } from "../lib/target.mjs";

export const FAKE_AUTH_TOKEN = "e2e-fake-auth-token-not-a-twilio-secret";
export const CRON_SECRET = "e2e-cron-secret-not-real";
export const FAKE_ACCOUNT_SID = "AC" + "e".repeat(32);

export function loadDevEnv() {
  const file = ".env.local";
  if (!existsSync(file)) throw new Error("No .env.local here: run `npm run seed:env` first.");
  const env = { ...process.env, ...parseEnv(readFileSync(file, "utf8")) };
  const resolved = resolveTarget({ target: "dev", env });
  return { env, resolved };
}

export function createDb(resolved) {
  return createClient(resolved.url, resolved.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const hex = (n) => randomBytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
export const uuid = () => crypto.randomUUID();

/** A synthetic Twilio MessageSid the dev-only capture transport recognises (SM + e2e + 29 hex (32 hex after SM)). */
export const newSid = () => "SMe2e" + hex(29);

export class Harness {
  constructor({ env, resolved, port, captureFile }) {
    this.env = env;
    this.resolved = resolved;
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.webhookUrl = `${this.base}/api/twilio/inbound`;
    this.captureFile = captureFile;
    this.server = null;
    this.serverLog = [];
    this.db = createDb(resolved);
  }

  async startServer() {
    writeFileSync(this.captureFile, "");
    const env = {
      ...this.env,
      PORT: String(this.port),
      NODE_ENV: "development",
      SMS_E2E_CAPTURE_FILE: this.captureFile,
      TWILIO_ACCOUNT_SID: FAKE_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: FAKE_AUTH_TOKEN,
      TWILIO_API_KEY_SID: "",
      TWILIO_API_KEY_SECRET: "",
      TWILIO_WEBHOOK_URL: this.webhookUrl,
      TWILIO_STATUS_CALLBACK_URL: "",
      // Prospect texts run as durable bursts (the design: debounce, one reply, SMS tour booking without an email).
      // No queue exists here, so this harness plays the scheduler: it calls the cron route while it waits.
      PROSPECT_SMS_BURSTS_ENABLED: "1",
      CRON_SECRET: CRON_SECRET,
      // A queue that is unreachable on purpose: the app then runs each burst inline behind the same claim
      // (its documented outage path), so no real QStash is ever called and the cron tick finishes anything left.
      QSTASH_URL: "http://127.0.0.1:9",
      QSTASH_TOKEN: "e2e-qstash-token-not-real",
      QSTASH_CURRENT_SIGNING_KEY: "e2e-signing-key-1",
      QSTASH_NEXT_SIGNING_KEY: "e2e-signing-key-2",
      PROSPECT_SMS_BURST_CALLBACK_URL: `${this.base}/api/internal/prospect-sms-burst`,
      PROSPECT_SMS_BURST_CALLBACK_SECRET: "e2e-burst-secret-not-real",
      NEXT_TELEMETRY_DISABLED: "1",
    };
    delete env.VERCEL;
    delete env.VERCEL_ENV;
    this.server = spawn("npx", ["next", "dev", "--webpack", "-p", String(this.port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    const logFile = this.captureFile.replace(/captured-sms\.jsonl$/, "server.log");
    writeFileSync(logFile, "");
    this.logFile = logFile;
    const collect = (chunk) => {
      const text = chunk.toString();
      appendFileSync(logFile, text);
      this.serverLog.push(text);
      if (this.serverLog.length > 4000) this.serverLog.shift();
    };
    this.server.stdout.on("data", collect);
    this.server.stderr.on("data", collect);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (this.server.exitCode !== null) throw new Error(`dev server exited early:\n${this.serverLog.join("").slice(-2000)}`);
      if (this.serverLog.join("").includes("Ready in")) break;
      await sleep(500);
    }
    await this.startMediaServer();
    // Warm the route so the first scenario does not pay the compile inside a webhook timeout.
    await this.post({ from: "+12065550199", body: "hello", to: this.sharedNumber ?? "+12065550100", warm: true }).catch(() => {});
  }

  /** Serves a tiny valid PNG on loopback so an MMS has bytes to download; returns a url builder. */
  async startMediaServer() {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    this.mediaServer = createServer((req, res) => { res.writeHead(200, { "content-type": "image/png", "content-length": png.length }); res.end(png); });
    await new Promise((resolve) => this.mediaServer.listen(this.port + 1, "127.0.0.1", resolve));
    this.mediaUrl = (name) => `http://127.0.0.1:${this.port + 1}/${name}.png`;
  }

  stopServer() {
    this.mediaServer?.close();
    if (!this.server || this.server.exitCode !== null) return;
    this.server.kill("SIGTERM");
    setTimeout(() => this.server?.exitCode === null && this.server.kill("SIGKILL"), 5000).unref();
  }

  /** Captured outbound texts (one JSON line each), optionally only those after index `from`. */
  captured(from = 0) {
    if (!existsSync(this.captureFile)) return [];
    return readFileSync(this.captureFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(from);
  }
  captureMark() {
    return this.captured().length;
  }

  /**
   * POST one Twilio-signed inbound form to the real route. Returns the TwiML replies and the HTTP status.
   * `media`: [{ url, type }] served from this machine.
   */
  async post({ from, to, body, sid = newSid(), media = [], warm = false }) {
    const params = { MessageSid: sid, SmsMessageSid: sid, AccountSid: FAKE_ACCOUNT_SID, From: from, To: to, Body: body, NumMedia: String(media.length), NumSegments: "1" };
    media.forEach((m, i) => {
      params[`MediaUrl${i}`] = m.url;
      params[`MediaContentType${i}`] = m.type ?? "image/jpeg";
    });
    const signature = twilio.getExpectedTwilioSignature(FAKE_AUTH_TOKEN, this.webhookUrl, params);
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(warm ? 240_000 : 90_000),
    });
    const xml = await res.text();
    const messages = [...xml.matchAll(/<Message[^>]*>([\s\S]*?)<\/Message>/g)].map((m) => {
      const inner = m[1];
      const bodyMatch = /<Body>([\s\S]*?)<\/Body>/.exec(inner);
      const mediaMatch = /<Media>([\s\S]*?)<\/Media>/.exec(inner);
      return { body: unescapeXml(bodyMatch ? bodyMatch[1] : inner.replace(/<Media>[\s\S]*?<\/Media>/, "")), media: mediaMatch ? unescapeXml(mediaMatch[1]) : null };
    });
    return { status: res.status, sid, xml, twiml: messages };
  }

  /**
   * Send a text and gather everything the system said back: TwiML bubbles plus captured outbound texts
   * to `from` that appear within the quiet window (agents reply after the webhook returns).
   */
  async text({ from, to, body, media = [], sid = newSid(), quietMs = 7000, maxMs = 120_000 }) {
    const mark = this.captureMark();
    const t0 = Date.now();
    const res = await this.post({ from, to, body, sid, media });
    const postMs = Date.now() - t0;
    const toKey = from.replace(/\D/g, "").slice(-10);
    const mine = () => this.captured(mark).filter((m) => String(m.to).replace(/\D/g, "").slice(-10) === toKey);
    const started = Date.now();
    let lastCount = mine().length;
    let lastChange = Date.now();
    let lastTick = 0;
    while (Date.now() - started < maxMs) {
      await sleep(2500);
      // The burst is not due for ~10 s (reply debounce); the app also runs it inline. The cron tick is only the backstop.
      // Optional scheduler backstop (--tick): the cron routes sweep the WHOLE shared dev database (other lanes' queued bursts
      // and outbox rows too), so they are not called unless asked for.
      if (this.tick && Date.now() - started > 14_000 && Date.now() - lastTick > 6000) { lastTick = Date.now(); await this.cron("prospect-sms-bursts"); await this.cron("sms-outbox"); }
      const count = mine().length;
      if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
      const idle = Date.now() - lastChange;
      const receipt = idle >= quietMs ? await this.receiptStatus(sid) : "processing";
      const bursts = idle >= quietMs ? (await this.burstsPending(from)) + (await this.outboxPending(from)) : 0;
      if ((receipt === "completed" || receipt === null) && idle >= quietMs && bursts === 0) break;
      if (idle >= quietMs * 4 && bursts === 0) break;
    }
    const sent = mine();
    const replies = [...res.twiml.map((m) => m.body), ...sent.map((m) => m.body)].filter(Boolean);
    // First-reply latency: the TwiML reply is the webhook's own answer time; a captured outbound text carries its write time.
    const firstSentAt = sent.length ? Date.parse(sent[0].at) - t0 : null;
    const firstMs = res.twiml.length ? postMs : firstSentAt;
    return { ...res, postMs, firstMs, totalMs: Date.now() - t0, sent, replies, all: replies.join("\n---\n"), media: [...res.twiml.map((m) => m.media), ...sent.flatMap((m) => m.mediaUrls ?? [])].filter(Boolean) };
  }

  /** One scheduler tick: GET a cron route with the harness secret. Returns the parsed body (or null). */
  async cron(path) {
    try {
      const res = await fetch(`${this.base}/api/cron/${path}`, { headers: { authorization: `Bearer ${CRON_SECRET}` }, signal: AbortSignal.timeout(120_000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  }

  /** Prospect bursts for this phone that have not been answered yet (queued or generating). */
  async burstsPending(phone) {
    const { count } = await this.db.from("prospect_sms_bursts").select("id", { count: "exact", head: true }).eq("counterparty_phone_e164", phone).in("status", ["queued", "generating"]);
    return count ?? 0;
  }

  /** Outbound texts to this phone that are still waiting to go (queued, claimed or deferred). */
  async outboxPending(phone) {
    const { count } = await this.db.from("sms_outbox").select("id", { count: "exact", head: true }).eq("recipient_phone", phone).in("status", ["queued", "claimed", "deferred", "submitting"]);
    return count ?? 0;
  }

  async receiptStatus(sid) {
    const { data } = await this.db.from("sms_inbound_receipts").select("status").eq("message_sid", sid).maybeSingle();
    return data?.status ?? null;
  }

  /**
   * A signed-in session for a fixture user, as the cookie @supabase/ssr reads: sb-<ref>-auth-token = "base64-" + base64url(session),
   * chunked at 3180 chars (.0, .1 ...). Sets a known password first (the fixture's own is random). Returns the Cookie header value.
   */
  async cookieFor(user) {
    const password = `E2e-${hex(14)}!a`;
    const up = await this.db.auth.admin.updateUserById(user.id, { password });
    if (up.error) throw new Error(`set password: ${up.error.message}`);
    const anon = (this.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
    const res = await fetch(`${this.resolved.url}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { apikey: anon, "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password }), signal: AbortSignal.timeout(20_000),
    });
    const session = await res.json();
    if (!session.access_token) throw new Error(`sign in ${user.email}: ${JSON.stringify(session).slice(0, 200)}`);
    const value = "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url");
    const name = `sb-${this.resolved.ref}-auth-token`;
    const chunks = value.match(/.{1,3180}/g) ?? [value];
    return chunks.length === 1 ? `${name}=${value}` : chunks.map((c, i) => `${name}.${i}=${c}`).join("; ");
  }

  /** A JSON call to the dev server as a signed-in user (`cookie` from cookieFor). 20 s timeout. */
  async api(path, { method = "GET", body, cookie, headers = {} } = {}) {
    const res = await fetch(`${this.base}${path}`, {
      method, redirect: "manual",
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, location: res.headers.get("location") };
  }

  logMark() { return this.serverLog.join("").length; }
  /** Server log lines written since `mark` that look like a problem (errors, warnings, refusals). */
  logProblemsSince(mark) {
    const text = this.serverLog.join("").slice(mark);
    const lines = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const keep = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (/(error|warn|fail|skipped|refus|denied|unavailable|not (accepted|allowlisted)|\b5\d\d\b in)/i.test(lines[i]) && !/Compiling|middleware|codemod|marks:|twilio inbound timing|ms:|status: 200/i.test(lines[i])) {
        keep.push(lines[i]);
        for (let k = 1; k <= 3 && /^\s{4,}(at |>|\d+ \|)/.test(lines[i + k] ?? ""); k += 1) keep.push(lines[i + k]);
      }
    }
    return keep;
  }

  logTail(n = 40) {
    return this.serverLog.join("").split("\n").slice(-n).join("\n");
  }
}

function unescapeXml(s) {
  return String(s ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&").trim();
}
export { appendFileSync };
