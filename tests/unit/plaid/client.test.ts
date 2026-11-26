import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransportError, logPlaidFailure, plaidEnabled, plaidFailure, getPlaidClient } from "@/lib/plaid/client.server";
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

describe("logPlaidFailure", () => {
  afterEach(() => vi.restoreAllMocks());

  const printed = () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => [...warn.mock.calls, ...error.mock.calls].map((call) => call.map((a) => inspect(a)).join(" ")).join("\n");
  };
  const inspect = (value: unknown) => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value, Object.getOwnPropertyNames(value ?? {}));
    } catch {
      return String(value);
    }
  };
  const axiosish = (extra: Record<string, unknown>) =>
    Object.assign(new Error("timeout of 20000ms exceeded"), {
      isAxiosError: true,
      code: "ECONNABORTED",
      config: { headers: { "PLAID-CLIENT-ID": "cid", "PLAID-SECRET": "topsecret" } },
      ...extra,
    });

  it("never prints the request config of a transport failure (no Plaid error body)", () => {
    const read = printed();
    logPlaidFailure("[plaid] x failed", axiosish({}));
    const out = read();
    expect(out).not.toContain("topsecret");
    expect(out).toContain("ECONNABORTED");
  });

  it("never prints it for a 5xx whose body is not Plaid JSON either", () => {
    const read = printed();
    logPlaidFailure("[plaid] x failed", axiosish({ response: { status: 502, data: "<html>bad gateway</html>", config: { headers: { "PLAID-SECRET": "topsecret" } } } }));
    expect(read()).not.toContain("topsecret");
  });

  it("prints only the public code for an error Plaid answered with", () => {
    const read = printed();
    logPlaidFailure("[plaid] x failed", axiosish({ response: { status: 400, data: { error_code: "ITEM_LOGIN_REQUIRED" } } }));
    const out = read();
    expect(out).not.toContain("topsecret");
    expect(out).toContain("ITEM_LOGIN_REQUIRED");
  });

  it("still logs a non-transport failure in full, so a Stripe or database error stays debuggable", () => {
    const read = printed();
    logPlaidFailure("[plaid] x failed", Object.assign(new Error("No such customer"), { type: "StripeInvalidRequestError" }));
    expect(read()).toContain("No such customer");
  });

  it("treats anything carrying an HTTP client shape as sensitive", () => {
    expect(isTransportError(axiosish({}))).toBe(true);
    expect(isTransportError({ request: {} })).toBe(true);
    expect(isTransportError(new Error("plain"))).toBe(false);
    expect(isTransportError(null)).toBe(false);
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
