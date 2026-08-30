import { describe, expect, it } from "vitest";
import {
  MANAGER_TASK_LIST_TABS,
  parseManagerTaskListTab,
  parseVendorTaskListTab,
} from "@/lib/portal-detail-routes";

describe("manager task list tabs", () => {
  it("exposes three manager tabs", () => {
    expect(MANAGER_TASK_LIST_TABS).toEqual(["in-progress", "overdue", "completed"]);
  });

  it("parses manager tab slugs including late alias", () => {
    expect(parseManagerTaskListTab(undefined)).toBe("in-progress");
    expect(parseManagerTaskListTab("in-progress")).toBe("in-progress");
    expect(parseManagerTaskListTab("overdue")).toBe("overdue");
    expect(parseManagerTaskListTab("late")).toBe("overdue");
    expect(parseManagerTaskListTab("completed")).toBe("completed");
  });

  it("parses vendor tabs without overdue", () => {
    expect(parseVendorTaskListTab("overdue")).toBe("in-progress");
    expect(parseVendorTaskListTab("completed")).toBe("completed");
  });
});
