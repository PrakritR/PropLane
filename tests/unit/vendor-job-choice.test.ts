import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VENDOR_FIND_WORK_TAB,
  VENDOR_JOB_CHOICES,
  parseVendorJobChoice,
  replyForVendorJobChoice,
  vendorFindWorkHref,
  vendorJobChoiceHref,
} from "@/lib/vendor-job-choice";
import { VENDOR_WORK_ORDER_TAB_ORDER, VENDOR_WORK_ORDER_TABS } from "@/lib/vendor-work-order-tabs";
import { FIND_WORK_DISTANCE_OPTIONS, FIND_WORK_TRADE_OPTIONS, findWorkRadiusMi } from "@/lib/vendor-find-work";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("vendor job choice routing", () => {
  it("offers the three options in order, labeled for the vendor", () => {
    expect(VENDOR_JOB_CHOICES.map((c) => [c.id, c.label])).toEqual([
      ["estimate", "Needs an estimate visit"],
      ["bid", "Bid now"],
      ["message", "Message the manager"],
    ]);
  });

  it("routes estimate and bid to Estimate & bid with the choice, and message to Communication", () => {
    expect(vendorJobChoiceHref("/vendor", "wo-1", "estimate")).toBe("/vendor/work-orders/wo-1/bid?choice=estimate");
    expect(vendorJobChoiceHref("/vendor", "wo-1", "bid")).toBe("/vendor/work-orders/wo-1/bid?choice=bid");
    expect(vendorJobChoiceHref("/vendor", "wo-1", "message")).toBe("/vendor/work-orders/wo-1/communication");
  });

  it("preselects a reply only for estimate and bid", () => {
    expect(replyForVendorJobChoice("estimate")).toBe("book_estimate_visit");
    expect(replyForVendorJobChoice("bid")).toBe("submit_bid");
    expect(replyForVendorJobChoice("message")).toBeNull();
  });

  it("parses only the three known values", () => {
    expect(parseVendorJobChoice("estimate")).toBe("estimate");
    expect(parseVendorJobChoice("bid")).toBe("bid");
    expect(parseVendorJobChoice("message")).toBe("message");
    for (const bad of ["", "BID", "decline", "bid ", null, undefined]) expect(parseVendorJobChoice(bad)).toBeNull();
  });

  it("Find work lives at /vendor/work-orders/find-work", () => {
    expect(VENDOR_FIND_WORK_TAB).toBe("find-work");
    expect(vendorFindWorkHref("/vendor")).toBe("/vendor/work-orders/find-work");
  });

  it("Find work filters map to board query values", () => {
    expect(findWorkRadiusMi("")).toBeUndefined();
    expect(findWorkRadiusMi("abc")).toBeUndefined();
    expect(findWorkRadiusMi("25")).toBe(25);
    expect(FIND_WORK_DISTANCE_OPTIONS.map((o) => o.value)).toEqual(["5", "10", "25", "50"]);
    expect(FIND_WORK_TRADE_OPTIONS.map((o) => o.value)).toContain("plumbing");
    expect(FIND_WORK_TRADE_OPTIONS.find((o) => o.value === "hvac")?.label).toBe("HVAC");
  });
});

describe("Find work is a fifth tab, not a fifth stage", () => {
  it("keeps the four-stage vocabulary unchanged", () => {
    expect(VENDOR_WORK_ORDER_TAB_ORDER).toEqual(["open", "assigned", "scheduled", "completed"]);
    expect(VENDOR_WORK_ORDER_TABS.map((t) => t.id)).toEqual(["open", "assigned", "scheduled", "completed"]);
    expect(VENDOR_WORK_ORDER_TABS.some((t) => (t.id as string) === VENDOR_FIND_WORK_TAB)).toBe(false);
  });

  it("the panel appends Find work itself and uses the one choice bar on the board and on Open services", () => {
    const panel = read("src/components/portal/vendor-work-orders-panel.tsx");
    expect(panel).toContain("VendorJobChoiceBar");
    expect(panel).toContain('label: "Find work"');
    expect(panel).toContain("VENDOR_FIND_WORK_TAB");
    expect(panel).toContain("vendorJobChoiceHref");
    const list = read("src/components/portal/vendor-find-work-list.tsx");
    expect(list).toContain("VendorJobChoiceBar");
    expect(list).toContain("VendorServiceCardRow");
    expect(list).not.toMatch(/Badge|portal-badge|rounded-full/);
    expect(read("src/components/portal/vendor-job-choice-bar.tsx")).not.toMatch(/Badge|portal-badge|rounded-full/);
  });
});
