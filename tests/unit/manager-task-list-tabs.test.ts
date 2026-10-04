import { describe, expect, it } from "vitest";
import {
  MANAGER_TASK_LIST_TABS,
  MANAGER_TASK_LIST_TAB_LABELS,
  legacyTaskListSectionRedirectPath,
  managerTaskListHref,
  parseManagerTaskListTab,
  parseVendorTaskListTab,
} from "@/lib/portal-detail-routes";
import { SERVICE_STAGE_IDS, SERVICE_STAGE_LABEL, parseServiceStage } from "@/lib/service-lifecycle";
import { managerTaskStage } from "@/lib/manager-task-stage";
import { managerTaskRowInScope, selectManagerTaskListRows, tasksForListTab } from "@/lib/manager-task-display";
import type { ManagerTask } from "@/lib/manager-tasks";

const task = (over: Partial<ManagerTask>): ManagerTask => ({
  id: "t",
  title: "Task",
  completed: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("manager task list tabs", () => {
  it("is the one service vocabulary plus Arrivals & departures last", () => {
    expect(MANAGER_TASK_LIST_TABS).toEqual([...SERVICE_STAGE_IDS, "arrivals-departures"]);
    for (const id of SERVICE_STAGE_IDS) expect(MANAGER_TASK_LIST_TAB_LABELS[id]).toBe(SERVICE_STAGE_LABEL[id]);
    expect(MANAGER_TASK_LIST_TAB_LABELS["arrivals-departures"]).toBe("Arrivals & departures");
  });

  it("has no Overdue or Done tab", () => {
    expect(MANAGER_TASK_LIST_TABS).not.toContain("overdue");
    expect(MANAGER_TASK_LIST_TABS).not.toContain("in-progress");
  });

  it("maps the old URL ids onto the stages, like the shared parser", () => {
    expect(parseManagerTaskListTab(undefined)).toBe("open");
    expect(parseManagerTaskListTab("in-progress")).toBe("open");
    expect(parseManagerTaskListTab("overdue")).toBe("open");
    expect(parseManagerTaskListTab("late")).toBe("open");
    expect(parseManagerTaskListTab("done")).toBe("completed");
    expect(parseManagerTaskListTab("completed")).toBe("completed");
    expect(parseManagerTaskListTab("assigned")).toBe("assigned");
    expect(parseManagerTaskListTab("scheduled")).toBe("scheduled");
    expect(parseManagerTaskListTab("arrivals-departures")).toBe("arrivals-departures");
    for (const legacy of ["in-progress", "overdue", "done", "completed", "open"]) {
      expect(parseManagerTaskListTab(legacy)).toBe(parseServiceStage(legacy));
    }
  });

  it("builds the list href, Open being the bare /tasks", () => {
    expect(managerTaskListHref("/portal", "open")).toBe("/portal/tasks");
    expect(managerTaskListHref("/portal", "completed")).toBe("/portal/tasks/completed");
    expect(legacyTaskListSectionRedirectPath("/portal", ["overdue"])).toBe("/portal/tasks");
    expect(legacyTaskListSectionRedirectPath("/portal", ["done"])).toBe("/portal/tasks/completed");
    expect(legacyTaskListSectionRedirectPath("/portal", ["in-progress", "t1"])).toBe("/portal/tasks/open/t1");
  });

  it("parses vendor tabs without overdue", () => {
    expect(parseVendorTaskListTab("overdue")).toBe("in-progress");
    expect(parseVendorTaskListTab("completed")).toBe("completed");
  });
});

describe("managerTaskStage", () => {
  it("completed, then scheduled (has a start), then assigned, else open", () => {
    expect(managerTaskStage(task({ completed: true, assignee: { type: "team", id: "u", name: "A" }, start: "2026-10-09T17:00:00Z" }))).toBe("completed");
    expect(managerTaskStage(task({ start: "2026-10-09T17:00:00Z", end: "2026-10-09T18:00:00Z", assignee: { type: "team", id: "u", name: "A" } }))).toBe("scheduled");
    expect(managerTaskStage(task({ assignee: { type: "team", id: "u", name: "A" } }))).toBe("assigned");
    expect(managerTaskStage(task({ dueDate: "2020-01-01" }))).toBe("open");
  });

  it("an overdue task keeps its stage - lateness is a fact, not a tab", () => {
    const late = task({ dueDate: "2020-01-01", assignee: { type: "team", id: "u", name: "A" } });
    expect(managerTaskStage(late)).toBe("assigned");
    expect(tasksForListTab([late], "assigned")).toEqual([late]);
    expect(tasksForListTab([late], "open")).toEqual([]);
  });
});

describe("task record rail and header", () => {
  it("the rail is TASK: Task · Linked, then Communication; the header ends Complete (primary) then Delete", async () => {
    const { recordSections } = await import("@/lib/portals/record-sections");
    const sections = recordSections("manager", "task", { basePath: "/portal", taskListTab: "open" });
    expect(sections.groups.map((g) => [g.label, g.items.map((i) => i.label)])).toEqual([
      ["Task", ["Task", "Linked"]],
      ["", ["Communication"]],
    ]);
    expect(sections.headerActions.map((a) => a.id)).toEqual(["edit", "assign", "schedule", "complete", "delete"]);
    expect(sections.groups[0]!.items[1]!.href("t1")).toBe("/portal/tasks/open/t1/linked");
  });

  it("Assign is real: no Coming soon toast left in the task page", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/portal/pro-task-list.tsx", "utf8");
    expect(source).not.toContain("Coming soon");
    expect(source).toContain("TaskAssignDialog");
  });
});

describe("the Tasks list shows a task on its stage tab", () => {
  const person = { type: "team" as const, id: "u", name: "Jordan Lee" };
  const rows = (tabId: "open" | "assigned" | "scheduled" | "completed", tasks: ManagerTask[]) =>
    selectManagerTaskListRows({
      tabId,
      tasks,
      assignedServices: [],
      matchesProperty: () => true,
      listFilter: "all",
      assigneeFilterId: "",
      priorityFilter: "",
      sortId: "newest",
      propertyLabelForId: () => "",
    }).map((row) => (row.kind === "task" ? row.task.id : row.id));

  it("unassigned+undated -> Open, assigned -> Assigned, with a start -> Scheduled, completed -> Completed", () => {
    const all = [
      task({ id: "open" }),
      task({ id: "assigned", assignee: person }),
      task({ id: "scheduled", assignee: person, start: "2026-10-09T17:00:00Z", end: "2026-10-09T18:00:00Z" }),
      task({ id: "completed", assignee: person, completed: true }),
    ];
    expect(rows("open", all)).toEqual(["open"]);
    expect(rows("assigned", all)).toEqual(["assigned"]);
    expect(rows("scheduled", all)).toEqual(["scheduled"]);
    expect(rows("completed", all)).toEqual(["completed"]);
  });

  it("a task with no house is shown in a partitioned account (the workspace rule rejects a house-less row)", () => {
    // `workspaceContainsProperty` answers false for a house-less row once an account holds two workspaces.
    const workspaceContains = (id?: string) => Boolean(id) && id === "house-a";
    const rowsFor = (tabId: "open" | "assigned" | "scheduled" | "completed", tasks: ManagerTask[], propertyFilterId = "") =>
      selectManagerTaskListRows({
        tabId,
        tasks,
        assignedServices: [],
        matchesProperty: (id) => managerTaskRowInScope(id, { workspaceContains, propertyFilterId }),
        listFilter: "all",
        assigneeFilterId: "",
        priorityFilter: "",
        sortId: "newest",
        propertyLabelForId: () => "",
      }).map((row) => (row.kind === "task" ? row.task.id : row.id));
    const smoke = task({ id: "smoke", assignee: person, start: "2026-10-06T16:30:00Z", end: "2026-10-06T17:30:00Z" });
    expect(rowsFor("scheduled", [smoke])).toEqual(["smoke"]);
    expect(rowsFor("open", [task({ id: "bare" })])).toEqual(["bare"]);
    // A task that names a house outside the workspace stays out; the Property filter narrows to its house.
    expect(rowsFor("open", [task({ id: "other", propertyId: "house-z" })])).toEqual([]);
    expect(rowsFor("open", [task({ id: "mine", propertyId: "house-a" })], "house-a")).toEqual(["mine"]);
    expect(rowsFor("open", [task({ id: "bare" })], "house-a")).toEqual([]);
  });
});
