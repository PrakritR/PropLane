// Test server preload only: intercept a bounded set of synthetic Resend messages.
import { createHash } from "node:crypto";
import { openSync, closeSync, fsyncSync, linkSync, mkdirSync, readdirSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
const base = process.env.NEXT_PUBLIC_APP_URL;
const project = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = "re_dummy_auth_browser_no_delivery";
const from = "Auth Proof <proof@example.invalid>";
if (process.env.RESEND_API_KEY !== key || process.env.RESEND_FROM !== from || !captureDir || !path.isAbsolute(captureDir) || !base || !project) throw new Error("Invalid no-delivery test configuration.");
const baseUrl = new URL(base);
if (!new Set(["http://localhost:3007", "http://localhost:3008", "http://localhost:3010"]).has(baseUrl.origin) || project !== "https://emstjswhotsnyksqhqyf.supabase.co") throw new Error("No-delivery harness requires localhost and the DEV project.");
mkdirSync(captureDir, { mode: 0o700, recursive: true });
if (!lstatSync(captureDir).isDirectory() || (lstatSync(captureDir).mode & 0o777) !== 0o700 || readdirSync(captureDir).length) throw new Error("No-delivery capture directory must be fresh and private.");
// Refuse known SMS/Claw network destinations even if a transport is invoked.
const deniedHosts = new Set(["claw-messenger.onrender.com"]);
for (const value of [process.env.CLAW_MESSENGER_HTTP_BASE, process.env.CLAW_MESSENGER_WS_URL]) {
  if (value) { try { deniedHosts.add(new URL(value).hostname.toLowerCase()); } catch { throw new Error("Invalid Claw test configuration."); } }
}
function deniedDestination(input, options) {
  const hosts = [];
  for (const value of [input, options]) {
    if (typeof value === "string" || value instanceof URL) { try { hosts.push(new URL(value).hostname); } catch { /* invalid addresses cannot be sent */ } }
    else if (value && typeof value === "object") hosts.push(String(value.hostname ?? value.host ?? "").split(":")[0]);
  }
  return hosts.some((host) => {
    const name = host.toLowerCase();
    return name === "twilio.com" || name.endsWith(".twilio.com") || name === "resend.com" || name.endsWith(".resend.com") || deniedHosts.has(name);
  });
}
for (const transport of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = transport[method];
    transport[method] = function (input, ...args) {
      if (deniedDestination(input, args[0])) throw new Error("Blocked provider egress in test harness.");
      return original.call(this, input, ...args);
    };
  }
}
syncBuiltinESMExports();
if (globalThis.WebSocket) {
  globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
    construct(target, args, newTarget) {
      if (deniedDestination(args[0])) throw new Error("Blocked provider WebSocket in test harness.");
      return Reflect.construct(target, args, newTarget);
    },
  });
}
// Keep the signup intro from contacting SMS providers, even if Next later
// loads local env files. Empty values are intentional process-only overrides.
for (const key of new Set([...Object.keys(process.env).filter((name) => /^(TWILIO_|CLAW_)/.test(name)), "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_MESSAGING_SERVICE_SID", "CLAW_MESSENGER_API_KEY"])) process.env[key] = "";
const originalFetch = globalThis.fetch.bind(globalThis);
const seen = new Set();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if ((url.hostname !== "resend.com" && !url.hostname.endsWith(".resend.com")) && deniedDestination(url)) throw new Error("Blocked SMS provider egress in test harness.");
  if (url.hostname === "resend.com" || url.hostname.endsWith(".resend.com")) {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.hostname !== "api.resend.com" || url.pathname !== "/emails" || url.search || (init.method ?? (input?.method || "GET")).toUpperCase() !== "POST" || headers.get("authorization") !== `Bearer ${key}` || headers.get("content-type") !== "application/json") throw new Error("Blocked unexpected Resend egress.");
    let body;
    try { body = JSON.parse(String(init.body ?? "")); } catch { throw new Error("Blocked malformed email."); }
    const recipients = Array.isArray(body.to) ? body.to : [body.to];
    const email = recipients[0];
    if (recipients.length !== 1 || typeof email !== "string" || !/^[a-z0-9][a-z0-9._+-]{0,100}@example\.invalid$/i.test(email) || body.from !== from || seen.has(email.toLowerCase()) || seen.size >= 12) throw new Error("Blocked unapproved synthetic recipient.");
    const match = String(body.text ?? "").match(/https?:\/\/[^\s<>"']+\/auth\/confirm\?[^\s<>"']+/i);
    if (!match) throw new Error("Missing verification link.");
    const link = new URL(match[0].replace(/[),.;]+$/, ""));
    if (link.origin !== baseUrl.origin || link.pathname !== "/auth/confirm" || !link.searchParams.get("token_hash") || !["signup", "magiclink"].includes(link.searchParams.get("type"))) throw new Error("Blocked unexpected verification target.");
    const file = path.join(captureDir, `${createHash("sha256").update(email.toLowerCase()).digest("hex")}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ recipient: email.toLowerCase(), href: link.toString() })); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temporary, file); } finally { unlinkSync(temporary); }
    const directoryFd = openSync(captureDir, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    seen.add(email.toLowerCase());
    return new Response(JSON.stringify({ id: "proof-no-delivery" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};
