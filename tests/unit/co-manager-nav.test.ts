import { describe, expect, it } from "vitest";
import { deriveManagerNavRole } from "@/lib/co-manager-nav";

describe("deriveManagerNavRole", () => {
  it("treats managers with no links as primary", () => {
    const role = deriveManagerNavRole([]);
    expect(role.isPrimaryManager).toBe(true);
    expect(role.mergedPermissions).toEqual({});
  });

  it("treats managers with outgoing accepted links as primary", () => {
    const role = deriveManagerNavRole([
      {
        direction: "outgoing",
        status: "accepted",
        coManagerPermissions: { applications: true },
      },
    ]);
    expect(role.isPrimaryManager).toBe(true);
    expect(role.mergedPermissions).toEqual({});
  });

  it("treats incoming-only accepted links as co-manager with granted permissions", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: { applications: true, payments: true },
      },
    ]);
    expect(role.isPrimaryManager).toBe(false);
    expect(role.mergedPermissions).toEqual({ applications: true, payments: true });
  });

  it("prefers primary when user has both incoming and outgoing accepted links", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: { applications: true },
      },
      {
        direction: "outgoing",
        status: "accepted",
        coManagerPermissions: { payments: true },
      },
    ]);
    expect(role.isPrimaryManager).toBe(true);
    expect(role.mergedPermissions).toEqual({});
  });

  it("ignores pending invites for nav role", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "pending",
        coManagerPermissions: { applications: true },
      },
    ]);
    expect(role.isPrimaryManager).toBe(true);
    expect(role.mergedPermissions).toEqual({});
  });

  it("merges permissions across multiple incoming accepted links", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: { applications: true },
      },
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: { inbox: true },
      },
    ]);
    expect(role.isPrimaryManager).toBe(false);
    expect(role.mergedPermissions).toEqual({ applications: true, inbox: true });
  });

  it("flags an incoming accepted link whose merged permissions are empty", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: {},
      },
    ]);
    expect(role.isPrimaryManager).toBe(false);
    expect(role.mergedPermissions).toEqual({});
    expect(role.hasEmptyPermissionCoManagerLink).toBe(true);
  });

  it("does not flag it when a co-manager link has explicit permissions", () => {
    const role = deriveManagerNavRole([
      {
        direction: "incoming",
        status: "accepted",
        coManagerPermissions: { applications: true },
      },
    ]);
    expect(role.hasEmptyPermissionCoManagerLink).toBe(false);
  });

  it("does not flag it for a primary manager with no links", () => {
    const role = deriveManagerNavRole([]);
    expect(role.hasEmptyPermissionCoManagerLink).toBe(false);
  });

  it("treats a property-owning user with an incoming co-manager link as PRIMARY", () => {
    const incomingLink = [
      {
        direction: "incoming" as const,
        status: "accepted" as const,
        propertyCoManagerPermissions: { "prop-a": { payments: true } },
      },
    ];
    // Without owning properties → gated co-manager.
    const coManager = deriveManagerNavRole(incomingLink, false);
    expect(coManager.isPrimaryManager).toBe(false);
    // Owning >=1 property → primary (full nav), even with the same incoming link.
    const owner = deriveManagerNavRole(incomingLink, true);
    expect(owner.isPrimaryManager).toBe(true);
    expect(owner.mergedPermissions).toEqual({});
    expect(owner.hasEmptyPermissionCoManagerLink).toBe(false);
  });
});
