import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { sendTaskAssigneeEmail } from "@/lib/manager-default-tasks.server";
import { buildManagerTaskReminderPreview } from "@/lib/manager-task-reminder";
import { loadManagerTasks, patchManagerTaskRow } from "@/lib/manager-tasks.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function canSendTaskReminder(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager" || role === "owner" || role === "pro";
}

export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as {
      taskId?: string;
      subject?: string;
      text?: string;
    };
    const taskId = body.taskId?.trim();
    if (!taskId) {
      return NextResponse.json({ ok: false, error: "Task id is required." }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const [{ data: requestor }, admin] = await Promise.all([
      db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
      isAdminUser(user.id),
    ]);
    if (!admin && !canSendTaskReminder(requestor?.role)) {
      return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 403 });
    }

    const managerUserId = user.id;
    const tasks = await loadManagerTasks(db, managerUserId);
    const task = tasks.find((row) => row.id === taskId);
    if (!task) {
      return NextResponse.json({ ok: false, error: "Task not found." }, { status: 404 });
    }
    if (task.completed) {
      return NextResponse.json({ ok: false, error: "Task is already completed.", code: "task_completed" }, { status: 409 });
    }
    if (!task.assignee) {
      return NextResponse.json({ ok: false, error: "Task has no assignee." }, { status: 400 });
    }

    const preview = buildManagerTaskReminderPreview({ task });
    const subject = body.subject?.trim() || preview.subject;
    const text = body.text?.trim() || preview.body;

    const result = await sendTaskAssigneeEmail({
      db,
      managerUserId,
      task,
      assignee: task.assignee,
      kind: "due",
      subject,
      text,
    });

    if (!result.sent) {
      return NextResponse.json(
        { ok: false, error: result.error ?? "Could not send reminder email." },
        { status: result.error === "mailer_unconfigured" ? 503 : 502 },
      );
    }

    await patchManagerTaskRow(db, managerUserId, taskId, {
      reminderSentAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, emailSent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not send task reminder.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
