import { NextResponse } from "next/server";
import { actorCoversHouses, authorizeDispatchActor } from "@/lib/vendor-dispatch/access.server";
import {
  approveDispatchRun,
  cancelDispatchRun,
  declineDispatchRun,
  retryDispatchRun,
  type DispatchRunActionResult,
} from "@/lib/vendor-dispatch/runs.server";
import { actorMaySeeRun } from "@/lib/vendor-dispatch/runs-read.server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const REASON_STATUS: Record<string, number> = {
  not_found: 404,
  not_allowed: 403,
  wrong_state: 409,
  no_vendors: 422,
  unavailable: 503,
};

const REASON_MESSAGE: Record<string, string> = {
  not_found: "That dispatch is gone.",
  not_allowed: "You cannot do that.",
  wrong_state: "That dispatch already moved on. Refresh and look again.",
  no_vendors: "No vendor is left to offer this to.",
  unavailable: "Dispatch is not available yet.",
};

/**
 * Manager actions on one run from the portal: approve, pick one vendor,
 * decline, retry, offer to all, cancel. The run is loaded under the active
 * workspace and owner, never from the body; the engine functions re-check the
 * state (`runs.server.ts`) so a stale click and an SMS reply cannot both win.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const gate = await authorizeDispatchActor("edit");
    if (!gate.ok) return gate.response;
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: REASON_MESSAGE.not_found }, { status: 404 });

    const body = (await req.json().catch(() => null)) as { action?: unknown; position?: unknown } | null;
    const action = typeof body?.action === "string" ? body.action : "";

    const { data: run, error } = await gate.db
      .from("vendor_dispatch_runs")
      .select("id, property_id, owner_user_id, workspace_id")
      .eq("id", id)
      .eq("workspace_id", gate.actor.workspace.id)
      .eq("owner_user_id", gate.actor.ownerUserId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Could not load the dispatch." }, { status: 500 });
    // Another workspace's run, or one on a house this actor cannot reach, reads as gone.
    if (!run || !actorMaySeeRun(gate.actor, { property_id: run.property_id as string | null })) {
      return NextResponse.json({ error: REASON_MESSAGE.not_found }, { status: 404 });
    }
    const propertyId = (run.property_id as string | null)?.trim();
    if (!actorCoversHouses(gate.actor, propertyId ? { scope: "selected", propertyIds: [propertyId] } : { scope: "all" })) {
      return NextResponse.json({ error: REASON_MESSAGE.not_allowed }, { status: 403 });
    }

    const base = { ownerUserId: gate.actor.ownerUserId, actorUserId: gate.actor.userId, channel: "portal" as const, runId: id };
    let result: DispatchRunActionResult;
    switch (action) {
      case "approve":
        result = await approveDispatchRun(gate.db, { ...base, pickPosition: null });
        break;
      case "pick": {
        const position = typeof body?.position === "number" && Number.isInteger(body.position) ? body.position : NaN;
        if (!Number.isInteger(position) || position < 0 || position > 19) {
          return NextResponse.json({ error: "Pick a vendor." }, { status: 400 });
        }
        result = await approveDispatchRun(gate.db, { ...base, pickPosition: position });
        break;
      }
      case "decline":
        result = await declineDispatchRun(gate.db, base);
        break;
      case "retry":
        result = await retryDispatchRun(gate.db, { ...base, broadcast: false });
        break;
      case "broadcast":
        result = await retryDispatchRun(gate.db, { ...base, broadcast: true });
        break;
      case "cancel":
        result = await cancelDispatchRun(gate.db, base);
        break;
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: REASON_MESSAGE[result.reason] ?? "Could not do that." }, { status: REASON_STATUS[result.reason] ?? 500 });
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch {
    return NextResponse.json({ error: "Could not do that." }, { status: 500 });
  }
}
