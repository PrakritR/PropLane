import { NextResponse } from "next/server";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import {
  isTestWorkspaceFeatureEnabled,
  requireTrustedTestWorkspaceOperator,
  type TestWorkspacePortalRole,
} from "@/lib/test-workspaces/index.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { deliverTestWorkspaceAuthInvitation } from "@/lib/test-workspaces/deliver-auth-invite.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };
const DENIAL = { error: "Not found." };
const PORTAL_ROLES = new Set<TestWorkspacePortalRole>(["manager", "co_manager", "resident"]);

function json(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, { ...init, headers: { ...PRIVATE_HEADERS, ...(init?.headers ?? {}) } });
}

async function requireOperator(): Promise<{ userId: string } | null> {
  if (!isTestWorkspaceFeatureEnabled()) return null;
  try {
    return await requireTrustedTestWorkspaceOperator();
  } catch {
    return null;
  }
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizedName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 120 ? name : null;
}

function normalizedExpiry(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant > Date.now() ? new Date(instant).toISOString() : undefined;
}

async function findAuthUserIdByEmail(email: string): Promise<string | null> {
  const db = createSupabaseServiceRoleClient();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Could not check account identity.");
    const match = data.users.find((user) => user.email?.trim().toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

async function audit(db: ReturnType<typeof createSupabaseServiceRoleClient>, actorUserId: string, workspaceId: string, action: string, summary: Record<string, unknown>) {
  const { error } = await db.from("audit_log").insert({
    actor_user_id: actorUserId,
    landlord_id: actorUserId,
    action,
    tool_name: "test_workspace_admin",
    input_summary: summary,
    result_summary: { outcome: "completed", workspaceId },
    test_workspace_id: workspaceId,
  });
  if (error) throw new Error("Could not record test workspace audit event.");
}

export async function GET() {
  const operator = await requireOperator();
  if (!operator) return json(DENIAL, { status: 404 });
  try {
    const db = createSupabaseServiceRoleClient();
    const { data: workspaces, error } = await db
      .from("test_workspaces")
      .select("id,name,status,created_at,test_workspace_members(id,user_id,portal_role,state,expires_at,created_at)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const memberIds = [...new Set((workspaces ?? []).flatMap((workspace) =>
      ((workspace.test_workspace_members ?? []) as { user_id: string }[]).map((member) => member.user_id),
    ))];
    const { data: profiles, error: profilesError } = memberIds.length
      ? await db.from("profiles").select("id,email,full_name").in("id", memberIds)
      : { data: [], error: null };
    if (profilesError) throw profilesError;
    const profilesById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    return json({
      workspaces: (workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        createdAt: workspace.created_at,
        members: ((workspace.test_workspace_members ?? []) as Array<{ id: string; user_id: string; portal_role: TestWorkspacePortalRole; state: string; expires_at: string | null; created_at: string }>).map((member) => {
          const profile = profilesById.get(member.user_id);
          return {
            id: member.id,
            userId: member.user_id,
            email: profile?.email ?? null,
            fullName: profile?.full_name ?? null,
            role: member.portal_role,
            state: member.state,
            expiresAt: member.expires_at,
            createdAt: member.created_at,
          };
        }),
      })),
    });
  } catch (error) {
    console.error("[admin/test-workspaces] list failed", error);
    return json({ error: "Could not load test workspaces." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const operator = await requireOperator();
  if (!operator) return json(DENIAL, { status: 404 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const db = createSupabaseServiceRoleClient();
    if (body.action === "create_workspace") {
      const name = normalizedName(body.name);
      if (!name) return json({ error: "A workspace name is required." }, { status: 400 });
      const { data: workspace, error } = await db.from("test_workspaces")
        .insert({ name, created_by_user_id: operator.userId }).select("id,name,status,created_at").single();
      if (error || !workspace) throw error ?? new Error("Workspace was not created.");
      await audit(db, operator.userId, workspace.id, "test_workspace_created", { workspaceId: workspace.id });
      return json({ workspace: { id: workspace.id, name: workspace.name, status: workspace.status, createdAt: workspace.created_at, members: [] } }, { status: 201 });
    }
    if (body.action !== "invite_member") return json({ error: "Unsupported action." }, { status: 400 });
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    const email = normalizedEmail(body.email);
    const fullName = normalizedName(body.fullName);
    const role = typeof body.role === "string" && PORTAL_ROLES.has(body.role as TestWorkspacePortalRole)
      ? body.role as TestWorkspacePortalRole : null;
    const expiresAt = normalizedExpiry(body.expiresAt);
    if (!workspaceId || !email || !fullName || !role || expiresAt === undefined) {
      return json({ error: "Valid workspace, email, name, role, and future expiry are required." }, { status: 400 });
    }
    const { data: workspace } = await db.from("test_workspaces").select("id,status").eq("id", workspaceId).maybeSingle();
    if (!workspace || workspace.status !== "active") return json({ error: "Workspace is unavailable." }, { status: 400 });
    if (await findAuthUserIdByEmail(email)) return json({ error: "This email already has an account." }, { status: 409 });

    // No credential exists while this user is banned. Classification, role, and
    // audit are committed before the account can be activated or invited.
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email,
      email_confirm: false,
      ban_duration: "876000h",
      user_metadata: {},
    });
    if (createError || !created.user) throw createError ?? new Error("Account was not created.");
    const userId = created.user.id;
    const profileRole = role === "resident" ? "resident" : "manager";
    try {
      const { error: profileError } = await db.from("profiles").insert({
        id: userId, email, full_name: fullName, role: profileRole, application_approved: false,
      });
      if (profileError) throw profileError;
      await ensureProfileRoleRow(db, userId, profileRole);
      const { data: member, error: memberError } = await db.from("test_workspace_members").insert({
        workspace_id: workspaceId, user_id: userId, portal_role: role, expires_at: expiresAt, created_by_user_id: operator.userId,
      }).select("id,workspace_id,user_id,portal_role,state,expires_at,created_at").single();
      if (memberError || !member) throw memberError ?? new Error("Membership was not created.");
      await audit(db, operator.userId, workspaceId, "test_workspace_member_invited", { workspaceId, memberId: member.id, userId, role });
      const { data: invite, error: inviteError } = await db.auth.admin.generateLink({ type: "invite", email });
      const tokenHash = invite?.properties?.hashed_token?.trim();
      if (inviteError || !tokenHash) throw inviteError ?? new Error("Invite link was not created.");
      const inviteUrl = `${resolveEmailLinkBaseUrl()}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=invite`;
      const { error: activateError } = await db.auth.admin.updateUserById(userId, { ban_duration: "none" });
      if (activateError) throw activateError;
      const delivered = await deliverTestWorkspaceAuthInvitation({ db, workspaceId, userId, email, inviteUrl });
      if (!delivered) throw new Error("Private invitation delivery failed.");
      return json({ member: { id: member.id, userId, email, fullName, role, state: member.state, expiresAt: member.expires_at, createdAt: member.created_at, workspaceId } }, { status: 201 });
    } catch (error) {
      await db.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
      throw error;
    }
  } catch (error) {
    console.error("[admin/test-workspaces] write failed", error);
    return json({ error: "Could not update test workspaces." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const operator = await requireOperator();
  if (!operator) return json(DENIAL, { status: 404 });
  try {
    const body = await request.json() as { membershipId?: unknown; state?: unknown };
    const membershipId = typeof body.membershipId === "string" ? body.membershipId.trim() : "";
    const state = body.state === "active" || body.state === "suspended" ? body.state : null;
    if (!membershipId || !state) return json({ error: "A membership and valid state are required." }, { status: 400 });
    const db = createSupabaseServiceRoleClient();
    const { data: member, error } = await db.from("test_workspace_members")
      .update({ state, updated_at: new Date().toISOString() })
      .eq("id", membershipId).select("id,workspace_id,user_id,portal_role,state,expires_at,created_at").maybeSingle();
    if (error || !member) return json({ error: "Membership is unavailable." }, { status: 404 });
    await audit(db, operator.userId, member.workspace_id, "test_workspace_member_state_changed", { workspaceId: member.workspace_id, memberId: member.id, state });
    const { data: profile } = await db.from("profiles").select("email,full_name").eq("id", member.user_id).maybeSingle();
    return json({ member: { id: member.id, userId: member.user_id, email: profile?.email ?? null, fullName: profile?.full_name ?? null, role: member.portal_role, state: member.state, expiresAt: member.expires_at, createdAt: member.created_at, workspaceId: member.workspace_id } });
  } catch (error) {
    console.error("[admin/test-workspaces] state update failed", error);
    return json({ error: "Could not update test workspace membership." }, { status: 503 });
  }
}
