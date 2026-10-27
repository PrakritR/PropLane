/**
 * Owner of record, Oct 26 — the security rule "only a bound Admin › Service invite makes the owner of a PropLane-owned
 * workspace" written out as a readable transcript instead of only asserted.
 *
 * This path has no screen of its own after the invite sheet (the redemption happens between two page loads), so the
 * artifact is what the person opening the link is actually told and what the rows end up holding:
 *
 *   1. Admin › Service invites the owner: one email, one one-use link, bound to the address it was sent to;
 *   2. the same owner seat asked for from the ordinary share sheet is refused — a share link can never mint the
 *      owner of record of a workspace PropLane owns;
 *   3. a forwarded link opened by somebody else is refused BEFORE the single use is spent, so the right person can
 *      still accept;
 *   4. the invited address accepts and becomes the owner of record;
 *   5. an UNBOUND owner link (a share link, or one minted before this rule) redeems as nothing at all;
 *   6. a link whose binding cannot be READ (a statement timeout, not a missing column) refuses — a read error
 *      never unbinds a link.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-service-owner-of-record-1026.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN_A = "22222222-2222-4222-8222-222222222222";
const PRIYA = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const NIKHIL = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let admins = new Set<string>();
vi.mock("@/lib/auth/admin-role", () => ({
  userHoldsAdminRole: async (_db: unknown, id: string) => admins.has(id),
  listAdminUserIds: async () => [...admins].sort(),
}));
vi.mock("@/lib/manager-access-server", () => ({
  ensureProfileProplaneId: async (_db: unknown, id: string) => ({
    ok: true,
    proplaneId: `AX-${id.slice(0, 4)}`,
    fullName: `Name ${id.slice(0, 4)}`,
    email: `${id.slice(0, 4)}@example.com`,
    role: "admin",
  }),
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "free" })),
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: false as const, tier: "free" as const })),
}));
const sentEmails = vi.hoisted(() => ({ items: [] as Array<{ to: string[]; subject: string; text: string }> }));
vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: vi.fn(async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    sentEmails.items.push(args.payload);
    return new Response(JSON.stringify({ id: "captured" }), { status: 200 });
  }),
}));
vi.mock("@/lib/co-manager-notification.server", () => ({ notifyCoManagerInviteSent: vi.fn(async () => undefined) }));
process.env.RESEND_API_KEY = "re_test_key";

const svc = await import("@/lib/service/service-workspaces.server");
const { mintInviteLink, redeemInviteLink } = await import("@/lib/invite-links/invite-links.server");

let db: ServiceFakeDb;
const client = () => db as never;
let authUsers: Record<string, { email: string; email_confirmed_at: string | null }> = {};

/* ------------------------------------------------------------------ transcript */

const transcript: string[] = [];
const say = (line = "") => transcript.push(line);
const scene = (title: string) => {
  say();
  say(title);
  say("-".repeat(title.length));
};
/** What the person opening the link is shown, in the words the server returns. */
const shown = (who: string, res: { ok: boolean; status?: number; error?: string }) =>
  say(`  ${who} → ${res.ok ? "accepted" : `refused (${res.status}) "${res.error}"`}`);
const linkRow = () => db.tables.manager_invite_links[0]!;
const uses = () => `uses spent: ${Number(linkRow().used_count ?? 0)} of ${Number(linkRow().max_uses ?? 0)}`;

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "service-owner-of-record-transcript.txt"), `${transcript.join("\n")}\n`);
});

/* ------------------------------------------------------------------ world */

function seed() {
  authUsers = {
    [PRIYA]: { email: "priya@example.com", email_confirmed_at: "2026-10-26T00:00:00Z" },
    [NIKHIL]: { email: "nikhil@example.com", email_confirmed_at: "2026-10-26T00:00:00Z" },
  };
  admins = new Set([OWNER, ADMIN_A]);
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profile_roles: [{ user_id: OWNER, role: "manager" }],
    profiles: [OWNER, ADMIN_A, PRIYA, NIKHIL].map((id) => ({
      id,
      full_name: `Name ${id.slice(0, 4)}`,
      email: `${id.slice(0, 4)}@example.com`,
      manager_id: `AX-${id.slice(0, 4).toUpperCase()}`,
    })),
    portal_workspaces: [],
    account_link_invites: [],
    manager_property_records: [],
    manager_invite_links: [],
    manager_invite_link_redemptions: [],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    sms_runtime_config: [],
    audit_log: [],
  });
  (db as unknown as { auth: unknown }).auth = {
    admin: {
      getUserById: async (id: string) => ({
        data: {
          user: {
            email: authUsers[id]?.email ?? `${id.slice(0, 4)}@example.com`,
            email_confirmed_at: authUsers[id] ? authUsers[id]!.email_confirmed_at : "2026-10-01T00:00:00Z",
            user_metadata: { full_name: "New Owner" },
          },
        },
      }),
    },
  };
}

