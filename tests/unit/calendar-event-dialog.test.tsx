// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calendarEventDialogActions,
  type DemoMeeting,
} from "@/components/portal/portal-calendar-panels";

const ROOT = join(__dirname, "..", "..");
const source = readFileSync(join(ROOT, "src/components/portal/portal-calendar-panels.tsx"), "utf8");

function meeting(partial: Partial<DemoMeeting> & Pick<DemoMeeting, "source" | "kind" | "title">): DemoMeeting {
  return {
    id: "m1",
    sourceId: "src-1",
    startIso: "2026-09-22T17:00:00.000Z",
    endIso: "2026-09-22T17:30:00.000Z",
    dateStr: "2026-09-22",
    startSlot: 20,
    span: 1,
    durationMinutes: 30,
    color: "",
    ...partial,
  };
}

describe("calendar event dialog chrome", () => {
  it("renders through PortalDialog with fact rows and no duration pills", () => {
    expect(source).toContain('from "@/components/portal/portal-dialog"');
    expect(source).toContain("<PortalDialog");
    expect(source).toContain('dataAttr="calendar-event-detail-modal"');
    expect(source).toContain("<ConfirmRows");
    expect(source).toContain('dataAttr="event-duration"');
    expect(source).not.toContain("event-duration-preset");
    expect(source).not.toContain("Will be scheduled");
    expect(source).not.toMatch(/fixed inset-0 z-\[80\]/);
  });

  it("task primary is Edit task, not Edit service", () => {
    expect(source).toContain("Edit task");
    expect(source).not.toContain("Edit service");
    const task = calendarEventDialogActions(
      meeting({
        source: "planned",
        kind: "task",
        title: "Restock paper",
        sourceTaskId: "task-1",
      }),
    );
    expect(task.primaryLabel).toBe("Edit task");
    expect(task.secondaryLabel).toBe("Delete task");
    expect(task.showMessage).toBe(false);
  });

  it("tour requested: Delete tour / Confirm tour, Message icon when email is present", () => {
    const requested = calendarEventDialogActions(
      meeting({
        source: "inquiry",
        kind: "tour",
        title: "Tour · Ada",
        email: "ada@axis.local",
        name: "Ada",
      }),
    );
    expect(requested.primaryLabel).toBe("Confirm tour");
    expect(requested.secondaryLabel).toBe("Delete tour");
    expect(requested.showMessage).toBe(true);
    expect(requested.messageLabel).toBe("Message resident");
    expect(source).toContain('data-attr="tour-open-message-thread"');
    expect(source).toContain("icon={Mail}");
  });

  it("confirmed tour: Delete event / Cancel tour", () => {
    const confirmed = calendarEventDialogActions(
      meeting({
        source: "planned",
        kind: "tour",
        title: "Tour · Ada",
        email: "ada@axis.local",
      }),
    );
    expect(confirmed.primaryLabel).toBe("Cancel tour");
    expect(confirmed.secondaryLabel).toBe("Delete event");
    expect(confirmed.showMessage).toBe(true);
  });

  it("service visit: no footer, Message when the resident email is stamped", () => {
    const visit = calendarEventDialogActions(
      meeting({
        source: "external",
        kind: "service",
        title: "Ace Plumbing · Fix sink",
        name: "Casey Cosigner Host",
        email: "casey.host@axis.local",
      }),
    );
    expect(visit.primaryLabel).toBeNull();
    expect(visit.secondaryLabel).toBeNull();
    expect(visit.showMessage).toBe(true);
    expect(visit.messageLabel).toBe("Message");
  });
});
