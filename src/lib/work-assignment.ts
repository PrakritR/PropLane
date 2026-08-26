/**
 * Who a piece of work is assigned to — one shape for services, tours and tasks.
 *
 * A manager with co-managers and vendors needs to say "you take this", and then everyone needs to
 * see the same answer on every surface. Three separate assignee fields with three shapes is how
 * the resident portal ends up showing a vendor's name on a tour a co-manager is actually running.
 *
 * Two kinds of assignee, and the distinction is load-bearing:
 *
 *   - a **team member** (co-manager) can take anything — a service, a work order, a tour, a task;
 *   - a **vendor** can take staff TASK work only — not tours (they do not show prospects around)
 *     and not add-on services (those stay with the manager team).
 *     `assignableKindsFor` is the one place that rule lives, so a new surface cannot quietly
 *     offer a vendor a tour.
 */

/** What can be assigned. Services covers both add-on requests and maintenance work orders. */
export type AssignableWorkKind = "service" | "tour" | "task";

export type AssigneeType = "team" | "vendor";

export type WorkAssignee = {
  type: AssigneeType;
  /** The co-manager's user id, or the vendor row id. */
  id: string;
  /** Snapshot of the name AT ASSIGNMENT TIME — see `assigneeDisplayName`. */
  name: string;
};

/** Candidate for the assignment picker. */
export type AssignmentCandidate = {
  type: AssigneeType;
  id: string;
  name: string;
  /** A co-manager's email or a vendor's trade — shown to tell two similar names apart. */
  detail?: string;
  /** An inactive vendor stays visible on work already assigned to them, but cannot be picked. */
  selectable: boolean;
};

/**
 * Which assignee types may take this kind of work.
 *
 * Vendors are task-only. Keeping this as one function rather than a check at each picker is
 * what stops a future surface from offering a vendor a tour by omission.
 */
export function assignableKindsFor(type: AssigneeType): AssignableWorkKind[] {
  return type === "vendor" ? ["task"] : ["service", "tour", "task"];
}

export function canAssign(type: AssigneeType, kind: AssignableWorkKind): boolean {
  return assignableKindsFor(type).includes(kind);
}

/**
 * The candidates offered for one kind of work.
 *
 * Inactive vendors are kept in the list but marked unselectable rather than dropped, so a manager
 * looking at work already assigned to a deactivated vendor still sees who has it. Dropping them
 * would make that work look unassigned.
 */
export function assignmentCandidatesFor(
  kind: AssignableWorkKind,
  input: {
    teamMembers: readonly { userId: string; name?: string | null; email?: string | null }[];
    vendors: readonly { id: string; name?: string | null; trade?: string | null; active?: boolean }[];
  },
): AssignmentCandidate[] {
  const out: AssignmentCandidate[] = [];

  for (const member of input.teamMembers) {
    if (!member.userId?.trim()) continue;
    const name = member.name?.trim() || member.email?.trim() || "Team member";
    out.push({
      type: "team",
      id: member.userId,
      name,
      detail: member.email?.trim() && member.email.trim() !== name ? member.email.trim() : undefined,
      selectable: true,
    });
  }

  if (canAssign("vendor", kind)) {
    for (const vendor of input.vendors) {
      if (!vendor.id?.trim()) continue;
      out.push({
        type: "vendor",
        id: vendor.id,
        name: vendor.name?.trim() || "Vendor",
        detail: vendor.trade?.trim() || undefined,
        selectable: vendor.active !== false,
      });
    }
  }

  return out;
}

/**
 * Normalize a stored assignee, returning null for anything unusable.
 *
 * An assignee with no id cannot be resolved back to a person, so it is treated as unassigned
 * rather than rendered as a name nobody can act on. An unrecognised `type` is read as `team`
 * only when it is genuinely absent — never coerced from `vendor`, because that would silently
 * widen a vendor into someone who can be handed a tour.
 */
export function normalizeAssignee(raw: unknown): WorkAssignee | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;
  const type: AssigneeType = row.type === "vendor" ? "vendor" : "team";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  return { type, id, name };
}

/**
 * What to show for an assignee.
 *
 * Prefers the CURRENT name from the people list, falling back to the snapshot taken at assignment
 * time. The snapshot exists because a vendor can be deleted and a co-manager can be unlinked —
 * without it, work they did shows as assigned to nobody, which reads as lost rather than historic.
 */
export function assigneeDisplayName(
  assignee: WorkAssignee | null,
  candidates: readonly AssignmentCandidate[],
): string | null {
  if (!assignee) return null;
  const current = candidates.find((c) => c.type === assignee.type && c.id === assignee.id);
  return current?.name || assignee.name || "Unknown";
}

/** True when this assignee is no longer in the people list — deleted vendor, unlinked manager. */
export function assigneeIsStale(
  assignee: WorkAssignee | null,
  candidates: readonly AssignmentCandidate[],
): boolean {
  if (!assignee) return false;
  return !candidates.some((c) => c.type === assignee.type && c.id === assignee.id);
}
