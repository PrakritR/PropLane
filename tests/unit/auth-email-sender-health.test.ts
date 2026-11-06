import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/auth-email-sender-health/route";
const request = (token = "cron-test") => new Request("https://example.test/api/internal/auth-email-sender-health", { headers: { authorization: `Bearer ${token}` } });
const domain = (overrides: Record<string, unknown> = {}) => ({ id: "domain-1", name: "example.test", status: "verified", capabilities: { sending: "enabled" }, ...overrides });
const ok = (data: unknown[], has_more = false) => ({ ok: true, json: async () => ({ data, has_more }) });
beforeEach(() => { vi.stubEnv("CRON_SECRET", "cron-test"); vi.stubEnv("RESEND_API_KEY", "secret-key-test"); vi.stubEnv("RESEND_FROM", "Name <sender@example.test>"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("auth email sender health", () => {
  it("rejects missing or incorrect cron secret before any provider request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await GET(request("wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", ""); expect((await GET(request())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on missing configuration", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); vi.stubEnv("RESEND_FROM", "");
    const response = await GET(request()); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ configured: false, domainVerified: false, available: false, status: "not_configured" });
    vi.stubEnv("RESEND_FROM", "Name <sender@example.test>"); vi.stubEnv("RESEND_API_KEY", "");
    expect((await GET(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("checks the exact sender domain using GET only and never exposes secrets", async () => {
    const fetch = vi.fn().mockResolvedValue(ok([domain({ name: "EXAMPLE.TEST" })])); vi.stubGlobal("fetch", fetch);
    const response = await GET(request()); const text = await response.text();
    expect(JSON.parse(text)).toEqual({ configured: true, domainVerified: true, available: true, status: "verified" });
    expect(text).not.toContain("example.test"); expect(text).not.toContain("secret-key-test"); expect(text).not.toContain("sender@");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0]![0])).toMatch(/^https:\/\/api\.resend\.com\/domains\?/);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
  });
  it.each([domain({ status: "pending" }), domain({ capabilities: { sending: "disabled" } }), domain({ name: "sub.example.test" })])("rejects unverified, disabled or nonexact domains", async (row) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok([row])));
    expect(await (await GET(request())).json()).toEqual({ configured: true, domainVerified: false, available: false, status: "unverified" });
  });
  it("walks bounded pagination to an exact match", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(ok([domain({ id: "cursor", name: "other.test" })], true)).mockResolvedValueOnce(ok([domain()])); vi.stubGlobal("fetch", fetch);
    expect((await (await GET(request())).json()).domainVerified).toBe(true);
    expect(String(fetch.mock.calls[1]![0])).toContain("after=cursor");
  });
  it("fails closed at the pagination bound", async () => {
    const fetch = vi.fn().mockImplementation(async () => ok([domain({ id: `cursor-${fetch.mock.calls.length}`, name: "other.test" })], true));
    vi.stubGlobal("fetch", fetch);
    expect((await GET(request())).status).toBe(503); expect(fetch).toHaveBeenCalledTimes(5);
  });
  it.each(["restricted", "error", "bad response"])("reports %s as unavailable without disclosing provider errors", async (kind) => {
    const fetch = kind === "error" ? vi.fn().mockRejectedValue(new Error("secret-key-test")) : vi.fn().mockResolvedValue(kind === "restricted" ? { ok: false, status: 403 } : { ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal("fetch", fetch); const response = await GET(request()); const text = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(text)).toEqual({ configured: true, domainVerified: false, available: false, status: "unavailable" }); expect(text).not.toContain("secret-key-test");
  });
});
