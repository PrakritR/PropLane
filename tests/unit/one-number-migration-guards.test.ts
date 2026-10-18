import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeE164 as tsNormalizeE164 } from "@/lib/phone-e164";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { parseArgs, UsageError } from "../../scripts/one-number/lib/args.mjs";
import { formatDisplay, normalizeE164, phoneKey } from "../../scripts/one-number/lib/phones.mjs";
import {
  GuardError,
  TARGET_REFS,
  assertGuards,
  refFromUrl,
  resolveTarget,
  validateBackup,
} from "../../scripts/one-number/lib/target.mjs";

const DEV_URL = `https://${TARGET_REFS.dev}.supabase.co`;
const PROD_URL = `https://${TARGET_REFS.production}.supabase.co`;
const STAGING_URL = `https://${TARGET_REFS.staging}.supabase.co`;
const env = (url: string) => ({ NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "k" });

const NOW = Date.parse("2026-10-19T12:00:00Z");
const goodBackup = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ meta: { kind: "one-number-backup", ref: TARGET_REFS.production, createdAt: "2026-10-19T11:30:00Z", complete: true, ...over } });
const fsDeps = (content: string | null) => ({ exists: () => content !== null, read: () => content as string });

describe("phone normalisation matches the app", () => {
  const corpus = [
    "(206) 555-0142", "206-555-0142", "2065550142", "12065550142", "+12065550142", "+1 206 555 0142",
    "+44 20 7946 0958", "+1206555", "555-0142", "", "  ", "abc", "+0123456789", "1-800-555-0100", "442079460958",
    18559168031, 2065550142, null, undefined,
  ];
  it("normalizeE164 equals src/lib/phone-e164 on every sample", () => {
    for (const sample of corpus) expect(normalizeE164(sample)).toBe(tsNormalizeE164(sample));
  });
  it("phoneKey equals normalizeConsentPhone on every sample", () => {
    for (const sample of corpus) expect(phoneKey(sample)).toBe(normalizeConsentPhone(String(sample ?? "")));
  });
  it("formats a US number for a text", () => {
    expect(formatDisplay("+12065550100")).toBe("(206) 555-0100");
    expect(formatDisplay("+442079460958")).toBe("+442079460958");
  });
});

describe("parseArgs", () => {
  const spec = { booleans: ["apply"], strings: ["target", "reason"] };
  it("reads booleans, values and --x=y", () => {
    expect(parseArgs(["--apply", "--target", "dev", "--reason=two words"], spec).flags).toEqual({ apply: true, target: "dev", reason: "two words" });
  });
  it("rejects unknown flags and a missing value", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--target"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["--target", "--apply"], spec)).toThrow(UsageError);
  });
});

describe("resolveTarget", () => {
  it("requires an explicit target: there is no default", () => {
    expect(() => resolveTarget({ target: undefined, env: env(DEV_URL) })).toThrow(GuardError);
    expect(() => resolveTarget({ target: "prod", env: env(DEV_URL) })).toThrow(GuardError);
  });
  it("accepts a target only when the environment points at that project", () => {
    expect(resolveTarget({ target: "dev", env: env(DEV_URL) }).ref).toBe(TARGET_REFS.dev);
    expect(() => resolveTarget({ target: "dev", env: env(PROD_URL) })).toThrow(/expects project/);
    expect(() => resolveTarget({ target: "production", env: env(DEV_URL) })).toThrow(/expects project/);
    expect(() => resolveTarget({ target: "staging", env: env(PROD_URL) })).toThrow(/expects project/);
  });
  it("refuses a non-Supabase url, a missing url and a missing key", () => {
    expect(() => resolveTarget({ target: "dev", env: env("http://localhost:54321") })).toThrow(/not a hosted Supabase/);
    expect(() => resolveTarget({ target: "dev", env: {} })).toThrow(/No Supabase URL/);
    expect(() => resolveTarget({ target: "dev", env: { NEXT_PUBLIC_SUPABASE_URL: DEV_URL } })).toThrow(/SERVICE_ROLE/);
    expect(refFromUrl("https://evil.example.com/emstjswhotsnyksqhqyf.supabase.co")).toBeNull();
  });
});

