import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An invite link grants module access to real properties to whoever opens it.
 * These are the properties that make handing one out safe, each of which is
 * invisible to a build and to a render test.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const SERVER = read("src/lib/invite-links/invite-links.server.ts");
const MIGRATION = read("supabase/migrations/20260906090000_manager_invite_links.sql");
const REDEEM_ROUTE = read("src/app/api/pro/invite-links/redeem/route.ts");
const PAGE = read("src/app/invite/[token]/invite-link-client.tsx");

describe("the token is never stored", () => {
  it("hashes on the way in and matches on the hash", () => {
    expect(SERVER).toContain('createHash("sha256")');
    expect(SERVER).toContain('.eq("token_hash", hashInviteLinkToken(token))');
  });

  it("never selects a raw token column", () => {
    // There is no such column; this fails loudly if one is ever added.
    expect(SERVER).not.toMatch(/select\([^)]*\btoken\b(?!_hash)/);
    expect(MIGRATION).not.toMatch(/^\s+token text/m);
  });
});

describe("the tables are service-role only", () => {
  it("enables RLS and grants the client roles nothing", () => {
    // PostgREST exposes the public schema, so any grant here is reachable from
    // a browser console with the shipped anon key.
    expect(MIGRATION).toContain("alter table public.manager_invite_links enable row level security");
    expect(MIGRATION).toContain(
      "revoke all on public.manager_invite_links from anon, authenticated",
    );
    expect(MIGRATION).toContain(
      "revoke all on public.manager_invite_link_redemptions from anon, authenticated",
    );
  });

  it("writes no policy that could re-open them", () => {
    expect(MIGRATION).not.toMatch(/create policy/i);
    expect(MIGRATION).not.toMatch(/for all/i);
  });
});

describe("the redeemer names nothing", () => {
  it("takes only the token from the request body", () => {
    // Scope and permissions come off the stored link. A body field here would
    // be the redeemer authorizing their own access.
    const body = REDEEM_ROUTE.slice(REDEEM_ROUTE.indexOf("req.json()"));
    expect(body).toContain("{ token?: string }");
    expect(body).not.toContain("assignedPropertyIds");
    expect(body).not.toContain("propertyPermissions");
  });

  it("re-derives ownership at redemption, not just at mint", () => {
    // The link may have been minted before a property changed hands.
    const redeem = SERVER.slice(SERVER.indexOf("export async function redeemInviteLink"));
    expect(redeem).toContain("findPropertyIdsNotOwnedByManager");
    // Refuse rather than narrow — a silent partial grant is the failure mode.
    expect(redeem).toContain("no longer manages");
  });

  it("re-checks the paid plan on BOTH sides at redemption", () => {
    const redeem = SERVER.slice(SERVER.indexOf("export async function redeemInviteLink"));
    expect(redeem).toContain("managerPlanAllowsCoManagerInvites");
    expect(redeem).toContain("link.owner_user_id");
    expect(redeem).toContain("redeemerUserId");
  });

  it("refuses the owner redeeming their own link", () => {
    expect(SERVER).toContain("This is your own invite link.");
  });
});

describe("the use budget cannot be raced or replayed", () => {
  it("spends a use with a conditional update", () => {
    // Two people opening a one-time link at once must not both win: the second
    // update matches no row because used_count has moved.
    const redeem = SERVER.slice(SERVER.indexOf("export async function redeemInviteLink"));
    expect(redeem).toContain('.eq("used_count", link.used_count ?? 0)');
    expect(redeem).toContain('.lt("used_count", link.max_uses)');
    expect(redeem).toContain("just used up");
  });

  it("records a redemption per user so re-opening is a no-op", () => {
    expect(MIGRATION).toContain("manager_invite_link_redemptions_unique_idx");
    expect(SERVER).toContain("alreadyRedeemed: true");
  });
});

describe("opening a link never changes an account on its own", () => {
  it("requires a click, and a session, before anything is redeemed", () => {
    // A URL in a group chat must not quietly link whoever loads it.
    expect(PAGE).toContain('data-attr="invite-link-accept"');
    expect(PAGE).toContain("Sign in to accept");
    // No redeem call inside a mount effect.
    const mountEffects = PAGE.slice(0, PAGE.indexOf("const accept ="));
    expect(mountEffects).not.toContain("invite-links/redeem");
  });

  it("hands off to the one existing accept path", () => {
    // Not a second implementation of "become a co-manager".
    expect(PAGE).toContain("/portal/teams/managers/");
  });
});
