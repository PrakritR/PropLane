import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  compactTaskLocationLabel,
  compactTaskPropertyLabel,
  compactTaskRoomLabel,
  taskNotesPreview,
} from "@/lib/manager-task-display";
import { buildScheduledTourMeetings } from "@/lib/manager-calendar-tour-meetings";
import type { PlannedEvent } from "@/lib/demo-admin-scheduling";

vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-admin-scheduling")>();
  return {
    ...actual,
    readPlannedEvents: () => mockPlannedEvents,
    readPartnerInquiries: () => [],
  };
});

let mockPlannedEvents: PlannedEvent[] = [];

describe("manager-task-display", () => {
  it("shortens property and room labels for list rows", () => {
    expect(
      compactTaskLocationLabel({
        propertyId: undefined,
        propertyTitle: "5259 Brooklyn Ave NE · 9 rooms",
        roomLabel: "Room 4 · 2nd floor · $800/mo",
      }),
    ).toBe("5259 Brooklyn Ave NE · Room 4");
    expect(compactTaskRoomLabel("Room 2 · 1st floor · $700/mo")).toBe("Room 2");
    expect(compactTaskPropertyLabel(undefined, "Ballard House · 3 rooms")).toBe("Ballard House");
  });

  it("truncates long checklist notes", () => {
    const notes = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"].join("\n");
    const { preview, truncated } = taskNotesPreview(notes);
    expect(truncated).toBe(true);
    expect(preview).toContain("Line 3");
    expect(preview).not.toContain("Line 5");
  });
});

describe("buildScheduledTourMeetings task property scope", () => {
  beforeEach(() => {
    mockPlannedEvents = [
      {
        id: "task_a",
        title: "Task · House A turnover",
        start: "2026-08-29T18:00:00.000Z",
        end: "2026-08-29T19:00:00.000Z",
        kind: "task",
        managerUserId: "mgr-1",
        propertyId: "house-a",
        sourceTaskId: "task-1",
      },
      {
        id: "task_b",
        title: "Task · House B turnover",
        start: "2026-08-29T20:00:00.000Z",
        end: "2026-08-29T21:00:00.000Z",
        kind: "task",
        managerUserId: "mgr-1",
        propertyId: "house-b",
        sourceTaskId: "task-2",
      },
    ];
  });

  it("limits task blocks to the selected house filter", () => {
    const meetings = buildScheduledTourMeetings(
      {
        viewerUserId: "mgr-1",
        propertyId: "house-a",
        propertyIds: ["house-a"],
        peers: [],
      },
      "axis_mgr_avail_slots_v2_mgr-1_house-a",
    );
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.propertyId).toBe("house-a");
    expect(meetings[0]?.sourceTaskId).toBe("task-1");
  });
});
