import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { requireCronSecret } from "@/lib/cron-auth.server";

const req = (authorization?: string) =>
  new Request("http://x/api/cron/anything", authorization ? { headers: { authorization } } : undefined);

afterEach(() => vi.unstubAllEnvs());

describe("requireCronSecret", () => {
  it("accepts only the configured bearer when a secret is set", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(requireCronSecret(req("Bearer s3cret"))).toBe(true);
    expect(requireCronSecret(req("Bearer nope"))).toBe(false);
    expect(requireCronSecret(req())).toBe(false);
  });

  it("ignores surrounding whitespace in the configured secret", () => {
    vi.stubEnv("CRON_SECRET", "  s3cret  ");
    expect(requireCronSecret(req("Bearer s3cret"))).toBe(true);
  });

  // The fail-closed rule: a preview deployment is public and holds real
  // service-role credentials, so no secret must never mean "open".
  it("fails closed on every Vercel environment when no secret is set", () => {
    vi.stubEnv("CRON_SECRET", "");
    for (const env of ["production", "preview", "development"]) {
      vi.stubEnv("VERCEL_ENV", env);
      expect(requireCronSecret(req())).toBe(false);
      expect(requireCronSecret(req("Bearer anything"))).toBe(false);
    }
  });

  it("allows a secretless run only off Vercel and outside production", () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(requireCronSecret(req())).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(requireCronSecret(req())).toBe(false);
  });
});

describe("the growth and reminder crons share one gate", () => {
  for (const route of [
    "cron/growth-engage",
    "cron/growth-insights",
    "cron/growth-publish",
    "cron/growth-draft",
    "cron/dispatch-reminders",
  ]) {
    it(route, () => {
      const src = readFileSync(`${process.cwd()}/src/app/api/${route}/route.ts`, "utf8");
      expect(src).toContain('import { requireCronSecret } from "@/lib/cron-auth.server";');
      expect(src).toContain("if (!requireCronSecret(req))");
      // No local copy of the rule in these five to drift out of step with the shared one.
      // Other cron routes are not migrated yet; see the TODO on requireCronSecret.
      expect(src).not.toContain("function isAuthorized");
      expect(src).not.toContain("CRON_SECRET");
    });
  }
});
