import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const preload = path.resolve("tests/e2e/support/signup-phone-no-delivery.mjs");
const env = { ...process.env, SIGNUP_PROOF_ENABLED: "1", NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co", NEXT_PUBLIC_APP_URL: "http://localhost:3000", PLAYWRIGHT_BASE_URL: "http://localhost:3000" };
describe("synthetic phone transport guard", () => {
  it("rejects missing opt-in and non-DEV targets before execution", () => {
    for (const override of [{ SIGNUP_PROOF_ENABLED: "0" }, { NEXT_PUBLIC_SUPABASE_URL: "https://qahnczmilgptcedaqype.supabase.co" }, { PLAYWRIGHT_BASE_URL: "https://example.com" }]) {
      expect(spawnSync(process.execPath, ["--import", preload, "-e", ""], { env: { ...env, ...override }, stdio: "ignore" }).status).not.toBe(0);
    }
  });
  it("blocks provider and remote auth delivery through all supported transports", () => {
    const script = `
      const https = await import('node:https');
      for (const url of ['https://api.twilio.com/', 'https://api.resend.com/emails', 'https://claw-messenger.onrender.com/', ...['otp','signup','recover','resend'].map(x => 'https://emstjswhotsnyksqhqyf.supabase.co/auth/v1/'+x)]) {
        let denied=false; try { https.request(url); } catch { denied=true } if (!denied) throw Error('request allowed');
        denied=false; try { await fetch(new Request(url)); } catch { denied=true } if (!denied) throw Error('fetch allowed');
      }
      let denied=false; try { https.request('https://localhost/auth/v1/otp', {hostname:'emstjswhotsnyksqhqyf.supabase.co'}); } catch { denied=true } if (!denied) throw Error('override allowed');
      denied=false; try { new WebSocket('wss://claw-messenger.onrender.com/'); } catch { denied=true } if (!denied) throw Error('websocket allowed');
    `;
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e", script], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
