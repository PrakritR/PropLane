import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { signupProofEnvironment, allUsers, rows, type SignupProofManifest } from "../../helpers/signup-proof-e2e";

const delivery = vi.hoisted(() => ({ actor: "", phone: "", code: "", sends: 0 }));
vi.mock("@/lib/auth/phone-otp-delivery.server", async () => {
  const { assertDelivery } = await import("../../helpers/signup-proof-guards");
  const { currentSmsTestTransport, captureSmsTestDelivery } = await import("@/lib/sms/sms-test-transport.server");
  return { sendPhoneAuthCode: async (phone: string, code: string, actor: string) => {
    const context = currentSmsTestTransport();
    assertDelivery(delivery.actor, delivery.phone, actor, phone, context, delivery.sends);
    delivery.code = code;
    delivery.sends++;
    return captureSmsTestDelivery({ kind: "sms", status: "captured", summary: "Synthetic phone proof; no provider delivery." });
  } };
});
import { assertActor, assertManifest, assertProfile, assertPurchase, assertRoles, assertWorkspace, assertPhoneAvailability } from "../../helpers/signup-proof-guards";
import { runWithSmsTestTransport } from "@/lib/sms/sms-test-transport.server";
import { phoneBrowserHash, phoneOwners, phoneVerificationEnabled, startPhoneChallenge, verifyPhoneChallenge } from "@/lib/auth/phone-auth.server";

