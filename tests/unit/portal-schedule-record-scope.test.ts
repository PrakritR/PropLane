import { describe, expect, it } from "vitest";
import {
  calendarShareAvailabilityStorageKey,
  managerPropertyAvailabilityStorageKey,
} from "@/lib/demo-admin-scheduling";
import {
  MANAGER_KIND_AVAILABILITY_RECORD_TYPE,
  AVAILABILITY_KINDS,
  MANAGER_KIND_AVAILABILITY_KINDS,
  legacyTaskKeysForStorageKey,
  managerKindAvailabilityStorageKey,
  normalizeAvailabilityKind,
  parseManagerKindAvailabilityStorageKey,
  readKeysForKindStorageKeys,
} from "@/lib/manager-availability-kinds";
import {
  expectedManagerScheduleRecordIds,
  isManagerScopedScheduleRecordType,
  managerScheduleRecordIdOwnedByUser,
} from "@/lib/portal-schedule-record-scope";

describe("portal-schedule-record-scope", () => {
  const userId = "user-abc";
  const victimId = "user-victim";
  const propertyId = "prop-1";

  it("recognizes manager-scoped schedule record types", () => {
    expect(isManagerScopedScheduleRecordType("calendar_share_settings")).toBe(true);
    expect(isManagerScopedScheduleRecordType("manager_property_availability")).toBe(true);
    expect(isManagerScopedScheduleRecordType(MANAGER_KIND_AVAILABILITY_RECORD_TYPE)).toBe(true);
    expect(isManagerScopedScheduleRecordType("partner_inquiry_request")).toBe(false);
  });

  it("allows a kind-scoped availability key only for the owning manager", () => {
    const ownServicesKey = managerKindAvailabilityStorageKey(userId, "services");
    const ownTasksKey = managerKindAvailabilityStorageKey(userId, "tasks");
    const victimKey = managerKindAvailabilityStorageKey(victimId, "services");

    expect(managerScheduleRecordIdOwnedByUser(ownServicesKey, userId, MANAGER_KIND_AVAILABILITY_RECORD_TYPE)).toBe(
      true,
    );
    expect(managerScheduleRecordIdOwnedByUser(ownTasksKey, userId, MANAGER_KIND_AVAILABILITY_RECORD_TYPE)).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(victimKey, userId, MANAGER_KIND_AVAILABILITY_RECORD_TYPE)).toBe(false);
  });

  it("never lets a kind-scoped availability key validate as the tour-visible manager_availability type", () => {
    const kindKey = managerKindAvailabilityStorageKey(userId, "services");
    expect(managerScheduleRecordIdOwnedByUser(kindKey, userId, "manager_availability")).toBe(false);
  });

  it("keeps the retired Inspections and Move-ins/outs records owner-only and never tour-visible (they read as Tasks; a Tasks save may still empty them)", () => {
    for (const kind of ["inspections", "moves"] as const) {
      const own = managerKindAvailabilityStorageKey(userId, kind);
      expect(parseManagerKindAvailabilityStorageKey(own)).toEqual({ userId, kind });
      expect(managerScheduleRecordIdOwnedByUser(own, userId, MANAGER_KIND_AVAILABILITY_RECORD_TYPE)).toBe(true);
      expect(
        managerScheduleRecordIdOwnedByUser(
          managerKindAvailabilityStorageKey(victimId, kind),
          userId,
          MANAGER_KIND_AVAILABILITY_RECORD_TYPE,
        ),
      ).toBe(false);
      expect(managerScheduleRecordIdOwnedByUser(own, userId, "manager_availability")).toBe(false);
    }
  });

  it("a manager can only be available for three kinds, and the kind keys are the services and tasks ones", () => {
    expect([...AVAILABILITY_KINDS]).toEqual(["tours", "services", "tasks"]);
    expect([...MANAGER_KIND_AVAILABILITY_KINDS]).toEqual(["services", "tasks"]);
  });

  it("folds a retired inspections or moves key onto tasks on read, and onto nothing else", () => {
    expect(normalizeAvailabilityKind("inspections")).toBe("tasks");
    expect(normalizeAvailabilityKind("moves")).toBe("tasks");
    expect(normalizeAvailabilityKind("services")).toBe("services");
    expect(normalizeAvailabilityKind("everything")).toBeNull();
    const tasksKey = managerKindAvailabilityStorageKey(userId, "tasks");
    expect(readKeysForKindStorageKeys([tasksKey]).sort()).toEqual(
      [
        tasksKey,
        managerKindAvailabilityStorageKey(userId, "inspections"),
        managerKindAvailabilityStorageKey(userId, "moves"),
      ].sort(),
    );
    const servicesKey = managerKindAvailabilityStorageKey(userId, "services");
    expect(readKeysForKindStorageKeys([servicesKey])).toEqual([servicesKey]);
    expect(legacyTaskKeysForStorageKey(servicesKey)).toEqual([]);
  });

  it("allows calendar share keys only for the owning manager", () => {
    const ownKey = calendarShareAvailabilityStorageKey(userId, propertyId);
    const victimKey = calendarShareAvailabilityStorageKey(victimId, propertyId);

    expect(managerScheduleRecordIdOwnedByUser(ownKey, userId, "calendar_share_settings")).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(victimKey, userId, "calendar_share_settings")).toBe(false);
  });

  it("allows property availability keys only for the owning manager", () => {
    const ownKey = managerPropertyAvailabilityStorageKey(userId, propertyId);
    const victimKey = managerPropertyAvailabilityStorageKey(victimId, propertyId);

    expect(managerScheduleRecordIdOwnedByUser(ownKey, userId, "manager_property_availability")).toBe(true);
    expect(managerScheduleRecordIdOwnedByUser(victimKey, userId, "manager_property_availability")).toBe(false);
  });

  it("builds expected share and availability keys for a peer", () => {
    expect(expectedManagerScheduleRecordIds(userId, propertyId)).toEqual({
      shareKey: calendarShareAvailabilityStorageKey(userId, propertyId),
      availKey: managerPropertyAvailabilityStorageKey(userId, propertyId),
    });
  });
});
