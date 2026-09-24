import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { loadWorkspacePlan, loadWorkspaces } from "@/lib/workspaces/server";
import { actorWorkspaceStanding, previewHouseMove } from "@/lib/workspaces/membership.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import {
  ensureManagerAssistantEmail,
  isAssistantEmailProvisioningEnabled,
  probeAssistantEmailStorageReady,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { getEffectiveManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";
import { managerCommsRequestIsOfferable } from "@/lib/comms-billing/manager-comms-eligibility.server";

export const runtime = "nodejs";

type WorkspaceActor =
  | { kind: "authorized"; user: { id: string }; db: ReturnType<typeof createSupabaseServiceRoleClient> }
  | { kind: "denied" }
  | null;

async function actor(): Promise<WorkspaceActor> {
  const session = await createSupabaseServerClient();
  const { data: { user } } = await session.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
    return { kind: "denied" };
  }
  return { kind: "authorized", user, db };
}

function actorFailureResponse(ctx: WorkspaceActor) {
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (ctx.kind === "denied") {
    return NextResponse.json({ error: "Workspace access is unavailable for this account." }, { status: 403 });
  }
  return null;
}

export async function GET() {
  try {
    const ctx = await actor();
    const failure = actorFailureResponse(ctx);
    if (failure) return failure;
    if (!ctx || ctx.kind !== "authorized") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const workspaces = await loadWorkspaces(ctx.db, ctx.user.id);
    const plan = await loadWorkspacePlan(ctx.db, ctx.user.id, workspaces);
    const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
    return NextResponse.json({
      workspaces,
      activeWorkspaceId: workspaces.find((w) => w.id === selected)?.id ?? workspaces[0]?.id ?? null,
      plan,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load workspaces. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await actor();
    const failure = actorFailureResponse(ctx);
    if (failure) return failure;
    if (!ctx || ctx.kind !== "authorized") return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = await request.json();
    const { user, db } = ctx;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const action = body.action;
    if (action === "select") {
      const workspaces = await loadWorkspaces(db, user.id);
      if (!workspaces.some((w) => w.id === body.id)) return NextResponse.json({ error: "Workspace access is unavailable." }, { status: 403 });
      const response = NextResponse.json({ ok: true, activeWorkspaceId: body.id });
      response.cookies.set(WORKSPACE_COOKIE, body.id, {
        httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
      });
      return response;
    }
    if (!await userIsPropertyPortalManager(db, user.id)) {
      return NextResponse.json({ error: "A manager account is required." }, { status: 403 });
    }
    if (action === "initialize") {
      const result = await db.rpc("ensure_default_portal_workspace", { p_owner: user.id });
      if (result.error) throw result.error;
      return NextResponse.json({ id: result.data });
    }
    if (action !== "create" && action !== "rename" && action !== "delete" && action !== "move-property" && action !== "move-preview") {
      return NextResponse.json({ error: "Unknown workspace action." }, { status: 400 });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if ((action === "create" || action === "rename") && (!name || name.length > 80)) {
      return NextResponse.json({ error: "Use a workspace name of 1–80 characters." }, { status: 400 });
    }
    if (action === "create") {
      // The plan's cap sits under the database ceiling; an unknown plan refuses
      // rather than guessing Free or Business. The RPC repeats the owner count
      // under the same advisory lock as the database trigger.
      const current = await loadWorkspaces(db, user.id);
      const plan = await loadWorkspacePlan(db, user.id, current);
      if (plan.unknown) return NextResponse.json({ error: "We could not verify your plan. Try again in a moment." }, { status: 503 });
      const limitError = `Your ${plan.tier ? plan.tier[0].toUpperCase() + plan.tier.slice(1) : "current"} plan includes ${plan.workspaceLimit} ${plan.workspaceLimit === 1 ? "workspace" : "workspaces"}. Upgrade to add another.`;
      if (plan.usage.workspaces >= plan.workspaceLimit) {
        return NextResponse.json(
          { error: limitError },
          { status: 403 },
        );
      }
      const result = await db.rpc("create_portal_workspace_with_limit", {
        p_owner: user.id,
        p_name: name,
        p_limit: plan.workspaceLimit,
      });
      if (result.error) throw result.error;
      // The pre-check is only courtesy. A null RPC result means another
      // request consumed the last slot while this request was in flight.
      if (!result.data) return NextResponse.json({ error: limitError }, { status: 409 });
      const newWorkspaceId = String(result.data);
      // Mint {slug}@proplane.ai for the new workspace when the account may
      // hold a work email — same gates as Messaging auto-backfill. Failure
      // here must not fail the create; Messaging GET will retry.
      try {
        if (isAssistantEmailProvisioningEnabled() && (await probeAssistantEmailStorageReady(db))) {
          const entitlement = await getEffectiveManagerSmsEntitlement(db, user.id);
          if (managerCommsRequestIsOfferable({ entitlement })) {
            await ensureManagerAssistantEmail(db, user.id, {
              id: newWorkspaceId,
              ownerUserId: user.id,
              owned: true,
              isDefault: false,
              name,
            });
          }
        }
      } catch (cause) {
        console.warn(
          "workspace-create assistant-email mint failed",
          cause instanceof Error ? cause.message : cause,
        );
      }
      return NextResponse.json({ id: newWorkspaceId }, { status: 201 });
    }
    if (typeof body.id !== "string" || !/^[0-9a-f-]{36}$/i.test(body.id)) {
      return NextResponse.json({ error: "A valid workspace is required." }, { status: 400 });
    }
    if (action === "move-property" || action === "move-preview") {
      if (typeof body.propertyId !== "string" || !body.propertyId.trim()) return NextResponse.json({ error: "Select a property." }, { status: 400 });
      // A house moves between two workspaces the actor RUNS: the owner, or an
      // admin of both the source and the destination. Ownership of the house
      // and of the destination are server-derived; the body only names them.
      const destination = await actorWorkspaceStanding(db, user.id, body.id);
      if (!destination || !destination.rights.houses) {
        return NextResponse.json({ error: "Only the workspace owner or an admin can move houses here." }, { status: 403 });
      }
      const house = await db.from("manager_property_records").select("id, workspace_id, manager_user_id")
        .eq("id", body.propertyId.trim()).eq("manager_user_id", destination.ownerUserId).maybeSingle();
      if (house.error) throw house.error;
      if (!house.data) return NextResponse.json({ error: "Property not found in this portfolio." }, { status: 404 });
      const fromWorkspaceId = String(house.data.workspace_id ?? "").trim();
      if (fromWorkspaceId && fromWorkspaceId !== destination.workspaceId) {
        const source = await actorWorkspaceStanding(db, user.id, fromWorkspaceId);
        if (!source || !source.rights.houses) {
          return NextResponse.json({ error: "Only the workspace owner or an admin can move houses out of this workspace." }, { status: 403 });
        }
      }
      const impact = fromWorkspaceId && fromWorkspaceId !== destination.workspaceId
        ? await previewHouseMove(db, { ownerUserId: destination.ownerUserId, propertyId: body.propertyId.trim(), fromWorkspaceId, toWorkspaceId: destination.workspaceId })
        : { loses: [], keeps: [], gains: [] };
      if (action === "move-preview") return NextResponse.json({ ok: true, ...impact });
      const result = await db.from("manager_property_records").update({ workspace_id: destination.workspaceId })
        .eq("id", body.propertyId.trim()).eq("manager_user_id", destination.ownerUserId).select("id");
      if (result.error) throw result.error;
      if (!result.data?.length) return NextResponse.json({ error: "Property not found in this portfolio." }, { status: 404 });
      return NextResponse.json({ ok: true, ...impact });
    }
    const existing = await db.from("portal_workspaces").select("id").eq("id", body.id).eq("owner_user_id", user.id).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) return NextResponse.json({ error: "Only the workspace owner can change it." }, { status: 403 });
    if (action === "delete") {
      // Any owned workspace can go, the default one included. Its houses may
      // ride along to another workspace of the same owner; the RPC moves them,
      // deletes, and hands "default" to the oldest remaining workspace under
      // one owner lock. FK RESTRICT still refuses a delete with houses left.
      const moveTo = typeof body.moveTo === "string" && body.moveTo.trim() ? body.moveTo.trim() : null;
      if (moveTo !== null && (!/^[0-9a-f-]{36}$/i.test(moveTo) || moveTo === body.id)) {
        return NextResponse.json({ error: "Choose another workspace for the properties." }, { status: 400 });
      }
      if (moveTo !== null) {
        const destination = await db.from("portal_workspaces").select("id").eq("id", moveTo).eq("owner_user_id", user.id).maybeSingle();
        if (destination.error) throw destination.error;
        if (!destination.data) return NextResponse.json({ error: "Choose another workspace for the properties." }, { status: 400 });
      }
      const result = await db.rpc("delete_portal_workspace", { p_owner: user.id, p_id: body.id, p_move_to: moveTo });
      if (result.error) throw result.error;
      if (!result.data) return NextResponse.json({ error: "Only the workspace owner can change it." }, { status: 403 });
    } else {
      const result = await db.from("portal_workspaces").update({ name }).eq("id", body.id).eq("owner_user_id", user.id);
      if (result.error) throw result.error;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "23514") return NextResponse.json({ error: "That workspace is full: 10 property records per workspace, including drafts. Choose another workspace." }, { status: 409 });
    if (code === "23503") return NextResponse.json({ error: "Move the properties out before deleting this workspace." }, { status: 409 });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    return NextResponse.json({ error: "Could not update the workspace. Please retry." }, { status: 503 });
  }
}
