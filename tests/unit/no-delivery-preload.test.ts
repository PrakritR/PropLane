import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("no-delivery signup test harness", () => {
  it("refuses a non-pinned origin before the server starts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auth-proof-bad-origin-"));
    try {
      const result = spawnSync(process.execPath, ["--import", path.resolve("tests/e2e/support/no-delivery-preload.mjs"), "-e", ""], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", NEXT_PUBLIC_APP_URL: "http://localhost:3006", RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>", AUTH_PROOF_CAPTURE_DIR: dir }, encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(readdirSync(dir)).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("captures only bounded unique synthetic recipients without network delivery", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auth-proof-test-"));
    try {
      const script = `
        for (const key of ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_API_KEY_SID','TWILIO_API_KEY_SECRET','CLAW_MESSENGER_API_KEY']) if (process.env[key] !== '') throw Error('SMS credentials not disabled');
        const { default: https } = await import('node:https');
        for (const host of ['https://api.twilio.com/','https://claw.example.test/','https://claw-messenger.onrender.com/']) {
          let denied=false; try { https.request(host); } catch { denied=true } if (!denied) throw Error('SMS provider allowed');
          denied=false; try { await fetch(host); } catch { denied=true } if (!denied) throw Error('SMS fetch allowed');
        }
        let blocked=false; try { https.request('https://localhost/', { hostname: 'api.twilio.com' }); } catch { blocked=true } if (!blocked) throw Error('override allowed');
        blocked=false; try { https.request('https://api.resend.com/emails'); } catch { blocked=true } if (!blocked) throw Error('direct Resend allowed');
        blocked=false; try { new WebSocket('wss://claw-messenger.onrender.com/'); } catch { blocked=true } if (!blocked) throw Error('default Claw websocket allowed');
        const named = await import('node:https'); blocked=false; try { named.request('https://api.twilio.com/'); } catch { blocked=true } if (!blocked) throw Error('named request allowed');
        const send = email => fetch('https://api.resend.com/emails', {method:'POST',headers:{authorization:'Bearer re_dummy_auth_browser_no_delivery','content-type':'application/json'},body:JSON.stringify({from:'Auth Proof <proof@example.invalid>',to:[email],text:'http://localhost:3007/auth/confirm?token_hash=synthetic&type=signup'})});
        for (let i=0;i<12;i++) if (!(await send('synthetic'+i+'@example.invalid')).ok) throw Error('capture failed');
        for (const email of ['synthetic0@example.invalid','overflow@example.invalid','real@example.com']) { let denied=false; try { await send(email); } catch { denied=true } if (!denied) throw Error('recipient accepted'); }
      `;
      const result = spawnSync(process.execPath, ["--import", path.resolve("tests/e2e/support/no-delivery-preload.mjs"), "--input-type=module", "-e", script], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", NEXT_PUBLIC_APP_URL: "http://localhost:3007", RESEND_API_KEY: "re_dummy_auth_browser_no_delivery", RESEND_FROM: "Auth Proof <proof@example.invalid>", AUTH_PROOF_CAPTURE_DIR: dir, TWILIO_ACCOUNT_SID: "real-must-be-cleared", TWILIO_AUTH_TOKEN: "real-must-be-cleared", TWILIO_API_KEY_SID: "real-must-be-cleared", TWILIO_API_KEY_SECRET: "real-must-be-cleared", CLAW_MESSENGER_API_KEY: "real-must-be-cleared", CLAW_MESSENGER_HTTP_BASE: "https://claw.example.test" }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const files = readdirSync(dir);
      expect(files).toHaveLength(12);
      expect(statSync(dir).mode & 0o077).toBe(0);
      for (const file of files) {
        expect(file).toMatch(/^[a-f0-9]{64}\.json$/);
        expect(statSync(path.join(dir, file)).mode & 0o077).toBe(0);
        expect(JSON.parse(readFileSync(path.join(dir, file), "utf8")).recipient).toMatch(/@example\.invalid$/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
