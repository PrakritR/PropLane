// The one rule for when an INBOUND TEXT alone may open a session: never an admin, and only a resident / vendor account
// or one whose phone is its only proven credential. Pinned for every role mix, and for the two callers. A code texted
// to the account's own phone is the documented exception (captain, Oct 26) and is pinned here too.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
const phone = vi.hoisted(() => ({ mint: vi.fn(), owners: vi.fn() }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ mintPhoneSession: phone.mint, phoneOwners: phone.owners }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.ai" }));
vi.mock("@/lib/one-number/link-destinations.server", () => ({ residentPhoneMatches: vi.fn(async () => true) }));

import {
  phoneCodeSignInAllowed, phoneCodeSignInDecision, smsProvenSessionAllowed, smsProvenSessionVerdict,
} from "@/lib/auth/sms-proven-session.server";
import { mintResidentPortalSessionForLink } from "@/lib/one-number/link-portal-session.server";
import { mintPhoneSignInLink } from "@/lib/one-number/signup/sign-in-link.server";

type World = {
  roles?: string[];
  legacyRole?: string | null;
  profileEmail?: string | null;
  authEmail?: string | null;
  identities?: Array<{ provider: string; identity_data?: { email?: string } }>;
  appMetadata?: Record<string, unknown>;
  /** Accepted team seats (`account_link_invites` where this user is the invitee). */
  seats?: Array<{ team_role: string | null }>;
  seatsError?: boolean;
  rolesError?: boolean;
  authError?: boolean;
};
const PLACEHOLDER = "abc@phone.proplane.invalid";

function world(w: World = {}) {
  const generateLink = vi.fn(async () => ({ data: { properties: { hashed_token: "HASHED" } }, error: null }));
  const db = {
    from(table: string) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { role: w.legacyRole ?? null, email: w.profileEmail ?? null }, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(table === "profile_roles"
            ? { data: (w.roles ?? []).map((role) => ({ role })), error: w.rolesError ? { message: "down" } : null }
            : table === "account_link_invites"
              ? { data: w.seats ?? [], error: w.seatsError ? { message: "down" } : null }
              : { data: [], error: null }),
      };
      return chain;
    },
    auth: {
      admin: {
        generateLink,
        getUserById: vi.fn(async () =>
          w.authError
            ? { data: { user: null }, error: { message: "down" } }
            : {
                data: {
                  user: {
                    id: "u1",
                    email: w.authEmail === undefined ? PLACEHOLDER : w.authEmail,
                    identities: w.identities ?? [{ provider: "phone" }, { provider: "email", identity_data: { email: PLACEHOLDER } }],
                    app_metadata: w.appMetadata ?? { provider: "phone", providers: ["phone"] },
                  },
                },
                error: null,
              }),
      },
    },
  } as unknown as SupabaseClient;
  return { db, generateLink };
}

const GOOGLE = [{ provider: "google" }, { provider: "email", identity_data: { email: "m@example.com" } }];

