import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

export type TestWorkspacePortalRole = "manager" | "co_manager" | "resident";
export type TestWorkspaceState = "active" | "suspended" | "expired";

export type TestWorkspaceClassification =
  | { kind: "normal" }
  | { kind: "classified"; workspaceId: string; role: TestWorkspacePortalRole; state: TestWorkspaceState };

export type TestWorkspaceRequestScope =
  | { kind: "normal" }
  | { kind: "active"; workspaceId: string }
  | { kind: "denied" };

/**
 * Server-side decision for authenticated product APIs. A durable test identity
 * may never fall through to the customer product when its private access is
 * disabled, suspended, or expired. Keep this separate from classification so
 * account setup, logout, and status can still identify the account correctly.
 */
export type AuthenticatedBusinessAccess =
  | { kind: "normal" }
  | { kind: "test"; workspaceId: string }
  | { kind: "denied" };

type TestWorkspaceRow = {
  workspace_id: string;
  portal_role: TestWorkspacePortalRole;
  state: "active" | "suspended";
  expires_at: string | null;
  workspace: { status: "active" | "suspended" } | null;
};

function resolvedState(row: TestWorkspaceRow): TestWorkspaceState {
  if (row.state !== "active" || row.workspace?.status !== "active") return "suspended";
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

/** Feature availability is intentionally independent from a durable classification. */
export function isTestWorkspaceFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PROPLANE_TEST_WORKSPACES_ENABLED?.trim().toLowerCase() === "true";
}

/** Resolves only a server-owned membership row. It does not consult the feature flag. */
export async function resolveTestWorkspaceClassification(
  userId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<TestWorkspaceClassification> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return { kind: "normal" };
  const { data, error } = await db
    .from("test_workspace_members")
    .select("workspace_id, portal_role, state, expires_at, workspace:test_workspaces(status)")
    .eq("user_id", normalizedUserId)
    .maybeSingle();
  if (error) throw new Error("Could not resolve test workspace classification.");
  if (!data) return { kind: "normal" };
  const row = data as unknown as TestWorkspaceRow;
  if (!row.workspace_id || !["manager", "co_manager", "resident"].includes(row.portal_role)) {
    throw new Error("Test workspace membership is invalid.");
  }
  return { kind: "classified", workspaceId: row.workspace_id, role: row.portal_role, state: resolvedState(row) };
}

export async function requireActiveTestWorkspaceActor(portalRole?: TestWorkspacePortalRole): Promise<Extract<TestWorkspaceClassification, { kind: "classified" }>> {
  if (!isTestWorkspaceFeatureEnabled()) throw new Error("Test workspace access is unavailable.");
  const session = await createSupabaseServerClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) throw new Error("Test workspace access is unavailable.");
  const classification = await resolveTestWorkspaceClassification(user.id);
  if (classification.kind !== "classified" || classification.state !== "active") {
    throw new Error("Test workspace access is unavailable.");
  }
  const roleMatches = !portalRole || classification.role === portalRole || (portalRole === "manager" && classification.role === "co_manager");
  if (!roleMatches) throw new Error("Test workspace access is unavailable.");
  return classification;
}

/** Resolve an optional signed-in request without allowing classified accounts to fall back public. */
export async function resolveTestWorkspaceRequestScope(): Promise<TestWorkspaceRequestScope> {
  const session = await createSupabaseServerClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return { kind: "normal" };
  const classification = await resolveTestWorkspaceClassification(user.id);
  if (classification.kind === "normal") return { kind: "normal" };
  if (!isTestWorkspaceFeatureEnabled() || classification.state !== "active") return { kind: "denied" };
  return { kind: "active", workspaceId: classification.workspaceId };
}

