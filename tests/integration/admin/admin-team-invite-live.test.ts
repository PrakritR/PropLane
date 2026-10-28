/**
 * Opt-in rehearsal of the whole Admin team invite chain against a REAL dev/test Supabase project, because every other
 * suite for it runs on a fake database and so can never prove that the migration behind it
 * (`20261027120000_admin_team`: `kind = 'admin'`, `manager_invite_links.admin_grant`, `admin_team_grants`) actually
 * carries the flow:
 *
 *   invite (Overall admin)  ->  emailed 6-digit code  ->  account created, confirmed and stamped with the proof
 *                           ->  redeem  ->  the grant is really held  ->  the person shows on the Admin team list.
 *
 * It also pins the two refusals that make the code load-bearing: an account that skipped the code cannot redeem, and a
 * wrong code is rejected.
 *
 * Skipped unless `ADMIN_TEAM_LIVE_DB=1`, and it refuses to run against anything but the dev/test project, so CI and a
 * plain `npm run test:unit` are untouched. Run it with:
 *
 *   ADMIN_TEAM_LIVE_DB=1 npx vitest run tests/integration/admin/admin-team-invite-live.test.ts
 *
 * The provider boundary (`postResendEmail`) is the only thing mocked: the test reads the code out of the email body
 * exactly as the invitee would read it out of their inbox, and nothing is actually sent.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import dotenv from "dotenv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The worktree's `.env.local` holds multi-line secrets, so it is loaded here rather than through a shell `export`.
dotenv.config({ path: path.resolve(__dirname, "../../../.env.local"), override: false, quiet: true });

const DEV_TEST_PROJECT_REF = "emstjswhotsnyksqhqyf";
const enabled = process.env.ADMIN_TEAM_LIVE_DB === "1";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (enabled && !url.includes(DEV_TEST_PROJECT_REF)) {
  throw new Error(`ADMIN_TEAM_LIVE_DB only runs against the dev/test project (${DEV_TEST_PROJECT_REF}).`);
}

/** Every email the chain "sends", newest last. The 6-digit code is read from here, never from the database. */
const outbox: { to: string[]; subject: string; text: string }[] = [];

/** The rehearsal is run by hand, so it narrates what really happened on the database as it goes. */
const note = (line: string) => {
  console.log(`  · ${line}`);
};

vi.mock("@/lib/resend-delivery.server", () => ({
  postResendEmail: async (args: { payload: { to: string[]; subject: string; text: string } }) => {
    outbox.push({ to: args.payload.to, subject: args.payload.subject, text: args.payload.text });
    return new Response(JSON.stringify({ id: "live-test-captured" }), { status: 200 });
  },
}));

const suite = enabled ? describe : describe.skip;

