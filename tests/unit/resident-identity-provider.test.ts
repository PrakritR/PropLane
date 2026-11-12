import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { applicantIdCheckAvailable, residentIdentityProvider } from "@/lib/resident-identity/provider";
import { personaEnabled } from "@/lib/resident-identity/persona.server";
import { resolveBaselineResidentIdentity } from "@/lib/resident-identity/baseline.server";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});
const db = { from: vi.fn() } as unknown as SupabaseClient;

describe("resident identity provider", () => {
  it("defaults to Checkr, accepts Persona, and refuses everything else (Stripe Identity included)", () => {
    expect(residentIdentityProvider({})).toBe("checkr");
    expect(residentIdentityProvider({ RESIDENT_IDENTITY_PROVIDER: " Persona " })).toBe("persona");
    expect(residentIdentityProvider({ RESIDENT_IDENTITY_PROVIDER: "checkr" })).toBe("checkr");
    expect(residentIdentityProvider({ RESIDENT_IDENTITY_PROVIDER: "stripe" })).toBeNull();
    expect(residentIdentityProvider({ RESIDENT_IDENTITY_PROVIDER: "whatever" })).toBeNull();
  });

  it("the ID check is unavailable unless the master switch, the provider and Checkr are all in place", () => {
    const ok = { RESIDENT_IDENTITY_ENABLED: "true", CHECKR_API_KEY: "ckr_sk_test_x" };
    expect(applicantIdCheckAvailable(ok)).toBe(true);
    expect(applicantIdCheckAvailable({ ...ok, RESIDENT_IDENTITY_ENABLED: "false" })).toBe(false);
    expect(applicantIdCheckAvailable({ CHECKR_API_KEY: "ckr_sk_test_x" })).toBe(false);
    expect(applicantIdCheckAvailable({ RESIDENT_IDENTITY_ENABLED: "true" })).toBe(false);
    expect(applicantIdCheckAvailable({ ...ok, RESIDENT_IDENTITY_PROVIDER: "stripe" })).toBe(false);
    expect(applicantIdCheckAvailable({ ...ok, RESIDENT_IDENTITY_PROVIDER: "persona" })).toBe(false);
  });

  it("Persona stays off unless it is the chosen provider, even with its keys", () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true";
    process.env.PERSONA_API_KEY = "k";
    process.env.PERSONA_TEMPLATE_ID = "t";
    process.env.PERSONA_WEBHOOK_SECRET = "s";
    delete process.env.RESIDENT_IDENTITY_PROVIDER;
    expect(personaEnabled()).toBe(false);
    process.env.RESIDENT_IDENTITY_PROVIDER = "persona";
    expect(personaEnabled()).toBe(true);
  });

  it("the baseline gate never blocks on Checkr (the check rides the order) and fails closed on a bad provider", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true";
    delete process.env.RESIDENT_IDENTITY_PROVIDER;
    expect(await resolveBaselineResidentIdentity(db, "resident")).toBe("disabled");
    process.env.RESIDENT_IDENTITY_PROVIDER = "stripe";
    expect(await resolveBaselineResidentIdentity(db, "resident")).toBe("unavailable");
    expect(db.from).not.toHaveBeenCalled();
  });
});
