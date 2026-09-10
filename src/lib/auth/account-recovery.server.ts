import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { accountArchiveRules, ACCOUNT_RECOVERABLE_TABLES, ACCOUNT_RECOVERY_PATH, normalizeRecoveryPortal } from "@/lib/auth/account-recovery-policy";
import { isMissingAccountRecoveryTableError } from "@/lib/auth/account-recovery-schema";
import { cancelActiveManagerSubscription } from "@/lib/auth/delete-portal-account";
import { purgeManagerPortalData, purgeResidentPortalData, purgeVendorPortalData } from "@/lib/auth/purge-portal-account-data";
import { purgeSharedAccountAttachments } from "@/lib/auth/purge-shared-account-attachments";
import { retainRecoveryObject, withAccountRecoveryStorage, type RecoveryObject } from "@/lib/auth/account-recovery-storage";
import { closeRelayThreadsForUser } from "@/lib/sms-relay.server";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

type Scope = "manager" | "resident" | "vendor";
export type RecoveryRequest = {
  id: string; user_id: string; email: string; portal: Scope;
  state: "archiving" | "retained" | "recovering" | "purging" | "restored" | "discarded";
  expires_at: string; decision: "recover" | "fresh" | "expire" | null; claim_id: string | null;
  plan: { complete: boolean; scopes?: Scope[] }; attempts: number;
};
const COLUMNS = "id,user_id,email,portal,state,expires_at,decision,claim_id,plan,attempts";
function check(error: { message: string } | null) { if (error) throw new Error(error.message); }
export const hashRecoveryToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function pendingAccountRecovery(
  db: SupabaseClient,
  userId: string,
  portal?: string,
  options: { requireSchema?: boolean } = {},
): Promise<RecoveryRequest | null> {
  let query = db.from("account_recovery_requests").select(COLUMNS).eq("user_id", userId)
    .in("state", ["archiving", "retained", "recovering", "purging"]).order("created_at").limit(1);
  if (portal) {
    const scope = normalizeRecoveryPortal(portal);
    if (!scope) return null;
    query = query.eq("portal", scope);
  }
  const { data, error } = await query.maybeSingle();
  // Recovery ships separately from its schema. An environment without this
  // table cannot contain retained accounts, so ordinary sign-in may continue.
  // Do not swallow missing columns, permission errors, or transport failures.
  // Deletion opts out before subscription cancellation or any other side effect.
  if (isMissingAccountRecoveryTableError(error) && !options.requireSchema) return null;
  check(error);
  return data as RecoveryRequest | null;
}

export async function recoverySetupRedirect(db: SupabaseClient, userId: string, portal?: string): Promise<string | null> {
  const request = await pendingAccountRecovery(db, userId, portal);
  return request ? `${ACCOUNT_RECOVERY_PATH}?portal=${request.portal}` : null;
}

