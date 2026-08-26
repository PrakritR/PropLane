import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  createManagerTaskRow,
  deleteManagerTaskRow,
  loadManagerTasks,
  patchManagerTaskRow,
} from "@/lib/manager-tasks.server";

export const runtime = "nodejs";

const USER_FACING_TASK_ERRORS = new Set([
  "Title is required.",
  "End time must be after start time.",
  "Task not found.",
  "id required.",
]);

function taskRouteError(e: unknown, fallback: string): string {
  if (e instanceof Error && USER_FACING_TASK_ERRORS.has(e.message)) return e.message;
  return fallback;
}

export async function GET() {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const tasks = await loadManagerTasks(ctx.db, ctx.userId);
    return NextResponse.json({ tasks });
  } catch {
    return NextResponse.json({ error: "Could not load tasks." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = await req.json().catch(() => null);
    const task = await createManagerTaskRow(ctx.db, ctx.userId, body);
    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json({ error: taskRouteError(e, "Could not save task.") }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    const taskId = String(body?.id ?? "").trim();
    if (!taskId) return NextResponse.json({ error: "id required." }, { status: 400 });
    const task = await patchManagerTaskRow(ctx.db, ctx.userId, taskId, body ?? {});
    return NextResponse.json({ task });
  } catch (e) {
    return NextResponse.json({ error: taskRouteError(e, "Could not save task.") }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => null)) as { id?: string } | null;
    const taskId = String(body?.id ?? "").trim();
    if (!taskId) return NextResponse.json({ error: "id required." }, { status: 400 });
    await deleteManagerTaskRow(ctx.db, ctx.userId, taskId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: taskRouteError(e, "Could not delete task.") }, { status: 400 });
  }
}
