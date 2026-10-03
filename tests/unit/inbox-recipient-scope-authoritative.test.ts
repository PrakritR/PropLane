import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { filterRecipientsBySenderScope, type RecipientReach } from "@/lib/inbox-recipient-scope";

/**
 * S3 + S4 (comms-safety-0929). "Only message people you're connected to" read
 * rows the sender can write (a household charge's residentEmail, the co-manager
 * relationship mirror, a vendor-directory email, a schedule row) and unioned
 * every owner an account link had ever touched. The connection now comes only
 * from authoritative rows, narrowed to the active workspace and granted houses.
 */

const OWNER = "owner-1";
const CO = "co-1";
const FRESH = "fresh-mgr";
const W1 = "ws-1";
const W2 = "ws-2";

const app = (manager: string, email: string, property: string, bucket = "approved") => ({
  manager_user_id: manager,
  resident_email: email,
  property_id: property,
  assigned_property_id: property,
  row_data: { bucket, assignedPropertyId: property },
});

const reachFor = (opts: {
  houses: string[] | null;
  untaggedOk?: boolean;
  granted?: Record<string, string[]>;
  activeWorkspaceId?: string | null;
}): RecipientReach => ({
  workspaceHouseIds: opts.houses ? new Set(opts.houses) : null,
  untaggedOk: opts.untaggedOk ?? true,
  grantedHousesByOwner: new Map(Object.entries(opts.granted ?? {}).map(([k, v]) => [k, new Set(v)])),
  activeWorkspaceId: opts.activeWorkspaceId ?? null,
});

const sender = (id: string, reach?: RecipientReach) => ({ id, email: `${id}@example.test`, role: "manager", isAdmin: false, reach });
const emails = (rows: { email: string }[]) => rows.map((r) => r.email).sort();

describe("S3 - connections come from authoritative rows only", () => {
  const db = () =>
    createMemoryDb({
      // A fresh account wrote all of these about a victim.
      portal_household_charge_records: [{ manager_user_id: FRESH, resident_email: "victim@example.test", property_id: "hx" }],
      portal_pro_relationship_records: [{ manager_user_id: FRESH, related_email: "victim@example.test", related_user_id: "victim-id" }],
      portal_schedule_records: [
        { id: "sched-1", manager_user_id: FRESH, row_data: { attendeeEmail: "victim@example.test" } },
      ],
      manager_vendor_records: [
        { manager_user_id: FRESH, vendor_user_id: null, row_data: { email: "victim@example.test", name: "Victim Plumbing" } },
      ],
      // The real thing, for contrast.
      manager_application_records: [app(OWNER, "tenant@example.test", "h1")],
    });

  it("refuses a person named only by a client-writable record", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(FRESH), [
      { email: "victim@example.test", userId: "victim-id" },
    ]);
    expect(res.allowed).toEqual([]);
    expect(emails(res.blocked)).toEqual(["victim@example.test"]);
  });

  it("still allows the manager's own applicant", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(OWNER), [
      { email: "tenant@example.test", userId: null },
    ]);
    expect(emails(res.allowed)).toEqual(["tenant@example.test"]);
  });

  it("allows only a vendor who linked their account", async () => {
    const database = createMemoryDb({
      manager_vendor_records: [
        { manager_user_id: OWNER, vendor_user_id: "vendor-user", row_data: { email: "real-vendor@example.test" } },
        { manager_user_id: OWNER, vendor_user_id: null, row_data: { email: "typed@example.test" } },
      ],
      profiles: [{ id: "vendor-user", email: "real-vendor@example.test" }],
    });
    const res = await filterRecipientsBySenderScope(database as never, sender(OWNER), [
      { email: "real-vendor@example.test", userId: "vendor-user" },
      { email: "typed@example.test", userId: null },
    ]);
    expect(emails(res.allowed)).toEqual(["real-vendor@example.test"]);
    expect(emails(res.blocked)).toEqual(["typed@example.test"]);
  });
});

describe("S4 - active workspace and granted houses narrow who can be messaged", () => {
  const db = () =>
    createMemoryDb({
      manager_application_records: [
        app(OWNER, "ws1-resident@example.test", "h1"),
        app(OWNER, "ws2-resident@example.test", "h2"),
        app(CO, "co-own-resident@example.test", "hc"),
      ],
      account_link_invites: [
        { inviter_user_id: OWNER, invitee_user_id: CO, status: "accepted", workspace_id: W1 },
      ],
      profiles: [{ id: CO, email: "co@example.test" }],
    });
  const everyone = [
    { email: "ws1-resident@example.test", userId: null },
    { email: "ws2-resident@example.test", userId: null },
    { email: "co-own-resident@example.test", userId: null },
  ];

  it("an owner in workspace 1 reaches only workspace 1's residents", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(OWNER, reachFor({ houses: ["h1"], activeWorkspaceId: W1 })), everyone);
    expect(emails(res.allowed)).toEqual(["ws1-resident@example.test"]);
  });

  it("the same owner in workspace 2 reaches only workspace 2's residents", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(OWNER, reachFor({ houses: ["h2"], activeWorkspaceId: W2 })), everyone);
    expect(emails(res.allowed)).toEqual(["ws2-resident@example.test"]);
  });

  it("an owner never reaches their co-manager's own residents (no two-way union)", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(OWNER, reachFor({ houses: null })), everyone);
    expect(emails(res.allowed)).toEqual(["ws1-resident@example.test", "ws2-resident@example.test"]);
  });

  it("a co-manager granted only house h1 reaches h1's residents, not h2's, not their own owner's other houses", async () => {
    const reach = reachFor({ houses: ["h1", "h2", "hc"], granted: { [OWNER]: ["h1"] }, activeWorkspaceId: W1 });
    const res = await filterRecipientsBySenderScope(db() as never, sender(CO, reach), everyone);
    expect(emails(res.allowed)).toEqual(["co-own-resident@example.test", "ws1-resident@example.test"]);
    expect(emails(res.blocked)).toEqual(["ws2-resident@example.test"]);
  });

  it("a granted house outside the active workspace is out of reach", async () => {
    const reach = reachFor({ houses: ["h9"], granted: { [OWNER]: ["h1"] }, activeWorkspaceId: "other" });
    const res = await filterRecipientsBySenderScope(db() as never, sender(CO, reach), everyone);
    expect(res.allowed).toEqual([]);
  });

  it("a send with no reach at all gets only the sender's own people", async () => {
    const res = await filterRecipientsBySenderScope(db() as never, sender(CO), everyone);
    expect(emails(res.allowed)).toEqual(["co-own-resident@example.test"]);
  });

  it("a co-manager recipient counts only for the workspace they were invited to", async () => {
    const asW1 = await filterRecipientsBySenderScope(db() as never, sender(OWNER, reachFor({ houses: ["h1"], activeWorkspaceId: W1 })), [{ email: "co@example.test", userId: CO }]);
    expect(emails(asW1.allowed)).toEqual(["co@example.test"]);
    const asW2 = await filterRecipientsBySenderScope(db() as never, sender(OWNER, reachFor({ houses: ["h2"], activeWorkspaceId: W2 })), [{ email: "co@example.test", userId: CO }]);
    expect(asW2.allowed).toEqual([]);
  });
});