/** Retains the original Auth UUID as a login-only shell; no data is auto-restored. */
export async function schedulePortalAccountDeletion(db: SupabaseClient, userId: string, portal: string) {
  const scope = normalizeRecoveryPortal(portal);
  if (!scope) throw new Error("This portal does not support personal account recovery.");
  const [{ data: identity, error: identityError }, { data: profile, error: profileError }, { data: roleRows, error: roleError }] = await Promise.all([
    db.auth.admin.getUserById(userId), db.from("profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", userId),
  ]);
  check(identityError); check(profileError); check(roleError);
  const email = identity.user?.email?.trim().toLowerCase();
  if (!email) throw new Error("Account identity is unavailable.");
  const roles = [...new Set([String(profile?.role ?? ""), ...(roleRows ?? []).map(row => String(row.role))].filter(Boolean))];
  const remaining = roles.filter(role => normalizeRecoveryPortal(role) !== scope);
  let request = await pendingAccountRecovery(db, userId, scope, { requireSchema: true });
  if (request && request.email !== email) throw new Error("Account identity changed during deletion.");
  if (!request && !roles.some(role => normalizeRecoveryPortal(role) === scope)) throw new Error("This account does not have access to that portal.");
  const complete = request?.plan.complete ?? remaining.length === 0;
  if (!request || request.state === "archiving") {
    if (scope === "manager" || complete) await cancelActiveManagerSubscription(db, userId);
    if (complete) await closeRelayThreadsForUser(db, userId);
    else if (scope !== "vendor") await closeRelayThreadsForUser(db, userId, scope);
    const { data: otherRequests, error: otherError } = await db.from("account_recovery_requests")
      .select("portal").eq("user_id", userId).neq("portal", scope)
      .in("state", ["archiving", "retained", "recovering", "purging"]);
    check(otherError);
    const previouslyDeleted = new Set((otherRequests ?? []).map(row => row.portal));
    const scopes: Scope[] = request?.plan.scopes ?? (complete ? [scope, ...(["manager", "resident", "vendor"] as Scope[])
      .filter(role => role !== scope && !previouslyDeleted.has(role))] : [scope]);
    const { data: id, error } = await db.rpc("account_recovery_begin", {
      p_user: userId, p_portal: scope, p_profile: profile ?? {},
      p_plan: { complete, scopes, rules: scopes.flatMap(role => accountArchiveRules(role, complete)), recoverableTables: ACCOUNT_RECOVERABLE_TABLES },
    }); check(error);
    request = await pendingAccountRecovery(db, userId, scope, { requireSchema: true });
    if (!request || request.id !== id) throw new Error("Retention request is unavailable.");
    const requestId = request.id;
    const mappedObjects = await loadAccountCleanupRows<{ object: RecoveryObject }>((from, to) => db.from("account_recovery_object_holds")
      .select("object:account_recovery_objects(*)").eq("request_id", requestId).order("object_id").range(from, to).returns<{ object: RecoveryObject }[]>());
    for (const { object } of mappedObjects) {
      if (object.state === "active" || object.state === "copying") await retainRecoveryObject(db, requestId, object.bucket, object.logical_path);
    }
    const retainedDb = withAccountRecoveryStorage(db, request.id);
    for (const role of scopes) {
      if (role === "manager") await purgeManagerPortalData(retainedDb, userId, complete, email);
      else if (role === "resident") await purgeResidentPortalData(retainedDb, { userId, email, complete });
      else await purgeVendorPortalData(retainedDb, { userId, email, complete });
    }
    if (complete) await purgeSharedAccountAttachments(retainedDb, userId);
    check((await db.rpc("account_recovery_finish_archival", { p_request: request.id })).error);
  }
  if (request.state !== "archiving" && request.state !== "retained") throw new Error("Account cleanup is already processing.");
  const nextRole = remaining.map(normalizeRecoveryPortal).find(Boolean);
  return { ok: true, mode: "scheduled_deletion", signedOut: complete,
    redirectTo: remaining.includes("admin") ? portalDashboardPath("admin") : nextRole ? portalDashboardPath(nextRole) : "/auth/sign-in?deleted=1", recoverUntil: request.expires_at };
}

export async function sendAccountRecoveryChallenge(db: SupabaseClient, userId: string, portal?: string) {
  const request = await pendingAccountRecovery(db, userId, portal);
  if (!request || request.state !== "retained" || Date.parse(request.expires_at) <= Date.now()) throw new Error("No recoverable data is available.");
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Recovery email is unavailable. Please try again later.");
  const token = randomBytes(32).toString("base64url");
  const { data, error } = await db.rpc("account_recovery_issue_challenge", { p_request: request.id, p_user: userId, p_hash: hashRecoveryToken(token) });
  check(error); if (!data) throw new Error("Please wait a minute before requesting another link.");
  const link = new URL(ACCOUNT_RECOVERY_PATH, resolveEmailLinkBaseUrl());
  link.searchParams.set("portal", request.portal);
  link.hash = new URLSearchParams({ request: request.id, token }).toString();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>", to: [request.email],
      subject: "Choose what happens to your saved PropLane data",
      text: `Verify your email to recover your saved ${request.portal} data or permanently delete it and start fresh.\n\n${link}\n\nThis link expires in 15 minutes. Opening it does not change your account. Your recovery window ends ${request.expires_at}.`,
    }),
  });
  if (!response.ok) throw new Error("We couldn't send the recovery email. Please try again.");
  return { sent: true };
}