suite("Admin team invite, end to end on the dev/test database", () => {
  // Creating an auth user plus the invite round-trip is several real network calls.
  vi.setConfig({ testTimeout: 120_000 });

  let db: import("@supabase/supabase-js").SupabaseClient;
  let inviter: { id: string };
  const cleanupUserIds: string[] = [];
  const cleanupLinkIds: string[] = [];

  beforeAll(async () => {
    process.env.RESEND_API_KEY ??= "live-test-not-used";
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(url, serviceKey, { auth: { persistSession: false } });

    // The inviter must be a real Overall admin: the grant is re-derived from `profile_roles` at both ends.
    const { data } = await db.from("profile_roles").select("user_id").eq("role", "admin").limit(1);
    const found = (data ?? [])[0] as { user_id?: string } | undefined;
    if (!found?.user_id) throw new Error("No Overall admin in the dev/test project to invite as.");
    inviter = { id: String(found.user_id) };
  });

  afterAll(async () => {
    for (const id of cleanupUserIds) {
      await db.from("admin_team_grants").delete().eq("user_id", id);
      await db.from("profile_roles").delete().eq("user_id", id);
      await db.from("profiles").delete().eq("id", id);
      await db.auth.admin.deleteUser(id).catch(() => null);
    }
    for (const id of cleanupLinkIds) {
      await db.from("manager_invite_link_redemptions").delete().eq("link_id", id);
      await db.from("manager_invite_links").delete().eq("id", id);
    }
  });

  async function inviteOverallAdmin(email: string): Promise<{ inviteId: string; token: string }> {
    const { inviteAdminTeamMember } = await import("@/lib/admin-team/admin-team-invite.server");
    const { resolveAdminTeamActor } = await import("@/lib/admin-team/admin-team.server");
    const actor = await resolveAdminTeamActor(db, inviter.id);
    const result = await inviteAdminTeamMember(db, inviter.id, actor, {
      email,
      role: "overall_admin",
      workspaceIds: [],
      access: null,
    });
    if (!result.ok) throw new Error(`invite refused: ${result.error}`);
    cleanupLinkIds.push(result.inviteId);
    // The accept URL is the only place the token exists outside the hash on the row — exactly like the real invitee.
    const link = outbox.at(-1)?.text.match(/https?:\/\/\S*\/invite\/([A-Za-z0-9_-]+)/);
    if (!link) throw new Error(`no invite link in the email: ${outbox.at(-1)?.text}`);
    return { inviteId: result.inviteId, token: link[1]! };
  }

  it("mints an email-bound admin link, proves the inbox with a code, and grants on redeem", async () => {
    const email = `nm-admin-invite-${randomUUID().slice(0, 8)}@nm-proof.invalid`;
    const { inviteId, token } = await inviteOverallAdmin(email);

    // 1. The row the migration made possible: kind `admin`, one use, bound to the address, carrying the grant.
    const { data: row } = await db
      .from("manager_invite_links")
      .select("kind, invitee_email, max_uses, used_count, admin_grant")
      .eq("id", inviteId)
      .maybeSingle();
    expect(row).toMatchObject({ kind: "admin", invitee_email: email, max_uses: 1, used_count: 0 });
    expect((row as { admin_grant: { role: string } }).admin_grant.role).toBe("overall_admin");
    note(`invite row ${inviteId}: kind=admin, invitee_email=${email}, max_uses=1, admin_grant.role=overall_admin`);

    // 2. The invite page shows an Overall admin invite before anyone signs in.
    const { previewInviteLink } = await import("@/lib/invite-links/invite-links.server");
    const preview = await previewInviteLink(db, token);
    expect(preview?.kind).toBe("admin");
    note(`/invite/<token> preview: kind=${preview?.kind}`);

    // 3. The emailed code — read from the email body, which is all the invitee has.
    const { sendAdminInviteCode, createVerifiedAdminAccount } = await import("@/lib/admin-team/admin-invite-proof.server");
    const challenge = await sendAdminInviteCode(db, { token });
    if (!challenge.ok) throw new Error(`code refused: ${challenge.error}`);
    const codeMail = outbox.at(-1)!;
    expect(codeMail.to).toEqual([email]);
    expect(codeMail.subject).toBe("Your PropLane admin code");
    const code = codeMail.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    note(`emailed to ${codeMail.to.join(", ")} — "${codeMail.subject}": ${codeMail.text.split("\n")[2]}`);

    // 4. A wrong code creates nothing.
    const wrong = await createVerifiedAdminAccount(db, {
      token,
      challenge: challenge.challenge,
      code: code === "000000" ? "000001" : "000000",
      fullName: "Nm Proof",
      phone: "",
      password: "NmProofPassword123!",
    });
    expect(wrong.ok).toBe(false);
    note(`a wrong code is refused: ${(wrong as { error: string }).error}`);

    // 5. The right code creates the confirmed account, stamped with the proof the redeem demands.
    const created = await createVerifiedAdminAccount(db, {
      token,
      challenge: challenge.challenge,
      code: code!,
      fullName: "Nm Proof",
      phone: "",
      password: "NmProofPassword123!",
    });
    expect(created).toMatchObject({ ok: true, email });

    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    const account = list.users.find((u) => (u.email ?? "").toLowerCase() === email);
    expect(account, "the code created the account").toBeTruthy();
    cleanupUserIds.push(account!.id);
    expect(account!.email_confirmed_at).toBeTruthy();
    expect((account!.app_metadata as { admin_invite_proof?: string }).admin_invite_proof).toBe(inviteId);
    note(`account ${account!.id} created, email_confirmed_at set, app_metadata.admin_invite_proof=${inviteId}`);

    // 6. Redeeming grants Overall admin for real.
    const { redeemInviteLink } = await import("@/lib/invite-links/invite-links.server");
    const redeemed = await redeemInviteLink(db, { token, redeemerUserId: account!.id });
    expect(redeemed.ok, "redeem" + (redeemed.ok ? "" : `: ${redeemed.error}`)).toBe(true);

    const { data: roles } = await db.from("profile_roles").select("role").eq("user_id", account!.id);
    expect((roles ?? []).map((r) => (r as { role: string }).role)).toContain("admin");

    const { data: grants } = await db
      .from("admin_team_grants")
      .select("role, granted_by, revoked_at")
      .eq("user_id", account!.id);
    expect(grants).toEqual([{ role: "overall_admin", granted_by: inviter.id, revoked_at: null }]);
    note(`after redeem: profile_roles has admin, admin_team_grants row role=overall_admin granted_by=${inviter.id}`);

    // 7. And the person now shows on the Admin team list the pane reads.
    const { listAdminTeam, resolveAdminTeamActor } = await import("@/lib/admin-team/admin-team.server");
    const actor = await resolveAdminTeamActor(db, inviter.id);
    const team = await listAdminTeam(db, inviter.id, actor);
    if (!team.ok) throw new Error(team.error);
    const member = team.payload.members.find((m) => m.userId === account!.id);
    expect(member).toMatchObject({ role: "overall_admin", state: "active" });
    note(`Admin team list now shows "${member?.name}" as ${member?.role} (${member?.state})`);

    // 8. The link is spent: a second redeem cannot take the grant again.
    const { data: after } = await db.from("manager_invite_links").select("used_count").eq("id", inviteId).maybeSingle();
    expect((after as { used_count: number }).used_count).toBe(1);
  });

  it("refuses an account that never proved the invited inbox", async () => {
    const email = `nm-admin-unproven-${randomUUID().slice(0, 8)}@nm-proof.invalid`;
    const { token } = await inviteOverallAdmin(email);

    // The same address, but signed up the ordinary way: confirmed without an inbox round-trip and with no proof stamp.
    const { data: made, error } = await db.auth.admin.createUser({ email, password: "NmProofPassword123!", email_confirm: true });
    if (error) throw error;
    cleanupUserIds.push(made.user.id);

    const { redeemInviteLink, ADMIN_EMAIL_UNPROVEN_ERROR } = await import("@/lib/invite-links/invite-links.server");
    const redeemed = await redeemInviteLink(db, { token, redeemerUserId: made.user.id });
    expect(redeemed).toMatchObject({ ok: false, status: 403, error: ADMIN_EMAIL_UNPROVEN_ERROR });
    note(`an unproven account redeeming: 403 — ${ADMIN_EMAIL_UNPROVEN_ERROR}`);

    const { data: roles } = await db.from("profile_roles").select("role").eq("user_id", made.user.id);
    expect((roles ?? []).map((r) => (r as { role: string }).role)).not.toContain("admin");
  });
});