export async function resolveAuthenticatedBusinessAccess(
  userId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<AuthenticatedBusinessAccess> {
  const classification = await resolveTestWorkspaceClassification(userId, db);
  if (classification.kind === "normal") return { kind: "normal" };
  if (!isTestWorkspaceFeatureEnabled() || classification.state !== "active") return { kind: "denied" };
  return { kind: "test", workspaceId: classification.workspaceId };
}

/** Explicit-server-context gate for normal authenticated surfaces. */
export async function isTestWorkspaceActorAllowed(
  userId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<boolean> {
  return (await resolveAuthenticatedBusinessAccess(userId, db)).kind !== "denied";
}

function trustedOperatorIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.PROPLANE_TEST_WORKSPACE_OPERATOR_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

/** Existing admin authorization plus a deployment-configured UUID allowlist. */
export async function requireTrustedTestWorkspaceOperator(): Promise<{ userId: string }> {
  const session = await createSupabaseServerClient();
  const { data: { user } } = await session.auth.getUser();
  if (
    !user ||
    !trustedOperatorIds().has(user.id) ||
    isPortalSandboxEmail(user.email) ||
    !(await isAdminUser(user.id))
  ) {
    throw new Error("Test workspace access is unavailable.");
  }
  const classification = await resolveTestWorkspaceClassification(user.id);
  if (classification.kind !== "normal") throw new Error("Test workspace access is unavailable.");
  return { userId: user.id };
}

export function assertSameTestWorkspace(
  expectedWorkspaceId: string,
  classification: TestWorkspaceClassification,
): Extract<TestWorkspaceClassification, { kind: "classified" }> {
  if (classification.kind !== "classified" || classification.workspaceId !== expectedWorkspaceId) {
    throw new Error("Test workspace access is unavailable.");
  }
  return classification;
}

/** Reads a record's durable provenance with no caller-supplied workspace filter. */
export async function lookupRecordTestWorkspaceId(
  table: string,
  recordId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<string | null> {
  if (!table || !recordId) throw new Error("Test workspace access is unavailable.");
  const { data, error } = await db.from(table).select("test_workspace_id").eq("id", recordId).maybeSingle();
  if (error) throw new Error("Test workspace access is unavailable.");
  return (data as { test_workspace_id?: string | null } | null)?.test_workspace_id ?? null;
}

export async function assertRecordInTestWorkspace(
  table: string,
  recordId: string,
  workspaceId: string,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<void> {
  if (!workspaceId || await lookupRecordTestWorkspaceId(table, recordId, db) !== workspaceId) {
    throw new Error("Test workspace access is unavailable.");
  }
}

/**
 * Refuses relationships between the durable test domain and customer accounts,
 * or between two different test workspaces. Email-only contacts without a
 * profile are allowed because they have no portal data access; provider effects
 * are captured separately at their owner boundary.
 */
export async function assertTestWorkspacePrincipalCompatibility(args: {
  actorUserId: string;
  relatedUserIds?: Array<string | null | undefined>;
  relatedEmails?: Array<string | null | undefined>;
  db?: SupabaseClient;
}): Promise<void> {
  const db = args.db ?? createSupabaseServiceRoleClient();
  const actor = await resolveTestWorkspaceClassification(args.actorUserId, db);
  const ids = new Set(
    (args.relatedUserIds ?? []).map((id) => id?.trim() ?? "").filter(Boolean),
  );
  const emails = [...new Set(
    (args.relatedEmails ?? []).map((email) => email?.trim().toLowerCase() ?? "").filter(Boolean),
  )];
  if (emails.length > 0) {
    const { data, error } = await db.from("profiles").select("id,email").in("email", emails);
    if (error) throw new Error("Could not verify test workspace relationship.");
    for (const profile of data ?? []) {
      if (profile.id) ids.add(String(profile.id));
    }
  }
  for (const id of ids) {
    const related = await resolveTestWorkspaceClassification(id, db);
    if (actor.kind === "normal") {
      if (related.kind === "classified") throw new Error("Cross-workspace relationship refused.");
      continue;
    }
    if (related.kind !== "classified" || related.workspaceId !== actor.workspaceId) {
      throw new Error("Cross-workspace relationship refused.");
    }
  }
}