it("binds the exact new signup through the real phone challenge", async () => {
  const { db, dir } = signupProofEnvironment();
  const file = process.env.SIGNUP_PROOF_MANIFEST;
  if (!file || !path.isAbsolute(file) || path.dirname(file) !== dir || !/^p8-[a-f0-9]{32}\.manifest\.json$/.test(path.basename(file)) || realpathSync(file) !== file || !lstatSync(file).isFile() || (lstatSync(file).mode & 0o777) !== 0o600) throw new Error("Private proof manifest refused.");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as SignupProofManifest;
  const nonce = path.basename(file).slice(3, 35);
  assertManifest(manifest, nonce);
  const actor = manifest.actorId;
  const userResult = await db.auth.admin.getUserById(actor);
  const user = userResult.data.user;
  if (userResult.error) throw new Error("New verified signup identity unavailable.");
  assertActor(manifest, user);
  const profile = await db.from("profiles").select("id,email,full_name,phone,phone_verified_at,manager_id").eq("id", actor).single();
  if (profile.error || !profile.data) throw new Error("New signup profile unavailable.");
  assertProfile(manifest, profile.data);
  const roles = await db.from("profile_roles").select("role").eq("user_id", actor);
  if (roles.error || !roles.data) throw new Error("New signup roles unavailable.");
  assertRoles(manifest, roles.data);
  if (manifest.tier === "pro") {
    if (!profile.data.manager_id) throw new Error("Manager identity unavailable.");
    const peers = await db.from("profiles").select("id").eq("manager_id", profile.data.manager_id);
    if (peers.error || !peers.data) throw new Error("Manager ownership unavailable.");
    const purchases = await db.from("manager_purchases").select("user_id,email,manager_id,tier,billing,stripe_checkout_session_id,stripe_subscription_id").eq("manager_id", profile.data.manager_id);
    if (purchases.error || !purchases.data) throw new Error("Manager purchase unavailable.");
    assertPurchase(manifest, profile.data.manager_id, purchases.data, peers.data);
  } else {
    const purchases = await db.from("manager_purchases").select("id").or(`user_id.eq.${actor},email.eq.${manifest.email}`);
    if (purchases.error || !purchases.data) throw new Error("Resident purchase unavailable.");
    assertPurchase(manifest, null, purchases.data as never[], []);
  }
  const owned = await db.from("portal_workspaces").select("id,owner_user_id,created_at").eq("owner_user_id", actor);
  const links = await db.from("account_link_invites").select("id").or(`inviter_user_id.eq.${actor},invitee_user_id.eq.${actor}`);
  const testMembership = await db.from("test_workspace_members").select("id").eq("user_id", actor);
  const ownedIds = (owned.data ?? []).map((workspace) => workspace.id);
  const foreignWorkspaceLinks = ownedIds.length ? await db.from("account_link_invites").select("id").in("workspace_id", ownedIds) : { data: [], error: null };
  const testOwned = await db.from("test_workspaces").select("id").eq("created_by_user_id", actor);
  if (owned.error || links.error || testMembership.error || foreignWorkspaceLinks.error || testOwned.error || !owned.data || !links.data || !testMembership.data || !foreignWorkspaceLinks.data || !testOwned.data) throw new Error("Workspace boundary unavailable.");
  assertWorkspace(manifest, owned.data, foreignWorkspaceLinks.data.length, links.data.length, testMembership.data.length, testOwned.data.length);
  const phoneEnabled = await phoneVerificationEnabled(db);
  const allAuth = await allUsers(db);
  const foreignAuth = allAuth.some((item) => item.id !== actor && item.phone?.replace(/\D/g, "") === manifest.phone.slice(1));
  let foreignProfiles = false;
  for (let offset = 0; offset < 100_000; offset += 1000) {
    const batch = await rows(db.from("profiles").select("id,phone").range(offset, offset + 999));
    foreignProfiles ||= batch.some((item) => item.id !== actor && [manifest.phone.slice(1), manifest.phone.slice(2)].includes(String(item.phone ?? "").replace(/\D/g, "")));
    if (batch.length < 1000) break;
    if (offset === 99_000) throw new Error("Phone preflight pagination exceeded its bound.");
  }
  const owners = await phoneOwners(db, manifest.phone);
  const contacts = await db.from("sms_phone_contacts").select("phone_e164").eq("phone_e164", manifest.phone);
  if (contacts.error || !contacts.data) throw new Error("Phone association unavailable.");
  assertPhoneAvailability(phoneEnabled, owners.length, contacts.data.length, foreignAuth, foreignProfiles);
  delivery.actor = actor; delivery.phone = manifest.phone;
  const browser = randomBytes(32).toString("hex");
  try {
    const captured = await runWithSmsTestTransport({ actorUserId: actor, managerUserId: actor }, async () => {
      const challenge = await startPhoneChallenge({ db, userId: actor, browser, phone: manifest.phone, purpose: "verify_phone" });
      if (!/^\d{6}$/.test(delivery.code)) throw new Error("Synthetic delivery missing.");
      const result = await verifyPhoneChallenge({ db, userId: actor, browser, challengeId: challenge.challengeId, code: delivery.code });
      const row = await db.from("phone_otp_challenges").select("auth_user_id,browser_hash,auth_provider,consumed_at").eq("id", challenge.challengeId).single();
      if (row.error || row.data?.auth_user_id !== actor || row.data?.browser_hash !== phoneBrowserHash(browser) || row.data?.auth_provider !== "local" || !row.data?.consumed_at) throw new Error("Phone challenge readback refused.");
      return result;
    });
    expect(captured.result).toEqual({ ok: true });
    expect(delivery.sends).toBe(1);
    expect(captured.effects).toHaveLength(1);
    const finalOwners = await phoneOwners(db, manifest.phone);
    const saved = await db.from("profiles").select("phone,phone_verified_at").eq("id", actor).single();
    const auth = await db.auth.admin.getUserById(actor);
    if (finalOwners.length !== 1 || finalOwners[0] !== actor || saved.error || saved.data?.phone !== manifest.phone || !saved.data?.phone_verified_at || auth.error || !auth.data.user?.phone_confirmed_at || auth.data.user.phone?.replace(/\D/g, "") !== manifest.phone.slice(1)) throw new Error("Phone binding readback refused.");
  } finally { delivery.code = ""; delivery.actor = ""; delivery.phone = ""; }
});