describe("assertGuards", () => {
  const prod = resolveTarget({ target: "production", env: env(PROD_URL) });
  const staging = resolveTarget({ target: "staging", env: env(STAGING_URL) });
  const dev = resolveTarget({ target: "dev", env: env(DEV_URL) });
  const full = { "confirm-ref": TARGET_REFS.production, reason: "cut over after the rehearsal", backup: "/b.json" };

  it("dev needs nothing extra, for reads and writes", () => {
    expect(() => assertGuards({ resolved: dev, write: false, flags: {}, now: NOW })).not.toThrow();
    expect(() => assertGuards({ resolved: dev, write: true, flags: {}, now: NOW })).not.toThrow();
  });

  it("staging and production need --confirm-ref even to read", () => {
    expect(() => assertGuards({ resolved: staging, write: false, flags: {}, now: NOW })).toThrow(/confirm-ref/);
    expect(() => assertGuards({ resolved: staging, write: false, flags: { "confirm-ref": TARGET_REFS.production }, now: NOW })).toThrow(/confirm-ref/);
    expect(() => assertGuards({ resolved: staging, write: false, flags: { "confirm-ref": TARGET_REFS.staging }, now: NOW })).not.toThrow();
    expect(() => assertGuards({ resolved: prod, write: false, flags: {}, now: NOW })).toThrow(/confirm-ref/);
  });

  it("a staging write also needs a reason", () => {
    const flags = { "confirm-ref": TARGET_REFS.staging };
    expect(() => assertGuards({ resolved: staging, write: true, flags, now: NOW })).toThrow(/reason/);
    expect(() => assertGuards({ resolved: staging, write: true, flags: { ...flags, reason: "short" }, now: NOW })).toThrow(/reason/);
    expect(() => assertGuards({ resolved: staging, write: true, flags: { ...flags, reason: "rehearsal of the cutover" }, now: NOW })).not.toThrow();
  });

  it("a production write needs EVERY guard: confirm-ref, reason and a fresh backup", () => {
    const ok = () => assertGuards({ resolved: prod, write: true, flags: full, now: NOW, fsDeps: fsDeps(goodBackup()) });
    expect(ok).not.toThrow();
    for (const drop of ["confirm-ref", "reason", "backup"] as const) {
      const flags: Record<string, string> = { ...full };
      delete flags[drop];
      expect(() => assertGuards({ resolved: prod, write: true, flags, now: NOW, fsDeps: fsDeps(goodBackup()) }), `missing ${drop}`).toThrow(GuardError);
    }
    expect(() => assertGuards({ resolved: prod, write: true, flags: { ...full, "confirm-ref": TARGET_REFS.dev }, now: NOW, fsDeps: fsDeps(goodBackup()) })).toThrow(/confirm-ref/);
  });

  it("a production READ does not need a backup or a reason", () => {
    expect(() => assertGuards({ resolved: prod, write: false, flags: { "confirm-ref": TARGET_REFS.production }, now: NOW })).not.toThrow();
  });
});

describe("validateBackup", () => {
  const check = (content: string | null, path = "/b.json") => () => validateBackup(path, { ref: TARGET_REFS.production, now: NOW, ...fsDeps(content) });
  it("accepts a recent complete backup of this project", () => {
    expect(check(goodBackup())().createdAt).toBe("2026-10-19T11:30:00Z");
  });
  it("refuses a missing path, a missing file, bad json and foreign files", () => {
    expect(() => validateBackup("", { ref: TARGET_REFS.production, now: NOW })).toThrow(/--backup/);
    expect(check(null)).toThrow(/not found/);
    expect(check("{not json")).toThrow(/valid JSON/);
    expect(check(JSON.stringify({ meta: { kind: "something-else" } }))).toThrow(/not written by backup/);
  });
  it("refuses an incomplete, wrong-project, stale or future-dated backup", () => {
    expect(check(goodBackup({ complete: false }))).toThrow(/incomplete/);
    expect(check(goodBackup({ ref: TARGET_REFS.dev }))).toThrow(/project/);
    expect(check(goodBackup({ createdAt: "2026-10-19T08:00:00Z" }))).toThrow(/minutes old/);
    expect(check(goodBackup({ createdAt: "2026-10-20T08:00:00Z" }))).toThrow(/future/);
    expect(check(goodBackup({ createdAt: "garbage" }))).toThrow(/creation time/);
  });
});

describe("bootstrap reads the env FILE, not the shell", () => {
  it("a production file beats an ambient dev URL, and a mismatch is still refused", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { bootstrap } = await import("../../scripts/one-number/lib/runtime.mjs");
    const dir = mkdtempSync(join(tmpdir(), "w18-env-"));
    const prodFile = join(dir, "prod.env");
    writeFileSync(prodFile, `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\nSUPABASE_SERVICE_ROLE_KEY=k\n`);
    const before = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = DEV_URL;
    try {
      const lines: string[] = [];
      const ok = bootstrap("t", ["--target", "production", "--env-file", prodFile, "--confirm-ref", TARGET_REFS.production], {}, { write: false, deps: { db: {}, log: (l: string) => lines.push(l) } });
      expect(ok.resolved.ref).toBe(TARGET_REFS.production);
      expect(lines[0]).toContain(`project=${TARGET_REFS.production}`);
      expect(() => bootstrap("t", ["--target", "dev", "--env-file", prodFile], {}, { write: false, deps: { db: {}, log: () => {} } })).toThrow(/expects project/);
      expect(() => bootstrap("t", ["--target", "dev", "--env-file", join(dir, "missing.env")], {}, { write: false, deps: { db: {}, log: () => {} } })).toThrow(/not found/);
    } finally {
      if (before === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = before;
    }
  });
});
