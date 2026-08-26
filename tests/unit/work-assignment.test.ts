/**
 * Who a piece of work can be assigned to.
 *
 * The rule that matters: vendors take staff TASK work only — never tours (they do not show
 * prospects around) and never add-on services (those stay with the manager team).
 * That lives in `assignableKindsFor` alone, so a new surface cannot quietly offer a vendor a tour
 * by forgetting to check.
 *
 * The second theme is that people disappear. A vendor is deleted, a co-manager is unlinked — and
 * the work they were holding must still show WHO had it, or it reads as unassigned rather than as
 * needing a new owner.
 */
import { describe, expect, it } from "vitest";
import {
  assigneeDisplayName,
  assigneeIsStale,
  assignableKindsFor,
  assignmentCandidatesFor,
  canAssign,
  normalizeAssignee,
} from "@/lib/work-assignment";

const TEAM = [
  { userId: "mgr-1", name: "Riley Chen", email: "riley@example.com" },
  { userId: "mgr-2", name: "", email: "morgan@example.com" },
];
const VENDORS = [
  { id: "v-1", name: "Ace Plumbing", trade: "Plumbing", active: true },
  { id: "v-2", name: "Old Sparks", trade: "Electrical", active: false },
];

describe("what a vendor may take", () => {
  it("lets a team member take anything", () => {
    expect(assignableKindsFor("team")).toEqual(["service", "tour", "task"]);
  });

  it("limits a vendor to task work", () => {
    expect(assignableKindsFor("vendor")).toEqual(["task"]);
    expect(canAssign("vendor", "task")).toBe(true);
    expect(canAssign("vendor", "service")).toBe(false);
    expect(canAssign("vendor", "tour")).toBe(false);
  });
});

describe("candidates offered", () => {
  it("offers vendors for tasks, not services or tours", () => {
    const serviceList = assignmentCandidatesFor("service", { teamMembers: TEAM, vendors: VENDORS });
    expect(serviceList.every((c) => c.type === "team")).toBe(true);

    const taskList = assignmentCandidatesFor("task", { teamMembers: TEAM, vendors: VENDORS });
    expect(taskList.filter((c) => c.type === "vendor").map((c) => c.id)).toEqual(["v-1", "v-2"]);

    const tourList = assignmentCandidatesFor("tour", { teamMembers: TEAM, vendors: VENDORS });
    expect(tourList.every((c) => c.type === "team")).toBe(true);
  });

  it("keeps an inactive vendor visible but unselectable on tasks", () => {
    const list = assignmentCandidatesFor("task", { teamMembers: [], vendors: VENDORS });
    expect(list.find((c) => c.id === "v-2")?.selectable).toBe(false);
    expect(list.find((c) => c.id === "v-1")?.selectable).toBe(true);
  });

  it("falls back to an email when a team member has no name", () => {
    const list = assignmentCandidatesFor("task", { teamMembers: TEAM, vendors: [] });
    expect(list.find((c) => c.id === "mgr-2")?.name).toBe("morgan@example.com");
  });

  it("skips a person with no id, who could never be resolved back", () => {
    const list = assignmentCandidatesFor("service", {
      teamMembers: [{ userId: "  " }],
      vendors: [{ id: "" }],
    });
    expect(list).toEqual([]);
  });
});

describe("stored assignees", () => {
  it("reads a usable assignee", () => {
    expect(normalizeAssignee({ type: "vendor", id: "v-1", name: "Ace" })).toEqual({
      type: "vendor",
      id: "v-1",
      name: "Ace",
    });
  });

  it("treats an assignee with no id as unassigned", () => {
    // There is no person to act on, so rendering a name would be a dead end.
    for (const raw of [null, undefined, {}, { type: "team" }, "nope", { id: "  " }]) {
      expect(normalizeAssignee(raw)).toBeNull();
    }
  });

  it("never widens an unknown type into a vendor", () => {
    // Coercing toward `vendor` would let a vendor appear on work they may not take.
    expect(normalizeAssignee({ type: "wat", id: "x" })?.type).toBe("team");
    expect(normalizeAssignee({ id: "x" })?.type).toBe("team");
  });
});

describe("displaying an assignee", () => {
  const candidates = assignmentCandidatesFor("task", { teamMembers: TEAM, vendors: VENDORS });

  it("prefers the current name over the snapshot", () => {
    // The person was renamed since the assignment.
    const assignee = { type: "vendor" as const, id: "v-1", name: "Ace Plumbing (old)" };
    expect(assigneeDisplayName(assignee, candidates)).toBe("Ace Plumbing");
  });

  it("falls back to the snapshot when the person is gone", () => {
    const assignee = { type: "vendor" as const, id: "deleted", name: "Gone Plumbing" };
    expect(assigneeDisplayName(assignee, candidates)).toBe("Gone Plumbing");
    expect(assigneeIsStale(assignee, candidates)).toBe(true);
  });

  it("says Unknown rather than nothing when both are missing", () => {
    expect(assigneeDisplayName({ type: "team", id: "gone", name: "" }, candidates)).toBe("Unknown");
  });

  it("reports no name and no staleness for unassigned work", () => {
    expect(assigneeDisplayName(null, candidates)).toBeNull();
    expect(assigneeIsStale(null, candidates)).toBe(false);
  });
});
