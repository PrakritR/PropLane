import { describe, expect, it } from "vitest";
import { plaidEnabled, plaidFailure, getPlaidClient } from "@/lib/plaid/client.server";
import { plaidWebhookUrl } from "@/lib/plaid/webhook-url";

const full = { PLAID_CLIENT_ID: "id", PLAID_SECRET: "secret", PLAID_ENV: "sandbox" } as unknown as NodeJS.ProcessEnv;

describe("plaidEnabled", () => {
  it("is true with all keys and a known env", () => {
    expect(plaidEnabled(full)).toBe(true);
    expect(plaidEnabled({ ...full, PLAID_ENV: "production" } as NodeJS.ProcessEnv)).toBe(true);
  });
  it("is false when any key is absent", () => {
    for (const key of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV"] as const) {
      expect(plaidEnabled({ ...full, [key]: "" } as NodeJS.ProcessEnv)).toBe(false);
      expect(plaidEnabled({ ...full, [key]: undefined } as unknown as NodeJS.ProcessEnv)).toBe(false);
    }
  });
  it("is false for an unknown PLAID_ENV", () => {
    expect(plaidEnabled({ ...full, PLAID_ENV: "development" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("refuses to build a client when disabled, without echoing a key", () => {
    expect(() => getPlaidClient({ PLAID_ENV: "sandbox" } as unknown as NodeJS.ProcessEnv)).toThrow("Plaid is not configured.");
  });
});

describe("plaidFailure", () => {
  it("returns only the public error body, never the request config", () => {
    const err = { config: { headers: { "PLAID-SECRET": "topsecret" } }, response: { status: 400, data: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "nope" } } };
    const out = plaidFailure(err);
    expect(out.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(JSON.stringify(out)).not.toContain("topsecret");
  });
  it("maps a network failure to UNREACHABLE", () => {
    expect(plaidFailure(new Error("socket hang up")).code).toBe("UNREACHABLE");
  });
});

describe("plaidWebhookUrl", () => {
  it("prefers an https override", () => {
    expect(plaidWebhookUrl(undefined, { PLAID_WEBHOOK_URL: "https://stg.example.com/api/plaid/webhook" } as unknown as NodeJS.ProcessEnv)).toBe("https://stg.example.com/api/plaid/webhook");
    expect(plaidWebhookUrl(undefined, { PLAID_WEBHOOK_URL: "http://x.test/w" } as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it("is absent outside a production runtime", () => {
    expect(plaidWebhookUrl(undefined, {} as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it("uses the canonical origin on production", () => {
    expect(plaidWebhookUrl(undefined, { VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toMatch(/^https:\/\/.+\/api\/plaid\/webhook$/);
  });
});
