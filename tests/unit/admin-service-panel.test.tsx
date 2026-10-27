// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Building2 } from "lucide-react";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { currentFeeLine, feeOutcomeToast, groupServiceByCity, oldNumberFactLabel, serviceRowFacts, workNumberFactLabel,
  serviceRowFactCount, type ServiceRow } from "@/components/portal/admin-service-panel";
import { serviceWorkspaceFinancesHref } from "@/lib/service/service-links";

vi.mock("next/navigation", () => ({ usePathname: () => "/portal/admin/accounts", useSearchParams: () => new URLSearchParams() }));

const row = (over: Partial<ServiceRow>): ServiceRow => ({
  id: "1",
  name: "WS",
  city: null,
  ownerOfRecord: null,
  isDefault: false,
  houseCount: 0,
  workNumber: null,
  workNumberSource: null,
  teamCount: 1,
  viewerRole: "admin",
  canManage: true,
  ...over,
});

describe("Service list sections", () => {
  it("groups per city with Seattle first, the rest alphabetical, no city last", () => {
    const groups = groupServiceByCity([
      row({ id: "a", city: "Portland" }),
      row({ id: "b", city: null }),
      row({ id: "c", city: "seattle" }),
      row({ id: "d", city: "Austin" }),
      row({ id: "e", city: "Seattle " }),
    ]);
    expect(groups.map((g) => [g.city, g.rows.map((r) => r.id)])).toEqual([
      ["seattle", ["c", "e"]],
      ["Austin", ["d"]],
      ["Portland", ["a"]],
      [null, ["b"]],
    ]);
  });

  it("row facts: houses, the management fee, the number it texts from, then team", () => {
    expect(serviceRowFacts(row({ houseCount: 2, workNumber: "+12065550100", teamCount: 3, feePercent: 10 })).map((f) => (typeof f === "string" ? f : f.label))).toEqual([
      "2 houses",
      "10% fee",
      "(206) 555-0100",
      "3 on team",
    ]);
    expect(serviceRowFacts(row({ viewerRole: null })).map((f) => (typeof f === "string" ? f : f.label))).toContain("Not on team");
    expect(serviceRowFacts(row({})).map((f) => (typeof f === "string" ? f : f.label))).toContain("No fee yet");
  });

  it("a managed workspace's row says (206) 678-1909 · PropLane line, and a kept old number is its own fact", () => {
    const managed = row({ houseCount: 1, workNumber: "+12066781909", workNumberSource: "shared", feePercent: 10, oldNumber: { phoneNumber: "+18146793694", since: "2026-10-25T18:00:00.000Z" } });
    expect(workNumberFactLabel(managed)).toBe("(206) 678-1909 · PropLane line");
    expect(oldNumberFactLabel(managed.oldNumber!)).toBe("Old (814) 679-3694 kept since Oct 25");
    const labels = serviceRowFacts(managed).map((f) => (typeof f === "string" ? f : f.label));
    expect(labels).toContain("(206) 678-1909 · PropLane line");
    expect(labels).toContain("Old (814) 679-3694 kept since Oct 25");
    expect(serviceRowFacts(row({})).map((f) => (typeof f === "string" ? f : f.label)).some((l) => l.startsWith("Old "))).toBe(false);
    expect(workNumberFactLabel(row({}))).toBe("No number");
  });

  // Review fix, Oct 20: a row draws only its first three facts, so asserting the helper's array is not enough —
  // the fee has to survive into the rendered row, ahead of the team count.
  it("the rendered row shows the rate in force", () => {
    render(
      <PortalEntryRow
        tile={{ kind: "glyph", icon: Building2 }}
        title="Ballard Service"
        facts={serviceRowFacts(row({ houseCount: 2, workNumber: "+12065550100", teamCount: 3, feePercent: 10 }))}
        onOpen={() => {}}
      />,
    );
    const rendered = screen.getByRole("button", { name: /Ballard Service/ });
    expect(rendered.textContent).toContain("10% fee");
    expect(rendered.textContent).toContain("2 houses");
    expect(rendered.textContent).toContain("(206) 555-0100");
    expect(rendered.textContent).not.toContain("3 on team");
  });

  // Live drive, Oct 26: at 390px the row named only houses and the fee, so the 206 and the kept old number were invisible.
  // A phone row hides a fact with `max-lg:hidden`; the number facts must not carry it.
  it("at phone width the work number and the kept old number are not hidden", () => {
    const managed = row({ houseCount: 1, workNumber: "+12066781909", workNumberSource: "shared", feePercent: 10, oldNumber: { phoneNumber: "+18146793694", since: null } });
    const hiddenOnPhone = (n: number, mgd: ServiceRow, extra: object) => {
      const { container, unmount } = render(
        <PortalEntryRow tile={{ kind: "glyph", icon: Building2 }} title="Ambika" facts={serviceRowFacts(mgd)} onOpen={() => {}} {...extra} />,
      );
      const line = container.querySelector('[data-attr="record-row-facts"]')!;
      const out = [...line.children].map((c) => c.classList.contains("max-lg:hidden") === true && true);
      unmount();
      return { texts: [...line.children].map((c) => c.textContent ?? ""), hidden: out, n };
    };
    expect(serviceRowFactCount(managed)).toBe(4);
    expect(serviceRowFactCount(row({}))).toBe(3);
    // The shared default (two facts on a phone) hides both numbers: the bug.
    const before = hiddenOnPhone(4, managed, {});
    expect(before.texts.some((t) => t.includes("(206) 678-1909"))).toBe(true);
    expect(before.hidden[before.texts.findIndex((t) => t.includes("(206) 678-1909"))]).toBe(true);
    // The service row's own caps keep the 206 and the old number on a phone.
    const after = hiddenOnPhone(4, managed, { maxFacts: 4, phoneFactLimit: 4 });
    for (const needle of ["(206) 678-1909", "Old (814) 679-3694"]) {
      const i = after.texts.findIndex((t) => t.includes(needle));
      expect(i).toBeGreaterThanOrEqual(0);
      expect(after.hidden[i]).toBe(false);
    }
  });

  it("the rendered row says so when no fee is in force yet", () => {
    render(
      <PortalEntryRow tile={{ kind: "glyph", icon: Building2 }} title="Fremont Service" facts={serviceRowFacts(row({}))} onOpen={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /Fremont Service/ }).textContent).toContain("No fee yet");
  });

  // Review fix, Oct 20: a rate change is immediate, so the modal states the rate in force and nothing about a date,
  // and the toast says what the save actually did.
  it("the fee modal states the rate in force, with no promise about a date", () => {
    expect(currentFeeLine({ feePercent: 10 })).toBe("Current fee 10%");
    expect(currentFeeLine({ feePercent: null })).toBe("No fee yet");
    expect(currentFeeLine(null)).toBe("No fee yet");
  });

  it("the toast says whether the save moved the rate", () => {
    expect(feeOutcomeToast({ feePercent: 15, changed: true })).toBe("Fee set to 15%.");
    expect(feeOutcomeToast({ feePercent: 10, changed: false })).toBe("No change.");
  });

  it("leaves the Finances link slot empty until W17 fills it", () => {
    expect(serviceWorkspaceFinancesHref("x")).toBeNull();
  });
});
