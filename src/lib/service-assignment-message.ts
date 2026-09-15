/**
 * The message a manager sends the person they just assigned a service to.
 *
 * Built once, here, so the Add service preview, the auto-send path and the
 * "Message assignee" retry all say the same thing. Plain text: it goes out as
 * an inbox message and, when the recipient has them, email and text.
 */
export type ServiceAssignmentMessageContext = {
  assigneeName: string;
  managerName: string;
  kind: "maintenance" | "add-on";
  title: string;
  description: string;
  propertyLabel: string;
  roomLabel?: string | null;
  priority?: string | null;
  tasks?: readonly string[];
  residentName?: string | null;
};

export function buildServiceAssignmentMessage(ctx: ServiceAssignmentMessageContext): {
  subject: string;
  body: string;
} {
  const where = ctx.roomLabel?.trim()
    ? `${ctx.propertyLabel} (${ctx.roomLabel.trim()})`
    : ctx.propertyLabel;
  const what = ctx.kind === "maintenance" ? "a maintenance service" : "a service";
  const tasks = (ctx.tasks ?? []).map((task) => task.trim()).filter(Boolean);
  const details = ctx.description.trim();

  const lines = [
    `Hi ${ctx.assigneeName.trim() || "there"},`,
    "",
    `You've been assigned ${what} at ${where}: ${ctx.title.trim()}${details ? ` — ${details}` : ""}.${
      ctx.priority?.trim() ? ` Priority: ${ctx.priority.trim()}.` : ""
    }`,
    ctx.residentName?.trim() ? `Resident: ${ctx.residentName.trim()}.` : null,
    tasks.length ? "" : null,
    tasks.length ? `Tasks: ${tasks.join(" · ")}.` : null,
    "",
    "Reply here to confirm a time.",
    `— ${ctx.managerName.trim() || "Your property manager"}, PropLane`,
  ].filter((line): line is string => line !== null);

  return {
    subject: `New service at ${ctx.propertyLabel} — ${ctx.title.trim()}`,
    body: lines.join("\n"),
  };
}
