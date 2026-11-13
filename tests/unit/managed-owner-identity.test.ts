/** The hidden "owner thread" and the statement header name the Property owner of record (the seat), never the admin who owns the workspace. */
import { describe, expect, it, vi } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
let PAYEE: string | null = CLIENT;
vi.mock("@/lib/managed-finance/payee.server", () => ({ resolveManagedPayee: async () => PAYEE }));
vi.mock("@/lib/service/service-owner.server", () => ({ platformServiceOwnerId: async () => ADMIN }));

import { loadManagedOwnerIdentity } from "@/lib/communication/managed-owner-thread.server";
import { ownerOfRecordName } from "@/lib/managed-finance/owner-of-record-name.server";

const profiles: Record<string, Record<string, string>> = {
  [ADMIN]: { email: "admin@proplane.test", phone: "+12065550100", full_name: "PropLane Admin" },
  [CLIENT]: { email: "Ambika@Example.com", phone: "+12065550199", full_name: "Ambika Rao" },
};
const db = {
  from: (table: string) => {
    let id = "";
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (_c: string, v: string) => ((id = v), q),
      maybeSingle: async () => ({ data: table === "portal_workspaces" ? { owner_user_id: ADMIN, is_service: true } : (profiles[id] ?? null), error: null }),
    };
    return q;
  },
} as never;

describe("managed owner identity", () => {
  it("is the client (the owner seat), not the admin who owns the workspace row", async () => {
    PAYEE = CLIENT;
    expect(await loadManagedOwnerIdentity(db, "ws")).toEqual({ ownerUserId: CLIENT, email: "ambika@example.com", phoneE164: "+12065550199" });
  });

  it("never hides the admin's own thread when no client seat exists", async () => {
    PAYEE = null;
    expect(await loadManagedOwnerIdentity(db, "ws")).toBeNull();
  });

  it("the statement header names the owner of record's profile", async () => {
    expect(await ownerOfRecordName(db, CLIENT)).toBe("Ambika Rao");
    expect(await ownerOfRecordName(db, "nobody")).toBe("Property owner");
  });
});
