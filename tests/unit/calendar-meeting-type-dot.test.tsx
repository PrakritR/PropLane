// @vitest-environment jsdom
//
// C259: month/week/day chips already color their background by STATUS
// (confirmed / co-manager tour / pending), so two meetings of different
// TYPES (a move-in inspection task, a vendor visit, a tour) with the same
// status were visually identical until the label was read. This locks in
// the added type-color-code dot that survives a truncated label.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MeetingTypeDot, meetingTypeDotColor } from "@/components/portal/portal-calendar-panels";

describe("meetingTypeDotColor", () => {
  it("gives each event type its own distinct color", () => {
    expect(meetingTypeDotColor("tour")).toBe("bg-sky-500");
    expect(meetingTypeDotColor("service")).toBe("bg-violet-500");
    expect(meetingTypeDotColor("task")).toBe("bg-amber-500");
    expect(meetingTypeDotColor("partner")).toBe("bg-slate-400");
    const colors = new Set(
      (["tour", "service", "task", "partner"] as const).map((kind) => meetingTypeDotColor(kind)),
    );
    expect(colors.size).toBe(4);
  });

  it("falls back to a neutral color for an unrecognized/missing kind", () => {
    expect(meetingTypeDotColor(undefined)).toBe("bg-slate-400");
  });
});

describe("MeetingTypeDot", () => {
  it("renders a decorative, kind-tagged dot", () => {
    render(<MeetingTypeDot kind="service" />);
    const dot = document.querySelector('[data-attr="meeting-type-dot"]');
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute("data-meeting-kind")).toBe("service");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.className).toContain("bg-violet-500");
  });
});
