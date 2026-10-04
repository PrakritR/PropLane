import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExportCalendarUrl, sanitizeCalendarOrigin } from "@/lib/channel-calendar/connections.server";

afterEach(() => vi.unstubAllEnvs());

describe("channel calendar export link", () => {
  it("always ends in .ics under /api/calendar/export on the canonical https origin", () => {
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://proplane.ai");
    const url = buildExportCalendarUrl("tok_en-1");
    expect(url).toBe("https://proplane.ai/api/calendar/export/tok_en-1.ics");
    expect(url.endsWith(".ics")).toBe(true);
  });

  it("an encoded origin from the client yields the clean canonical link (Airbnb rejected https%3A%2F%2F...)", () => {
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://proplane.ai");
    const url = buildExportCalendarUrl("tok", "https%3A%2F%2Fproplane.ai");
    expect(url).toBe("https://proplane.ai/api/calendar/export/tok.ics");
    expect(url).not.toContain("%3A");
  });

  it("a foreign origin cannot plant its own host in the link", () => {
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://proplane.ai");
    expect(buildExportCalendarUrl("tok", "https://evil.example")).toBe("https://proplane.ai/api/calendar/export/tok.ics");
    expect(buildExportCalendarUrl("tok", "javascript:alert(1)")).toBe("https://proplane.ai/api/calendar/export/tok.ics");
  });

  it("localhost development keeps its own port", () => {
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://proplane.ai");
    expect(buildExportCalendarUrl("tok", "http://localhost:3001")).toBe("http://localhost:3001/api/calendar/export/tok.ics");
    expect(buildExportCalendarUrl("tok", "http%3A%2F%2Flocalhost%3A3001")).toBe("http://localhost:3001/api/calendar/export/tok.ics");
  });

  it("falls back to the production domain, never a vercel host, when nothing is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://proplane-abc.vercel.app");
    expect(buildExportCalendarUrl("tok", "https://proplane-abc.vercel.app")).toBe("https://proplane.ai/api/calendar/export/tok.ics");
  });

  it("sanitizeCalendarOrigin only passes plain http(s) origins", () => {
    expect(sanitizeCalendarOrigin("https%3A%2F%2Fproplane.ai%2F")).toBe("https://proplane.ai");
    expect(sanitizeCalendarOrigin("ftp://x.test")).toBeNull();
    expect(sanitizeCalendarOrigin("%E0%A4%A")).toBeNull();
    expect(sanitizeCalendarOrigin("")).toBeNull();
    expect(sanitizeCalendarOrigin(undefined)).toBeNull();
  });
});
