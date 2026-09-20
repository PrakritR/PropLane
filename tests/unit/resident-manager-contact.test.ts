/**
 * "Text your manager" has to FOLLOW the lease.
 *
 * A resident moves and signs under a different manager; the number they are
 * told to text must become the new one the moment that lease is real. The
 * number is therefore never stored on the resident — it is derived on every
 * read — and these lock the derivation, including the mid-move case where
 * showing one manager silently would misroute a message at exactly the moment
 * the two houses are easiest to confuse.
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyTenancy,
  resolveResidentManagerContacts,
  resolveResidentManagerPhones,
} from "@/lib/resident-manager-contact.server";
import { applicationRowLinksResident } from "@/lib/resident-manager-scope";
import { createMemoryDb } from "./support/memory-supabase";

const workNumber = vi.fn(async (): Promise<string | null> => "+12065559000");
const workEmail = vi.fn(async (): Promise<string | null> => null);

vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: () => workNumber(),
}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveActiveManagerWorkEmail: () => workEmail(),
}));

const NOW = Date.parse("2026-10-15T12:00:00Z");

function lease(over: Record<string, unknown> = {}) {
  return {
    manager_user_id: "mgr-a",
    property_id: "prop-a",
    resident_email: "res@example.com",
    resident_user_id: "res-1",
    status: "signed",
    updated_at: "2026-10-01T00:00:00Z",
    row_data: { propertyLabel: "4709A 8th Ave NE", leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    ...over,
  };
}

describe("classifyTenancy", () => {
  it("reads a lease running today as current", () => {
    expect(classifyTenancy("2026-09-01", "2027-08-31", NOW)).toBe("current");
  });
  it("reads a lease that has not started as upcoming", () => {
    expect(classifyTenancy("2026-11-01", "2027-10-31", NOW)).toBe("upcoming");
  });
  it("reads a finished lease as ended", () => {
    expect(classifyTenancy("2025-09-01", "2026-08-31", NOW)).toBe("ended");
  });
  it("never treats a missing date as a boundary", () => {
    // No end means it has not ended; no start means it has begun. Guessing
    // either way would hide a number the resident still needs.
    expect(classifyTenancy("2026-09-01", null, NOW)).toBe("current");
    expect(classifyTenancy(null, null, NOW)).toBe("current");
  });
});

describe("resolveResidentManagerContacts", () => {
  it("returns the manager of the resident's current lease", async () => {
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()] }) as never;
    const out = await resolveResidentManagerContacts(db, {
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      nowMs: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.managerUserId).toBe("mgr-a");
    expect(out[0]!.status).toBe("current");
  });

  it("shows BOTH managers mid-move rather than picking one", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ updated_at: "2026-10-10T00:00:00Z", manager_user_id: "mgr-b", property_id: "prop-b",
          row_data: { propertyLabel: "5259 Brooklyn Ave NE", leaseStart: "2026-11-01", leaseEnd: "2027-10-31" } }),
        lease({ row_data: { propertyLabel: "4709A 8th Ave NE", leaseStart: "2026-09-01", leaseEnd: "2026-10-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out.map((c) => c.managerUserId).sort()).toEqual(["mgr-a", "mgr-b"]);
    expect(out.find((c) => c.managerUserId === "mgr-b")!.status).toBe("upcoming");
    expect(out.find((c) => c.managerUserId === "mgr-a")!.status).toBe("current");
  });

  it("keeps a former manager reachable when nothing current exists", async () => {
    // Move-out questions and the deposit return are exactly when a former
    // resident most needs to reach someone.
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ row_data: { propertyLabel: "4709A", leaseStart: "2025-09-01", leaseEnd: "2026-08-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("ended");
  });

  it("drops an ended tenancy once a live one exists", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ updated_at: "2026-10-10T00:00:00Z", manager_user_id: "mgr-b",
          row_data: { propertyLabel: "5259", leaseStart: "2026-09-15", leaseEnd: "2027-09-14" } }),
        lease({ row_data: { propertyLabel: "4709A", leaseStart: "2025-09-01", leaseEnd: "2026-08-31" } }),
      ],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out.map((c) => c.managerUserId)).toEqual(["mgr-b"]);
  });

  it("lists one manager once even across several of their leases", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease({ property_id: "prop-a" }), lease({ property_id: "prop-a2" })],
    }) as never;
    const out = await resolveResidentManagerContacts(db, { residentUserId: "res-1", nowMs: NOW });
    expect(out).toHaveLength(1);
  });

  it("returns nothing without an identity to scope by", async () => {
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()] }) as never;
    await expect(resolveResidentManagerContacts(db, {})).resolves.toEqual([]);
  });
});

describe("resolveResidentManagerContacts before a lease exists", () => {
  it("names the manager of a live application when there is no lease", async () => {
    // An applicant paying an application fee is already talking to this
    // manager in their inbox; the card must not say they have nobody to reach.
    const db = createMemoryDb({
      portal_lease_pipeline_records: [],
      manager_application_records: [
        {
          manager_user_id: "mgr-a",
          resident_email: "res@example.com",
          property_id: "prop-a",
          assigned_property_id: null,
          occupancy_start: "2026-11-01",
          updated_at: "2026-10-01T00:00:00Z",
          row_data: { bucket: "pending", propertyLabel: "Proof Oak House" },
        },
      ],
    });
    const contacts = await resolveResidentManagerContacts(db as never, { residentEmail: "res@example.com", nowMs: NOW });
    expect(contacts).toEqual([
      expect.objectContaining({ managerUserId: "mgr-a", propertyLabel: "Proof Oak House", leaseStart: "2026-11-01", status: "upcoming" }),
    ]);
  });

  it("ignores a rejected or withdrawn application", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [],
      manager_application_records: [
        { manager_user_id: "mgr-a", resident_email: "res@example.com", property_id: "prop-a", updated_at: "2026-10-01T00:00:00Z", row_data: { bucket: "rejected" } },
        { manager_user_id: "mgr-b", resident_email: "res@example.com", property_id: "prop-b", updated_at: "2026-09-01T00:00:00Z", row_data: { bucket: "withdrawn" } },
      ],
      portal_household_charge_records: [],
    });
    expect(await resolveResidentManagerContacts(db as never, { residentEmail: "res@example.com", nowMs: NOW })).toEqual([]);
  });

  it("treats a withdrawn application as no longer linking, even though its bucket stays pending", async () => {
    // A resident withdrawal (`PATCH /api/manager-applications`) stamps only
    // `row_data.withdrawnAt` and never rewrites `bucket` away from "pending" —
    // the withdrawn row above with a literal `bucket: "withdrawn"` never
    // actually occurs in stored data. This is the real shape a withdrawal
    // produces, and it must stop linking the resident just the same.
    const db = createMemoryDb({
      portal_lease_pipeline_records: [],
      manager_application_records: [
        {
          manager_user_id: "mgr-a",
          resident_email: "res@example.com",
          property_id: "prop-a",
          updated_at: "2026-10-01T00:00:00Z",
          row_data: { bucket: "pending", withdrawnAt: "2026-10-05T00:00:00Z" },
        },
      ],
      portal_household_charge_records: [],
    });
    expect(await resolveResidentManagerContacts(db as never, { residentEmail: "res@example.com", nowMs: NOW })).toEqual([]);
  });

  it("surfaces a live application at a different manager even though an earlier lease ended", async () => {
    // A former resident whose lease ended and who has since applied to a
    // different manager's house must not be stuck seeing only the old
    // manager. The fallback is gated on "no LIVE tenancy", not "no lease row
    // at all".
    const db = createMemoryDb({
      portal_lease_pipeline_records: [
        lease({ row_data: { propertyLabel: "4709A", leaseStart: "2025-09-01", leaseEnd: "2026-08-31" } }),
      ],
      manager_application_records: [
        {
          manager_user_id: "mgr-z",
          resident_email: "res@example.com",
          property_id: "prop-z",
          assigned_property_id: null,
          occupancy_start: "2026-11-01",
          updated_at: "2026-10-10T00:00:00Z",
          row_data: { bucket: "pending", propertyLabel: "New House" },
        },
      ],
    });
    const contacts = await resolveResidentManagerContacts(db as never, {
      residentUserId: "res-1",
      residentEmail: "res@example.com",
      nowMs: NOW,
    });
    expect(contacts).toEqual([
      expect.objectContaining({ managerUserId: "mgr-z", propertyLabel: "New House", status: "upcoming" }),
    ]);
  });

  it("falls through to a charge when there is neither lease nor application", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [],
      manager_application_records: [],
      portal_household_charge_records: [
        { manager_user_id: "mgr-c", resident_user_id: "res-1", resident_email: "res@example.com", updated_at: "2026-10-01T00:00:00Z", row_data: { propertyLabel: "Ash Flats 6" } },
      ],
    });
    const contacts = await resolveResidentManagerContacts(db as never, { residentUserId: "res-1", residentEmail: "res@example.com", nowMs: NOW });
    expect(contacts).toEqual([expect.objectContaining({ managerUserId: "mgr-c", propertyLabel: "Ash Flats 6", status: "current" })]);
  });

  it("never lets an application outrank a lease", async () => {
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease()],
      manager_application_records: [
        { manager_user_id: "mgr-z", resident_email: "res@example.com", property_id: "prop-z", updated_at: "2026-10-10T00:00:00Z", row_data: { bucket: "pending" } },
      ],
    });
    const contacts = await resolveResidentManagerContacts(db as never, { residentUserId: "res-1", residentEmail: "res@example.com", nowMs: NOW });
    expect(contacts.map((c) => c.managerUserId)).toEqual(["mgr-a"]);
  });
});

describe("resolveResidentManagerPhones", () => {
  const profileA = { id: "mgr-a", full_name: "Test Manager", phone: "+15103098345", email: "Manager@test.proplane.local" };

  const shareProfile = { manager_user_id: "mgr-a", row_data: { shareProfileContactWithoutWorkChannel: true } };

  it("hides the manager's profile phone and account email when no work channel is set up and sharing is off", async () => {
    // A profile phone is a personal line and this resolver also serves
    // applicants the manager has not accepted, so with the Communication
    // setting off (the default) nothing personal is disclosed (captain, 2026-09-20).
    workNumber.mockResolvedValueOnce(null);
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()], profiles: [profileA] });
    expect(await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW })).toEqual([]);
  });

  it("shows the profile phone and account email when the manager turned sharing on", async () => {
    workNumber.mockResolvedValueOnce(null);
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease()],
      profiles: [profileA],
      manager_automation_settings: [shareProfile],
    });
    const [contact] = await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW });
    expect(contact).toMatchObject({
      managerName: "Test Manager",
      phone: "+15103098345",
      phoneKind: "profile",
      email: "manager@test.proplane.local",
      emailKind: "account",
    });
  });

  it("lets the work number and work email win over the profile when they exist", async () => {
    workNumber.mockResolvedValueOnce("+12065559000");
    workEmail.mockResolvedValueOnce("oakhouse@mail.proplane.com");
    const db = createMemoryDb({ portal_lease_pipeline_records: [lease()], profiles: [profileA] });
    const [contact] = await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW });
    expect(contact).toMatchObject({
      phone: "+12065559000",
      phoneKind: "work",
      email: "oakhouse@mail.proplane.com",
      emailKind: "work",
    });
  });

  it("mixes per channel: a work number with the account email, once sharing is on", async () => {
    workNumber.mockResolvedValueOnce("+12065559000");
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease()],
      profiles: [profileA],
      manager_automation_settings: [shareProfile],
    });
    const [contact] = await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW });
    expect(contact).toMatchObject({ phoneKind: "work", email: "manager@test.proplane.local", emailKind: "account" });
  });

  it("drops a manager who has no phone and no email anywhere", async () => {
    workNumber.mockResolvedValueOnce(null);
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({
      portal_lease_pipeline_records: [lease()],
      profiles: [{ id: "mgr-a", full_name: "Ghost", phone: "  ", email: null }],
    });
    expect(await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW })).toEqual([]);
  });

  it("normalizes a free-form profile phone into E.164 before it reaches the card", async () => {
    // `PATCH /api/profile` only trims the phone it stores — no E.164
    // normalization — so a stored value like "(510) 309-8345" must not reach
    // the card's `tel:`/`sms:` hrefs unnormalized.
    workNumber.mockResolvedValueOnce(null);
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({
      manager_automation_settings: [shareProfile],
      portal_lease_pipeline_records: [lease()],
      profiles: [{ id: "mgr-a", full_name: "Test Manager", phone: "(510) 309-8345", email: "manager@test.proplane.local" }],
    });
    const [contact] = await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW });
    expect(contact).toMatchObject({ phone: "+15103098345", phoneKind: "profile" });
  });

  it("drops an unnormalizable profile phone rather than emit a broken tel/sms link", async () => {
    workNumber.mockResolvedValueOnce(null);
    workEmail.mockResolvedValueOnce(null);
    const db = createMemoryDb({
      manager_automation_settings: [shareProfile],
      portal_lease_pipeline_records: [lease()],
      profiles: [{ id: "mgr-a", full_name: "Test Manager", phone: "call the office", email: "manager@test.proplane.local" }],
    });
    const [contact] = await resolveResidentManagerPhones(db as never, { residentUserId: "res-1", nowMs: NOW });
    expect(contact).toMatchObject({ phone: null, phoneKind: null, email: "manager@test.proplane.local" });
  });
});

describe("applicationRowLinksResident (shared with resident-manager-scope.ts)", () => {
  // The contact resolver above calls this exact predicate for "which
  // applications count" so the messaging scope and the contact card cannot
  // drift apart.
  it("links a pending application", () => {
    expect(applicationRowLinksResident({ bucket: "pending" })).toBe(true);
  });
  it("does not link a rejected application", () => {
    expect(applicationRowLinksResident({ bucket: "rejected" })).toBe(false);
  });
  it("does not link a withdrawn application, even with bucket still pending", () => {
    expect(applicationRowLinksResident({ bucket: "pending", withdrawnAt: "2026-10-05T00:00:00Z" })).toBe(false);
  });
  it("does not link garbage row_data", () => {
    expect(applicationRowLinksResident(null)).toBe(false);
    expect(applicationRowLinksResident("nope")).toBe(false);
  });
});
