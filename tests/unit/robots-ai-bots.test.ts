import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "proplane.ai" }) }));

describe("robots.txt for AI crawlers", () => {
  it("names every AI crawler, keeps the private disallows, and lists the sitemap", async () => {
    const robots = (await import("@/app/robots")).default;
    const body = await robots();
    const rules = Array.isArray(body.rules) ? body.rules : [body.rules];
    const agents = rules.flatMap((r) => (Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent]));
    for (const bot of ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "anthropic-ai", "PerplexityBot", "Google-Extended"]) {
      expect(agents).toContain(bot);
    }
    for (const r of rules) {
      expect(r.allow).toBe("/");
      for (const path of ["/portal/", "/resident/", "/vendor/", "/admin/", "/api/", "/auth/", "/invite/", "/mcp/"]) {
        expect(r.disallow).toContain(path);
      }
    }
    expect(body.sitemap).toBe("https://proplane.ai/sitemap.xml");
  });
});
