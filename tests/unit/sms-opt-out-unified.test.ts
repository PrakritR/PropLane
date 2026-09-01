// STOP must be honored no matter which store recorded it. PropLane keeps two:
//   1. `sms_consent` ledger (phone-keyed)   — the manager work-line webhook.
//   2. `profiles.sms_opt_out_at` (user-keyed) — the vendor-agent webhook.
// `isPhoneOptedOut` is the single unified read path every send funnels through.
// These tests prove a STOP on EITHER store blocks sends that check the other.
import { describe, expect, it } from "vitest";
import { isPhoneOptedOut, normalizeConsentPhone } from "@/lib/sms-consent";

type ConsentRow = { phone: string; opted_in_at?: string | null; opted_out_at?: string | null };
type ProfileRow = { id?: string; phone: string; sms_opt_out_at?: string | null; sms_consent_at?: string | null };

// Minimal Supabase-shaped stub for the two tables `isPhoneOptedOut` reads.
function makeDb(opts: { consent?: ConsentRow[]; profiles?: ProfileRow[]; profilesThrows?: boolean }) {
  const consent = opts.consent ?? [];
  const profiles = opts.profiles ?? [];
  return {
    from(table: string) {
      if (table === "sms_consent") {
        let phoneEq: string | null = null;
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (_col: string, val: string) => {
            phoneEq = val;
            return chain;
          },
          maybeSingle: async () => ({ data: consent.find((r) => r.phone === phoneEq) ?? null, error: null }),
        };
        return chain;
      }
      if (table === "profiles") {
        if (opts.profilesThrows) {
          const chain: Record<string, unknown> = {
            select: () => chain,
            in: () => {
              throw new Error("profiles store unavailable");
            },
          };
          return chain;
        }
        let phoneVariants: string[] = [];
        let idEq: string | null = null;
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (_col: string, val: string) => {
            idEq = val;
            return chain;
          },
          in: (_col: string, vals: string[]) => {
            phoneVariants = vals;
            return chain;
          },
          maybeSingle: async () => ({ data: profiles.find((p) => p.id === idEq) ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({
              data: profiles.filter((p) => phoneVariants.includes(p.phone)),
              error: null,
            }).then(resolve),
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as never;
}

const NOW = "2026-07-25T00:00:00.000Z";
const EARLIER = "2026-07-24T00:00:00.000Z";
const LATER = "2026-07-26T00:00:00.000Z";

describe("normalizeConsentPhone collapses formats to one key", () => {
  it("reduces every US format to a bare 10-digit key", () => {
    for (const raw of ["+15551234567", "15551234567", "5551234567", "(555) 123-4567", "555-123-4567"]) {
      expect(normalizeConsentPhone(raw)).toBe("5551234567");
    }
  });
});

describe("isPhoneOptedOut — unified across both stores", () => {
  it("blocks when the ledger recorded the STOP", async () => {
    const db = makeDb({ consent: [{ phone: "5551234567", opted_out_at: NOW }] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(true);
  });

  it("blocks when only profiles.sms_opt_out_at recorded the STOP (vendor path)", async () => {
    // No ledger row at all — the vendor webhook wrote only the profiles column.
    const db = makeDb({ profiles: [{ phone: "15551234567", sms_opt_out_at: NOW }] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(true);
  });

  it("matches the profiles column across stored phone formats", async () => {
    for (const stored of ["15551234567", "5551234567", "+15551234567"]) {
      const db = makeDb({ profiles: [{ phone: stored, sms_opt_out_at: NOW }] });
      expect(await isPhoneOptedOut(db, "5551234567")).toBe(true);
    }
  });

  it("does NOT block a number with no record on either store", async () => {
    const db = makeDb({ consent: [], profiles: [] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(false);
  });

  it("honors a later opt-in over an older opt-out in the ledger", async () => {
    const db = makeDb({ consent: [{ phone: "5551234567", opted_out_at: EARLIER, opted_in_at: LATER }] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(false);
  });

  it("honors a later consent over an older opt-out in the profiles store", async () => {
    const db = makeDb({ profiles: [{ phone: "5551234567", sms_opt_out_at: EARLIER, sms_consent_at: LATER }] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(false);
  });

  it("blocks when the profiles opt-out is newer than the consent", async () => {
    const db = makeDb({ profiles: [{ phone: "5551234567", sms_opt_out_at: LATER, sms_consent_at: EARLIER }] });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(true);
  });
});

describe("cross-store re-opt-in — a later START on one store supersedes a STOP on the other", () => {
  it("re-enables after STOP on profiles then START recorded on the ledger", async () => {
    // Vendor STOPped (profiles.sms_opt_out_at set), then texted START to a
    // manager work line, which records only a ledger opt-in.
    const db = makeDb({
      consent: [{ phone: "5551234567", opted_in_at: LATER }],
      profiles: [{ phone: "15551234567", sms_opt_out_at: EARLIER }],
    });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(false);
  });

  it("re-enables after STOP on the ledger then consent recorded on profiles", async () => {
    const db = makeDb({
      consent: [{ phone: "5551234567", opted_out_at: EARLIER }],
      profiles: [{ phone: "5551234567", sms_consent_at: LATER }],
    });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(false);
  });

  it("still blocks when the cross-store STOP is newer than the opt-in", async () => {
    const db = makeDb({
      consent: [{ phone: "5551234567", opted_in_at: EARLIER }],
      profiles: [{ phone: "5551234567", sms_opt_out_at: LATER }],
    });
    expect(await isPhoneOptedOut(db, "+15551234567")).toBe(true);
  });

  it("stays ledger-authoritative when the profiles query throws", async () => {
    const blocked = makeDb({ consent: [{ phone: "5551234567", opted_out_at: NOW }], profilesThrows: true });
    expect(await isPhoneOptedOut(blocked, "+15551234567")).toBe(true);
    const clean = makeDb({ consent: [], profilesThrows: true });
    expect(await isPhoneOptedOut(clean, "+15551234567")).toBe(false);
  });
});

describe("user-keyed read — a legacy profile-only STOP participates via opts.userId", () => {
  it("blocks when the STOP lives only on the user row with an unmatchable phone", async () => {
    // Pre-ledger STOP: sms_opt_out_at set, profiles.phone empty, no ledger row.
    const db = makeDb({ profiles: [{ id: "u1", phone: "", sms_opt_out_at: NOW }] });
    expect(await isPhoneOptedOut(db, "+15551234567", { userId: "u1" })).toBe(true);
  });

  it("re-enables that legacy STOP after a later ledger opt-in", async () => {
    const db = makeDb({
      consent: [{ phone: "5551234567", opted_in_at: LATER }],
      profiles: [{ id: "u1", phone: "", sms_opt_out_at: EARLIER }],
    });
    expect(await isPhoneOptedOut(db, "+15551234567", { userId: "u1" })).toBe(false);
  });

  it("re-enables that legacy STOP after a later consent on the same user row", async () => {
    const db = makeDb({ profiles: [{ id: "u1", phone: "", sms_opt_out_at: EARLIER, sms_consent_at: LATER }] });
    expect(await isPhoneOptedOut(db, "+15551234567", { userId: "u1" })).toBe(false);
  });

  it("governs from the user row alone when no phone is available", async () => {
    const db = makeDb({ profiles: [{ id: "u1", phone: "", sms_opt_out_at: NOW }] });
    expect(await isPhoneOptedOut(db, "", { userId: "u1" })).toBe(true);
  });
});
