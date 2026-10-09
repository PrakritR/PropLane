import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePlaceLine, stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import { inboxRowAddressLabel } from "@/lib/communication-row-meta";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("record header icons (A)", () => {
  const src = read("src/components/portal/portal-list-detail-shell.tsx");
  it("keeps the 32px compact icons to lg and up and gives phones 44px", () => {
    expect(src).toContain("lg:[&_button:not([data-labeled-primary])]:!size-8");
    expect(src).toContain("lg:[&_button:not([data-labeled-primary])]:!min-h-0");
    expect(src).toContain("max-lg:[&_button:not([data-labeled-primary])]:!size-11");
    expect(src).not.toMatch(/(^|[\s"`])\[&_button:not\(\[data-labeled-primary\]\)\]:!size-8/);
  });
  it("lets the record subtitle wrap to two lines on phones (J)", () => {
    expect(src).toContain("text-muted max-md:line-clamp-2 max-md:whitespace-normal\">{subtitle}");
  });
});

describe("phone tap targets (B-G)", () => {
  it("calendar nav buttons are 44px on phones", () => {
    const src = read("src/components/portal/portal-calendar-panels.tsx");
    expect(src).toContain("size-7 max-md:size-11");
    expect(src).toContain("h-7 max-md:h-11");
  });
  it("listing sticky bar buttons are at least 44px", () => {
    const src = read("src/components/marketing/listing-detail-sections.tsx");
    expect(src).not.toContain("!min-h-[40px]");
    expect(src).toContain("!min-h-[44px] !w-auto");
  });
});

describe("grouped list toggle (I) and KPI copy (K)", () => {
  it("floats the expand/collapse-all control instead of giving it a row on phones", () => {
    const src = read("src/components/portal/portal-grouped-record-list.tsx");
    expect(src).toContain("max-lg:absolute");
    expect(src).toContain("max-lg:[&>:nth-child(2)>button]:!pr-12");
  });
  it("lets dashboard KPI copy take two lines on phones", () => {
    const src = read("src/components/portal/pro-dashboard-kpis.tsx");
    expect(src).toContain("max-md:line-clamp-2");
  });
});

describe("property label dedupe (L)", () => {
  it("strips a room-count suffix after a dot or a dash", () => {
    expect(stripPropertyRoomCountSuffix("Alder Row — 3 rooms")).toBe("Alder Row");
    expect(stripPropertyRoomCountSuffix("Alder Row · 3 rooms")).toBe("Alder Row");
  });
  it("shows the room-count suffix once", () => {
    expect(composePlaceLine(["Applicant", "Alder Row — 3 rooms", "3 rooms"])).toBe("Applicant · Alder Row — 3 rooms");
    expect(composePlaceLine(["Applicant", "Alder Row — 3 rooms", "Alder Row — 3 rooms"])).toBe("Applicant · Alder Row — 3 rooms");
    expect(composePlaceLine(["Applicant", "", null, "Room 1"])).toBe("Applicant · Room 1");
  });
  it("inbox address labels never carry the room-count suffix", () => {
    expect(inboxRowAddressLabel("Alder Row — 3 rooms · 3 rooms")).toBe("Alder Row");
    expect(inboxRowAddressLabel("5259 Brooklyn Ave NE · 9 rooms")).toBe("5259 Brooklyn Ave NE");
  });
});