async function purgeRetainedRequest(db: SupabaseClient, request: Pick<RecoveryRequest, "id" | "claim_id">) {
  const { data, error } = await db.rpc("account_recovery_prepare_object_purge", { p_request: request.id, p_claim: request.claim_id }); check(error);
  for (const object of (data ?? []) as RecoveryObject[]) {
    check((await db.storage.from("account-recovery").remove([object.private_path])).error);
    const result = await db.rpc("account_recovery_finish_object_purge", { p_object: object.id, p_generation: object.generation }); check(result.error);
    if (!result.data) throw new Error("File cleanup generation changed.");
  }
  check((await db.rpc("account_recovery_finish_purge", { p_request: request.id, p_claim: request.claim_id })).error);
}

export async function chooseAccountRecovery(db: SupabaseClient, userId: string, requestId: string, token: string, choice: "recover" | "fresh") {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Recovery link is invalid.");
  const hash = hashRecoveryToken(token);
  if (choice === "recover") {
    const { data, error } = await db.rpc("account_recovery_recover", { p_request: requestId, p_user: userId, p_hash: hash }); check(error);
    return { ok: true, ...data, redirectTo: data.portal === "manager" ? "/auth/manager/choose-plan" : portalDashboardPath(data.portal) };
  }
  const { data: claim, error } = await db.rpc("account_recovery_choose", { p_request: requestId, p_user: userId, p_hash: hash, p_choice: "fresh" }); check(error);
  await purgeRetainedRequest(db, { id: requestId, claim_id: claim });
  const { data: identity } = await db.auth.admin.getUserById(userId);
  return { ok: true, signedOut: !identity.user, redirectTo: "/auth/get-started" };
}

/** Expiry and interrupted cleanup share the same persisted intent and claim. */
export async function processAccountDeletionQueue(db: SupabaseClient) {
  const { data: unfinished, error: unfinishedError } = await db.from("account_recovery_requests").select(COLUMNS)
    .in("state", ["archiving", "purging"]).lte("next_attempt_at", new Date().toISOString()).order("attempts").order("next_attempt_at").limit(20);
  check(unfinishedError);
  const failures: string[] = [];
  async function failed(request: RecoveryRequest) {
    failures.push(request.id);
    const attempts = (request.attempts ?? 0) + 1;
    check((await db.from("account_recovery_requests").update({ attempts,
      next_attempt_at: new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000).toISOString(),
    }).eq("id", request.id).in("state", ["archiving", "purging"])).error);
  }
  for (const request of (unfinished ?? []) as RecoveryRequest[]) {
    try {
      if (request.state === "archiving") await schedulePortalAccountDeletion(db, request.user_id, request.portal);
      else await purgeRetainedRequest(db, request);
    } catch { await failed(request); }
  }
  const { data: expired, error } = await db.rpc("account_recovery_claim_expired", { p_limit: 20 }); check(error);
  let purged = 0;
  for (const request of (expired ?? []) as RecoveryRequest[]) {
    try { await purgeRetainedRequest(db, request); purged++; } catch { await failed(request); }
  }
  // Ordinary deletion of a recovered file has durable object-level intent,
  // independent of whether its old account recovery request is already complete.
  const { data: pendingObjects, error: objectError } = await db.from("account_recovery_objects")
    .select("id,generation,private_path").eq("state", "purging").order("cleanup_attempt_at").limit(100);
  check(objectError);
  for (const object of pendingObjects ?? []) {
    try {
      check((await db.from("account_recovery_objects").update({ cleanup_attempt_at: new Date().toISOString() })
        .eq("id", object.id).eq("generation", object.generation).eq("state", "purging")).error);
      check((await db.storage.from("account-recovery").remove([object.private_path])).error);
      const finished = await db.rpc("account_recovery_finish_object_purge", { p_object: object.id, p_generation: object.generation });
      check(finished.error);
      if (!finished.data) throw new Error("File cleanup generation changed.");
    } catch { failures.push(object.id); }
  }
  // Old private keys remain on a rotating sweep so a delayed external copy
  // cannot become an uncollected orphan after its original cleanup succeeded.
  const { data: retired, error: retiredError } = await db.from("account_recovery_retired_objects")
    .select("private_path").order("last_swept_at").limit(100);
  check(retiredError);
  const paths = (retired ?? []).map(row => String(row.private_path));
  if (paths.length) {
    check((await db.storage.from("account-recovery").remove(paths)).error);
    check((await db.from("account_recovery_retired_objects").update({ last_swept_at: new Date().toISOString() }).in("private_path", paths)).error);
  }
  check((await db.rpc("account_recovery_compact_terminal")).error);
  return { purged, failed: [...new Set(failures)].length };
}
