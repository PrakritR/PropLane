// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the Bookings calendar after
// `resident-record-tidy-1004`: a property with exactly one bookable row is ONE
// row carrying the property's own name (no property strip above a "Whole home"
// row repeating it), and a listing with no title reads "Untitled listing"
// rather than its raw id.
//
// `bookings-portfolio-timeline.test.ts` asserts the rule; this file dumps the
// rendered rows so the change can be screenshotted with the app's real
// stylesheet. Set EVIDENCE_DIR to write them.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";

// A declared room list for "prop-a" (one room → one bookable row), nothing for
// "prop-b" (no rooms and no bookings → the single placeholder row).
vi.mock("@/lib/rental-application/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rental-application/data")>();
  return {
    ...actual,
    getPropertyById: () => undefined,
    getRoomOptionsForProperty: (propertyId: string) =>
      propertyId === "prop-a" ? [{ value: "prop-a::room-1", label: "Room 1" }] : [],
  };
});

beforeAll(() => {
  // Desktop (fine pointer), so the shared date-axis grid renders rather than the
  // phone stacked strip — the same way `bookings-portfolio-timeline.test.tsx` pins it.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const captured: { name: string; html: string }[] = [];
afterAll(() => {
  if (!EVIDENCE_DIR || captured.length === 0) return;
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  for (const { name, html } of captured) {
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${name}.body.html`), html, "utf8");
  }
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey } from "@/lib/room-availability-calendar";

const TODAY = new Date(2026, 8, 10);

function bookingEntry(overrides: Partial<PropertyBookingEntry> = {}): PropertyBookingEntry {
  return {
    source: "proplane",
    propertyId: "prop-a",
    propertyLabel: "Prop A House",
    roomId: "room-1",
    roomLabel: "Room 1",
    summary: "Jordan Smith",
    start: dateKey(addDays(TODAY, 1)),
    end: dateKey(addDays(TODAY, 2)),
    ...overrides,
  };
}

describe("Bookings: a single-row property is one row", () => {
  it("names the row after the property, and a title-less listing reads Untitled listing", () => {
    const { container } = render(
      <BookingsPortfolioTimeline
        propertyIds={["prop-a", "prop-b"]}
        entries={[bookingEntry()]}
        today={TODAY}
        onOpenDay={() => {}}
      />,
    );

    expect(screen.getByText("Prop A House")).toBeTruthy();
    expect(screen.getByText("Untitled listing")).toBeTruthy();
    expect(screen.queryByText("prop-b")).toBeNull();
    expect(screen.queryByText("Whole home")).toBeNull();
    // One row per property, and it IS the property row.
    expect(document.querySelectorAll('[data-attr^="bookings-timeline-property-"]')).toHaveLength(2);
    if (EVIDENCE_DIR) captured.push({ name: "bookings-single-row", html: container.innerHTML });
  });
});