/** PropLane's own managed workspace, with two houses on it. */
async function managedWorkspace(name = "1. Ambika") {
  const res = (await svc.createServiceWorkspace(client(), ADMIN_A, { name, city: "Seattle" })) as { id: string };
  db.tables.manager_property_records.push(
    { id: "house-a", manager_user_id: OWNER, workspace_id: res.id },
    { id: "house-b", manager_user_id: OWNER, workspace_id: res.id },
  );
  // The database trigger keeps an "all houses" seat's houses current; the fake has no triggers, so say it by hand.
  const houses = db.tables.manager_property_records.filter((h) => h.workspace_id === res.id).map((h) => h.id);
  for (const l of db.tables.account_link_invites) if (l.workspace_id === res.id && l.house_scope === "all") l.assigned_property_ids = houses;
  return res.id;
}

const tokenFromEmail = () => /\/invite\/([^\s]+)/.exec(sentEmails.items[0]!.text)![1]!;

/**
 * The same client, except the one read that asks for the link's binding fails the way a statement timeout does:
 * the column is there, the answer is not. Everything else answers normally.
 */
function bindingUnreadable(): never {
  return {
    ...db,
    from(table: string) {
      const q = db.from(table) as Record<string, unknown>;
      if (table !== "manager_invite_links") return q;
      return {
        ...q,
        select: (cols?: string, opts?: { count?: string }) =>
          String(cols ?? "").trim() === "invitee_email"
            ? { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) }) }
            : (q.select as (c?: string, o?: { count?: string }) => unknown)(cols, opts),
      };
    },
  } as never;
}

beforeEach(() => {
  sentEmails.items.length = 0;
  seed();
});

