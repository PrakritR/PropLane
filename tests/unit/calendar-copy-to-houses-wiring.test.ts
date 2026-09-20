/**
 * Portfolio calendar wires copy-to-houses when a single source house is in scope.
 * Week actions are toolbar icons (PLAN-0916-1034), not footer word pills.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const calendarSrc = readFileSync("src/components/portal/portal-calendar.tsx", "utf8");
const panelsSrc = readFileSync("src/components/portal/portal-calendar-panels.tsx", "utf8");

describe("portal calendar copy to houses wiring", () => {
  it("uses shared copy helpers and passes destination houses to the grid", () => {
    expect(calendarSrc).toContain("buildCalendarCopyDestinationHouses");
    expect(calendarSrc).toContain("resolveCalendarCopySourcePropertyId");
    expect(calendarSrc).toContain("otherProperties={portal === \"manager\" ? copyDestinationHouses : undefined}");
    expect(calendarSrc).toContain("availabilityCopySourcePropertyId");
  });

  it("renders week actions as labeled toolbar icons, not footer text", () => {
    expect(panelsSrc).toContain("PortalIconAction");
    expect(panelsSrc).toContain('data-slot="calendar-week-actions"');
    expect(panelsSrc).toContain("data-attr=\"calendar-copy-previous-week\"");
    expect(panelsSrc).toContain("data-attr=\"calendar-copy-to-houses\"");
    expect(panelsSrc).not.toContain("Prev week");
    expect(panelsSrc).not.toContain("PortalPageFooterActions");
  });

  it("Copy previous week and Clear persist across All and Tours keys", () => {
    expect(panelsSrc).toContain("const mutateAvailabilityAllKinds = useCallback(");
    expect(panelsSrc).toContain("mutateAvailabilityAllKinds((activeSlotsForKey) => {");
    expect(panelsSrc).toContain("const clearCurrentWeek = useCallback(() => {");
    expect(panelsSrc).toContain("mutateAvailabilityAllKinds((current) => {");
    expect(calendarSrc).toContain('// "all"');
    expect(calendarSrc).toContain("services: managerKindKeys.services");
    expect(calendarSrc).toContain("tasks: managerKindKeys.tasks");
  });
});
