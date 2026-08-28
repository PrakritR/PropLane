import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadVendorAssignedTasks, patchVendorAssignedTask } from "@/lib/vendor-tasks.server";

export const runtime = "nodejs";

const USER_FACING_ERRORS = new Set([
  "Task not found.",
  "You do not have access to this task.",
]);

function routeError(e: unknown, fallback: string): string {
  if (e instanceof Error && USER_FACING_ERRORS.has(e.message)) return e.message;
  return fallback;
}

export async function GET() {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: auth.status },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const tasks = await loadVendorAssignedTasks(db, auth.userId);
    return NextResponse.json({ tasks });
  } catch (e) {
    return NextResponse.json({ error: routeError(e, "Could not load tasks.") }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: auth.status },
      );
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const managerUserId = String(body?.managerUserId ?? "");
    const taskId = String(body?.taskId ?? "");
    const completed = body?.completed === true;

    const db = createSupabaseServiceRoleClient();
    const task = await patchVendorAssignedTask(db, auth.userId, {
      managerUserId,
      taskId,
      completed,
    });
    return NextResponse.json({ task });
  } catch (e) {
    const message = routeError(e, "Could not update task.");
    const status = message === "Could not update task." ? 500 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