describe("smsProvenSessionVerdict: who a phone alone may sign in", () => {
  it.each([
    ["resident only", { roles: ["resident"], authEmail: "r@example.com" }],
    ["vendor only", { roles: ["vendor"], authEmail: "v@example.com" }],
    ["resident and vendor", { roles: ["resident", "vendor"], authEmail: "rv@example.com", identities: GOOGLE }],
    ["legacy profiles.role resident with no profile_roles rows", { roles: [], legacyRole: "resident", authEmail: "r@example.com" }],
  ] as Array<[string, World]>)("allows %s even with a real email", async (_name, w) => {
    expect(await smsProvenSessionVerdict(world(w).db, "u1")).toEqual({ ok: true, reason: "resident_vendor_only" });
  });

  it("allows a manager whose phone is the only credential (the SMS sign-up shape)", async () => {
    expect(await smsProvenSessionVerdict(world({ roles: ["manager"] }).db, "u1")).toEqual({ ok: true, reason: "phone_only_credential" });
    expect(await smsProvenSessionVerdict(world({ roles: ["manager", "vendor"], authEmail: null, identities: [{ provider: "phone" }] }).db, "u1")).toEqual({
      ok: true,
      reason: "phone_only_credential",
    });
  });

  it.each([
    ["a manager with a real email login", { roles: ["manager"], authEmail: "m@example.com" }],
    ["a manager with an OAuth identity", { roles: ["manager"], identities: GOOGLE }],
    ["a manager whose provider list names OAuth", { roles: ["manager"], appMetadata: { providers: ["phone", "google"] } }],
    ["a manager and resident (mixed) with a real email", { roles: ["manager", "resident"], authEmail: "m@example.com" }],
    ["a vendor and manager (mixed) with a real email", { roles: ["vendor", "manager"], authEmail: "m@example.com" }],
    ["an email identity that is not the placeholder", { roles: ["manager"], identities: [{ provider: "email", identity_data: { email: "m@example.com" } }] }],
  ] as Array<[string, World]>)("refuses %s", async (_name, w) => {
    expect(await smsProvenSessionVerdict(world(w).db, "u1")).toEqual({ ok: false, reason: "other_credential" });
  });

  it.each([
    ["an admin role", { roles: ["admin"] }],
    ["an admin role beside resident", { roles: ["resident", "admin"], authEmail: "r@example.com" }],
    ["the legacy admin profile role", { roles: ["resident"], legacyRole: "admin" }],
    ["the primary admin email on the login", { roles: ["resident"], authEmail: "Founders@axis-seattle-housing.com" }],
    ["the primary admin email on the profile", { roles: ["manager"], profileEmail: "founders@axis-seattle-housing.com" }],
    ["an admin even when the phone is the only credential", { roles: ["admin"], identities: [{ provider: "phone" }] }],
  ] as Array<[string, World]>)("never mints for %s", async (_name, w) => {
    expect(await smsProvenSessionVerdict(world(w).db, "u1")).toEqual({ ok: false, reason: "admin" });
  });

  it("a signed-out phone-code sign-in is open for every readable account, admins included, and refused only when unreadable (captain, Oct 26)", async () => {
    for (const w of [
      { roles: ["admin"] },
      { roles: ["resident"], authEmail: "Founders@axis-seattle-housing.com" },
      { roles: ["manager"], authEmail: "m@example.com" },
      { roles: ["resident"] },
    ] as World[]) expect(await phoneCodeSignInAllowed(world(w).db, "u1")).toBe(true);
    expect(await phoneCodeSignInAllowed(world({ roles: ["admin"], rolesError: true }).db, "u1")).toBe(false);
    // The same verdict names the admin, so the caller can audit the privileged sign-in without a second read.
    expect(await phoneCodeSignInDecision(world({ roles: ["admin"] }).db, "u1")).toEqual({ allowed: true, admin: true });
    expect(await phoneCodeSignInDecision(world({ roles: ["resident"] }).db, "u1")).toEqual({ allowed: true, admin: false });
    expect(await phoneCodeSignInDecision(world({ roles: ["admin"], rolesError: true }).db, "u1")).toEqual({ allowed: false, admin: false });
    // an inbound text alone still never opens an admin session
    expect(await smsProvenSessionAllowed(world({ roles: ["admin"] }).db, "u1")).toBe(false);
  });

  it.each([
    ["a co-manager seat", [{ team_role: "co_manager" }]],
    ["an assistant seat", [{ team_role: "assistant" }]],
    ["a seat with no stored role", [{ team_role: null }]],
    ["a seat beside an owner seat", [{ team_role: "property_owner" }, { team_role: "co_manager" }]],
  ])("a resident-only profile that holds %s is a teammate: refused when it has a real email", async (_name, seats) => {
    const w = { roles: ["resident"], authEmail: "t@example.com", seats } as World;
    expect(await smsProvenSessionVerdict(world(w).db, "u1")).toEqual({ ok: false, reason: "other_credential" });
    expect(await smsProvenSessionAllowed(world(w).db, "u1")).toBe(false);
  });

  it("a property-owner seat is not a portal: it does not turn a resident into a manager", async () => {
    const w = { roles: ["resident"], authEmail: "o@example.com", seats: [{ team_role: "property_owner" }] } as World;
    expect(await smsProvenSessionVerdict(world(w).db, "u1")).toEqual({ ok: true, reason: "resident_vendor_only" });
  });

  it("an unreadable seat read fails closed", async () => {
    expect(await smsProvenSessionVerdict(world({ roles: ["resident"], seatsError: true }).db, "u1")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("an account with no roles at all and a real email is refused, never assumed harmless", async () => {
    expect(await smsProvenSessionAllowed(world({ roles: [], authEmail: "x@example.com" }).db, "u1")).toBe(false);
  });

  it("fails closed when any read fails", async () => {
    expect(await smsProvenSessionVerdict(world({ roles: ["resident"], rolesError: true }).db, "u1")).toEqual({ ok: false, reason: "unreadable" });
    expect(await smsProvenSessionVerdict(world({ roles: ["resident"], authError: true }).db, "u1")).toEqual({ ok: false, reason: "unreadable" });
    expect(await smsProvenSessionAllowed(world().db, "")).toBe(false);
  });
});

describe("the two callers go through the one rule", () => {
  const LEASE = { purpose: "lease" as const, targetType: "resident", targetId: "u1", phoneKey: "2065550142" };
  beforeEach(() => {
    vi.clearAllMocks();
    phone.mint.mockResolvedValue({ access_token: "a", refresh_token: "r" });
    phone.owners.mockResolvedValue(["u1"]);
  });

  it("a resident link opens a session for a resident, and not for an account that is also a manager or an admin", async () => {
    expect(await mintResidentPortalSessionForLink(world({ roles: ["resident"], authEmail: "r@example.com" }).db, LEASE)).toEqual({ access_token: "a", refresh_token: "r" });
    expect(await mintResidentPortalSessionForLink(world({ roles: ["resident", "manager"], authEmail: "r@example.com" }).db, LEASE)).toBeNull();
    expect(await mintResidentPortalSessionForLink(world({ roles: ["resident", "admin"], authEmail: "r@example.com" }).db, LEASE)).toBeNull();
    expect(phone.mint).toHaveBeenCalledTimes(1);
  });

  it("the sign-up reply's one-tap link is minted for a phone-only manager and a resident, never for a manager with an email or an admin", async () => {
    const ok = world({ roles: ["manager"] });
    expect(await mintPhoneSignInLink(ok.db, { phoneE164: "+12065550142", userId: "u1" })).toBe("https://proplane.ai/auth/confirm?token_hash=HASHED&type=magiclink");
    const manager = world({ roles: ["manager"], authEmail: "m@example.com" });
    expect(await mintPhoneSignInLink(manager.db, { phoneE164: "+12065550142", userId: "u1" })).toBeNull();
    const admin = world({ roles: ["admin"] });
    expect(await mintPhoneSignInLink(admin.db, { phoneE164: "+12065550142", userId: "u1" })).toBeNull();
    expect(manager.generateLink).not.toHaveBeenCalled();
    expect(admin.generateLink).not.toHaveBeenCalled();
  });
});