describe("the owner of record of a PropLane-owned workspace", () => {
  it("comes only from a bound Admin › Service invite, and a forwarded or unbound link spends no use", async () => {
    const workspaceId = await managedWorkspace();

    scene("SCENE 1 — Admin › Service invites the owner of 1. Ambika");
    const invited = await svc.inviteServiceClient(client(), ADMIN_A, {
      id: workspaceId,
      email: "Priya@Example.com",
      inviteeName: "Priya Nair",
      ownerOfRecord: true,
    });
    expect(invited).toMatchObject({ ok: true, delivery: "link" });
    const mail = sentEmails.items[0]!;
    say(`  PropLane emails  to: ${mail.to.join(", ")}`);
    say(`                   subject: ${mail.subject}`);
    mail.text.split("\n").forEach((line) => say(`                   ${line}`));
    say(`  link row         team_role: ${String(linkRow().team_role)} · max_uses: ${Number(linkRow().max_uses)} · bound to: ${String(linkRow().invitee_email)}`);
    say(`                   label: ${String(linkRow().label)}`);
    expect(linkRow()).toMatchObject({ team_role: "property_owner", max_uses: 1, invitee_email: "priya@example.com" });
    const token = tokenFromEmail();

    scene("SCENE 2 — the same owner seat asked for from the ordinary share sheet");
    const shareLink = await mintInviteLink(client(), {
      actorUserId: ADMIN_A,
      kind: "manager",
      teamRole: "property_owner",
      houseScope: "selected",
      assignedPropertyIds: ["house-a"],
      propertyPermissions: {},
      workspaceId,
    });
    shown("Share sheet · Create link", shareLink);
    expect(shareLink).toMatchObject({ ok: false, status: 403, error: "The owner of a PropLane Service workspace is invited from Admin › Service." });
    say(`  links in the workspace: ${db.tables.manager_invite_links.length} (only the one Admin › Service minted)`);
    expect(db.tables.manager_invite_links).toHaveLength(1);

    scene("SCENE 3 — the link is forwarded and opened by somebody else");
    shown("Nikhil (nikhil@example.com) opens it", await redeemInviteLink(client(), { token, redeemerUserId: NIKHIL }));
    say(`  ${uses()} — the right person can still accept`);
    expect(await redeemInviteLink(client(), { token, redeemerUserId: NIKHIL })).toMatchObject({ ok: false, status: 403 });
    expect(Number(linkRow().used_count ?? 0)).toBe(0);
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === NIKHIL)).toBe(false);

    scene("SCENE 4 — the invited address accepts");
    const accepted = await redeemInviteLink(client(), { token, redeemerUserId: PRIYA });
    shown("Priya (priya@example.com) opens it", accepted);
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === PRIYA)!;
    say(`  seat             role: ${String(seat.team_role)} · owner of record: ${String(seat.is_owner_of_record)} · houses: ${String(seat.house_scope)} · status: ${String(seat.status)}`);
    say(`  ${uses()}`);
    expect(accepted).toMatchObject({ ok: true, kind: "manager" });
    expect(seat).toMatchObject({ team_role: "property_owner", is_owner_of_record: true, workspace_id: workspaceId });
    expect(Number(linkRow().used_count ?? 0)).toBe(1);
  });

  it("refuses an unbound owner link, and a binding that cannot be read never unbinds it", async () => {
    const workspaceId = await managedWorkspace();
    await svc.inviteServiceClient(client(), ADMIN_A, { id: workspaceId, email: "Priya@Example.com", inviteeName: "Priya Nair", ownerOfRecord: true });
    const token = tokenFromEmail();

    scene("SCENE 5 — an owner link with no binding (a share link, or one from before the rule)");
    linkRow().invitee_email = null;
    shown("Priya opens the unbound link", await redeemInviteLink(client(), { token, redeemerUserId: PRIYA }));
    say(`  ${uses()} · owner-of-record seats in the workspace: ${db.tables.account_link_invites.filter((l) => l.is_owner_of_record === true).length}`);
    expect(await redeemInviteLink(client(), { token, redeemerUserId: PRIYA })).toMatchObject({
      ok: false,
      status: 403,
      error: "The owner of a PropLane Service workspace is invited from Admin › Service.",
    });
    expect(Number(linkRow().used_count ?? 0)).toBe(0);
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === PRIYA)).toBe(false);

    scene("SCENE 6 — the binding cannot be READ (statement timeout, not a missing column)");
    linkRow().invitee_email = "priya@example.com";
    const unreadable = await redeemInviteLink(bindingUnreadable(), { token, redeemerUserId: NIKHIL });
    shown("Nikhil opens it while the read is failing", unreadable);
    say(`  ${uses()} · the link is still bound to: ${String(linkRow().invitee_email)}`);
    expect(unreadable).toMatchObject({ ok: false, status: 500, error: "Could not verify this invite. Try again in a moment." });
    expect(Number(linkRow().used_count ?? 0)).toBe(0);
    expect(db.tables.account_link_invites.some((l) => l.invitee_user_id === NIKHIL)).toBe(false);
  });
  it("a new workspace share link leaves the pending Admin › Service invite alone", async () => {
    // An ordinary share link is plan-gated (the Admin › Service invite is not), so this workspace's owner is on Pro.
    const access = await import("@/lib/manager-access-server");
    vi.mocked(access.getEffectiveManagerSkuTier).mockResolvedValue({ ok: true, tier: "pro" } as never);
    const workspaceId = await managedWorkspace("2. Cedar");
    await svc.inviteServiceClient(client(), ADMIN_A, { id: workspaceId, email: "Priya@Example.com", inviteeName: "Priya Nair", ownerOfRecord: true });
    const ownerToken = tokenFromEmail();
    const ownerLink = () => db.tables.manager_invite_links.find((l) => l.invitee_email === "priya@example.com")!;

    scene("SCENE 7 — somebody makes a fresh SHARE link for the same workspace while Priya has not accepted yet");
    const share = await mintInviteLink(client(), {
      actorUserId: ADMIN_A,
      kind: "manager",
      teamRole: "maintenance",
      houseScope: "selected",
      assignedPropertyIds: ["house-a"],
      propertyPermissions: {},
      workspaceId,
      replaceActive: true,
    });
    expect(share).toMatchObject({ ok: true });
    const shareRow = db.tables.manager_invite_links.find((l) => l.team_role === "maintenance")!;
    say(`  Share sheet · Create link → a new ${String(shareRow.team_role)} link (replaces the workspace's old share link)`);
    say(`  Priya's Admin › Service invite → ${ownerLink().revoked_at ? "CANCELLED" : "still live"} (bound to ${String(ownerLink().invitee_email)})`);
    expect(ownerLink().revoked_at ?? null).toBeNull();

    scene("SCENE 8 — Priya opens the link she was emailed, after that share link was made");
    const accepted = await redeemInviteLink(client(), { token: ownerToken, redeemerUserId: PRIYA });
    shown("Priya (priya@example.com) opens it", accepted);
    const seat = db.tables.account_link_invites.find((l) => l.invitee_user_id === PRIYA && l.workspace_id === workspaceId)!;
    say(`  seat             role: ${String(seat.team_role)} · owner of record: ${String(seat.is_owner_of_record)} · status: ${String(seat.status)}`);
    expect(accepted).toMatchObject({ ok: true, kind: "manager" });
    expect(seat).toMatchObject({ team_role: "property_owner", is_owner_of_record: true });
  });
});
