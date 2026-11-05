// Imported only by the synthetic phone-proof process, including its worker.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
if (process.env.SIGNUP_PROOF_ENABLED !== "1" || process.env.NEXT_PUBLIC_SUPABASE_URL !== "https://emstjswhotsnyksqhqyf.supabase.co" || !["http://localhost:3000", "http://localhost:3007", "http://localhost:3008", "http://localhost:3010"].includes(process.env.NEXT_PUBLIC_APP_URL) || process.env.PLAYWRIGHT_BASE_URL !== process.env.NEXT_PUBLIC_APP_URL) throw new Error("Synthetic phone transport environment refused.");
const hosts = new Set(["claw-messenger.onrender.com"]);
for (const value of [process.env.CLAW_MESSENGER_HTTP_BASE, process.env.CLAW_MESSENGER_WS_URL]) if (value) { try { hosts.add(new URL(value).hostname.toLowerCase()); } catch { throw new Error("Synthetic phone transport configuration refused."); } }
function deny(input, options) {
  const parsed = [];
  for (const item of [input, options]) {
    if (typeof item === "string" || item instanceof URL) { try { parsed.push(new URL(item)); } catch { /* invalid URL */ } }
    else if (item && typeof item === "object") {
      if (typeof item.url === "string") { try { parsed.push(new URL(item.url)); } catch { /* invalid URL */ } }
      if (item.hostname ?? item.host) { try { parsed.push(new URL(`${item.protocol ?? "https:"}//${item.hostname ?? item.host}${item.path ?? item.pathname ?? "/"}`)); } catch { /* invalid URL */ } }
    }
  }
  if (parsed.some(({ hostname }) => { const h = hostname.toLowerCase(); return h === "twilio.com" || h.endsWith(".twilio.com") || h === "resend.com" || h.endsWith(".resend.com") || hosts.has(h); })) return true;
  const paths = parsed.map((url) => url.pathname);
  if (options && typeof options === "object") paths.push(String(options.path ?? options.pathname ?? ""));
  return parsed.some(({ hostname }) => hostname === "emstjswhotsnyksqhqyf.supabase.co") && paths.some((value) => /^\/auth\/v1\/(?:otp|signup|recover|resend)\/?$/.test(value.split("?")[0]));
}
for (const transport of [http, https]) for (const method of ["request", "get"]) {
  const original = transport[method];
  transport[method] = function (input, ...args) { if (deny(input, args[0])) throw new Error("Synthetic phone provider egress refused."); return original.call(this, input, ...args); };
}
syncBuiltinESMExports();
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => { if (deny(input)) throw new Error("Synthetic phone provider egress refused."); return originalFetch(input, init); };
if (globalThis.WebSocket) globalThis.WebSocket = new Proxy(globalThis.WebSocket, { construct(target, args, receiver) { if (deny(args[0])) throw new Error("Synthetic phone provider egress refused."); return Reflect.construct(target, args, receiver); } });
for (const name of Object.keys(process.env)) if (/^(TWILIO_|CLAW_)/.test(name)) process.env[name] = "";
