import { describe, expect, it } from "vitest";
import { reconcileManagerPlannedEventsWrite } from "@/lib/planned-events-write-scope";

function record(payload: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "axis_admin_planned_events_v1",
    row_data: { id: "axis_admin_planned_events_v1", payload },
  };
}

describe("reconcileManagerPlannedEventsWrite", () => {
  it("preserves other managers' events and ignores attempts to replace them", () => {
    const existing = record([
      { id: "victim-tour", managerUserId: "manager-victim", title: "Original" },
      { id: "own-tour", managerUserId: "manager-me", title: "Mine" },
    ]);
    const incoming = record([
      { id: "victim-tour", managerUserId: "manager-me", title: "Forged" },
      { id: "own-tour", managerUserId: "manager-me", title: "Updated" },
    ]);

    const result = reconcileManagerPlannedEventsWrite(incoming, "manager-me", existing);
    expect((result.row_data as { payload: unknown[] }).payload).toEqual([
      { id: "victim-tour", managerUserId: "manager-victim", title: "Original" },
      { id: "own-tour", managerUserId: "manager-me", title: "Updated" },
    ]);
  });

  it("rejects new events attributed to another manager and stamps unowned events", () => {
    const result = reconcileManagerPlannedEventsWrite(
      record([
        { id: "forged", managerUserId: "manager-victim" },
        { id: "new-own", title: "Manual tour" },
      ]),
      "manager-me",
      record([]),
    );

    expect((result.row_data as { payload: unknown[] }).payload).toEqual([
      { id: "new-own", managerUserId: "manager-me", title: "Manual tour" },
    ]);
  });
});
