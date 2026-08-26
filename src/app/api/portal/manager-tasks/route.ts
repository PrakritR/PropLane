import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  createManagerTaskRow,
  deleteManagerTaskRow,
  loadManagerTasks,
  patchManagerTaskRow,
} from "@/lib/manager-tasks.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const tasks = await loadManagerTasks(ctx.db, ctx.userId);
    return NextResponse.json({ tasks });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
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
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
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
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
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
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
