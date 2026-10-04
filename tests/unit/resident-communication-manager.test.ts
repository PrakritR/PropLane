import { describe, expect, it } from "vitest";
import { resolveResidentThreadManager } from "@/lib/resident-communication-manager";

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
});
