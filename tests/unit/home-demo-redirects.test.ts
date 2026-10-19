import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { HOME_DEMO_EMBED_PATH } from "@/lib/demo/home-demo-embed";
// The matcher Next itself compiles redirect sources with (it understands the `(?!…)` group the exemption uses).
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";

describe("/demo stays closed except the homepage embed", () => {
  it("redirects every /demo path home but the one embed route", async () => {
    const redirects = await nextConfig.redirects!();
    const demo = redirects.filter((r) => r.source.startsWith("/demo"));
    expect(demo.every((r) => r.destination === "/")).toBe(true);
    const matches = (path: string) => demo.some((r) => pathToRegexp(r.source).test(path));
    expect(matches("/demo")).toBe(true);
    expect(matches("/demo/anything")).toBe(true);
    expect(matches("/demo/home-embed/extra")).toBe(true);
    expect(matches("/demo/home-embed-two")).toBe(true);
    expect(matches(HOME_DEMO_EMBED_PATH)).toBe(false);
  });
});
