import { describe, expect, it } from "vitest";
import { isGenericParticipantName, resolveResidentThreadManager } from "@/lib/resident-communication-manager";

const contact = {
  managerName: "Email Match",
  phone: "+12065550100",
  phoneKind: "work" as const,
  email: "m@example.com",
  emailKind: "work" as const,
  propertyLabel: "1 Main St",
  leaseStart: null,
  leaseEnd: null,
  status: "current" as const,
};

describe("resolveResidentThreadManager", () => {
  it("prefers the server-stamped counterparty over the client email match", () => {
    const manager = resolveResidentThreadManager(
      {
        from: "m@example.com",
        email: "m@example.com",
        folder: "inbox",
        counterparty: {
          workspaceId: "ws-1",
          name: "Dana Whitfield",
          workspaceName: "Cascade Lofts Management",
          workPhone: "+15103098345",
          avatarUrl: null,
          initials: "DW",
        },
      },
      [contact],
    );
    expect(manager.name).toBe("Dana Whitfield");
    expect(manager.workspaceName).toBe("Cascade Lofts Management");
    expect(manager.workPhone).toBe("+15103098345");
    expect(manager.initials).toBe("DW");
  });

  it("falls back to the contact match when a row carries no counterparty", () => {
    const manager = resolveResidentThreadManager({ from: "x", email: "m@example.com", folder: "inbox" }, [contact]);
    expect(manager.name).toBe("Email Match");
    expect(manager.workPhone).toBe("+12065550100");
    expect(manager.workspaceName).toBeUndefined();
  });

  const counterparty = (over: Record<string, unknown>) => ({
    workspaceId: "ws-1",
    name: "Dana Whitfield",
    workspaceName: "Cascade Lofts Management",
    workPhone: null,
    avatarUrl: null,
    initials: "DW",
    ...over,
  });

  it("falls to the workspace name when the manager has no name, never the generic label", () => {
    const manager = resolveResidentThreadManager(
      { from: "Resident", email: "", folder: "inbox", counterparty: counterparty({ name: "Property manager" }) },
      [],
    );
    expect(manager.name).toBe("Cascade Lofts Management");
  });

  it("a stored 'Resident' is the resident themself: the stored manager name wins", () => {
    const manager = resolveResidentThreadManager({ from: "Resident", email: "m@example.com", folder: "sent" }, [contact]);
    expect(manager.name).toBe("Email Match");
    const stored = resolveResidentThreadManager(
      { from: "Test Manager", email: "", folder: "inbox" },
      [],
    );
    expect(stored.name).toBe("Test Manager");
  });

  it("skips every generic placeholder before using the stored participant name or address", () => {
    expect(
      resolveResidentThreadManager({ from: "Resident", email: "boss@example.com", folder: "inbox" }, []).name,
    ).toBe("boss@example.com");
    expect(
      resolveResidentThreadManager({ from: "Property Manager", email: "boss@example.com", folder: "inbox" }, []).name,
    ).toBe("Property manager");
    expect(
      resolveResidentThreadManager(
        { from: "Resident", email: "", folder: "inbox", counterparty: counterparty({ name: "", workspaceName: null }) },
        [],
      ).name,
    ).toBe("Property manager");
  });

  it("the manager's own name still beats the workspace name", () => {
    const manager = resolveResidentThreadManager(
      { from: "Resident", email: "", folder: "inbox", counterparty: counterparty({}) },
      [],
    );
    expect(manager.name).toBe("Dana Whitfield");
  });
});

describe("isGenericParticipantName", () => {
  it.each(["", "  ", "Property manager", "Property Manager", "Resident", "You", "Unknown sender"])("%j is generic", (name) => {
    expect(isGenericParticipantName(name)).toBe(true);
  });
  it.each(["Test Manager", "Test Everything", "Cascade Lofts"])("%j is a name", (name) => {
    expect(isGenericParticipantName(name)).toBe(false);
  });
});
