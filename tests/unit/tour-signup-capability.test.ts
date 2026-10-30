import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { linkTourFromCapability } from "@/lib/tour-resident-link.server";
import { issueTourSignupCapability, tourCapabilityDigest } from "@/lib/auth/tour-signup-capability.server";

const cap = { id: "cap", inquiry_id: "inq", recipient_email: "guest@example.test", manager_user_id: "manager", property_id: "property", tour_group_id: "group", consumed_at: "2026-01-01", consumed_user_id: "resident" };
const input = { userId: "resident", email: "guest@example.test", inquiryId: "inq", capabilityId: "cap" };
function setup(inquiries: object[], planned: object[]) {
  const db = createMemoryDb({ tour_signup_capabilities: [cap], resident_tour_links: [], portal_schedule_records: [
    { id: "axis_admin_partner_inquiries_v1", row_data: { payload: inquiries } },
    { id: "axis_admin_planned_events_v1", row_data: { payload: planned } },
  ] });
  db.rpc = async (fn, args) => {
    if (fn !== "bind_resident_tour_link") return { data: null, error: { message: "unknown" } };
    const rows = db.__tables.resident_tour_links;
    if (rows.some((row) => row.resident_user_id !== args?.p_user_id && (row.inquiry_id === args?.p_inquiry_id || (args?.p_group_id && row.tour_group_id === args.p_group_id)))) return { data: false, error: null };
    rows.push({ resident_user_id: args?.p_user_id, inquiry_id: args?.p_inquiry_id });
    return { data: true, error: null };
  };
  return db;
}
describe("tour invitation capability", () => {
  it("stores only a digest for a freshly issued high entropy token", async () => {
    const db = setup([], []);
    db.rpc = async (fn, args) => {
      if (fn === "purge_expired_tour_signup_capabilities") return { data: 0, error: null };
      if (fn === "issue_tour_signup_capability") { db.__tables.tour_signup_capabilities.push({ token_digest: args?.p_digest }); return { data: true, error: null }; }
      return { data: null, error: { message: "unknown" } };
    };
    const token = await issueTourSignupCapability(db as never, { inquiryId: "i", email: "guest@example.test", managerUserId: "m", propertyId: "p" });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const row = db.__tables.tour_signup_capabilities.at(-1)!;
    expect(row.token_digest).toBe(tourCapabilityDigest(token!));
    expect(JSON.stringify(row)).not.toContain(token);
  });
  it("does not issue a token when the locked issuance rejects an existing binding", async () => {
    const db = setup([], []);
    db.rpc = async (fn) => fn === "purge_expired_tour_signup_capabilities" ? { data: 0, error: null } : { data: false, error: null };
    expect(await issueTourSignupCapability(db as never, { inquiryId: "i", email: "guest@example.test", managerUserId: "m", propertyId: "p" })).toBeNull();
  });
  it("links an exact authorized pending inquiry", async () => {
    const db = setup([{ id: "inq", kind: "tour", email: cap.recipient_email, managerUserId: "manager", propertyId: "property", tourGroupId: "group" }], []);
    expect(await linkTourFromCapability(db as never, input)).toBe(true);
    expect(db.__tables.resident_tour_links).toMatchObject([{ resident_user_id: "resident", inquiry_id: "inq" }]);
  });
  it("links a confirmed event after the inquiry was removed", async () => {
    const db = setup([], [{ kind: "tour", sourceInquiryId: "inq", managerUserId: "manager", propertyId: "property", attendeeEmail: cap.recipient_email }]);
    expect(await linkTourFromCapability(db as never, input)).toBe(true);
  });
  it("preserves the original manager provenance when the tour host changes", async () => {
    const db = setup([], [{ kind: "tour", sourceInquiryId: "inq", sourceManagerUserId: "manager", managerUserId: "new-host", propertyId: "property", attendeeEmail: cap.recipient_email }]);
    expect(await linkTourFromCapability(db as never, input)).toBe(true);
  });
  it("refuses a confirmed event with different provenance", async () => {
    const db = setup([], [{ kind: "tour", sourceInquiryId: "inq", managerUserId: "other", propertyId: "property", attendeeEmail: cap.recipient_email }]);
    expect(await linkTourFromCapability(db as never, input)).toBe(false);
    expect(db.__tables.resident_tour_links).toEqual([]);
  });
  it.each(["inq", "other-inquiry"])("refuses a prior subject binding on the inquiry or group", async (inquiryId) => {
    const db = setup([{ id: "inq", kind: "tour", email: cap.recipient_email, managerUserId: "manager", propertyId: "property", tourGroupId: "group" }], []);
    db.__tables.resident_tour_links.push({ resident_user_id: "old-subject", inquiry_id: inquiryId, tour_group_id: "group" });
    expect(await linkTourFromCapability(db as never, input)).toBe(false);
    expect(db.__tables.resident_tour_links).toHaveLength(1);
  });
  it("requires a consumed capability for the exact inquiry and mailbox", async () => {
    const db = setup([], []);
    expect(await linkTourFromCapability(db as never, { ...input, email: "other@example.test" })).toBe(false);
    expect(await linkTourFromCapability(db as never, { ...input, inquiryId: "other" })).toBe(false);
    expect(await linkTourFromCapability(db as never, { ...input, capabilityId: "missing" })).toBe(false);
  });
  it("atomically claims an unexpired, unused exact capability and limits RPC privileges", () => {
    const sql = readFileSync("supabase/migrations/20261030144000_tour_signup_capabilities.sql", "utf8");
    expect(sql).toMatch(/consumed_user_id is null or consumed_user_id = p_user_id/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(sql).toMatch(/token_digest = p_digest and inquiry_id = p_inquiry_id and recipient_email = p_email/);
    expect(sql).toMatch(/insert into public\.email_onboarding_handoffs/);
    expect(sql).toMatch(/revoke all on function public\.claim_tour_signup_capability.*from public, anon, authenticated/);
    expect(sql).toMatch(/public\.account_identity_hash\(r\.resident_user_id::text\)/);
    expect(sql).toMatch(/revoke insert, update, delete on public\.resident_tour_links from public, anon, authenticated/);
    expect(sql).toMatch(/before insert or update or delete on public\.resident_tour_links/);
    expect(sql).toMatch(/binding_key = 'inquiry:' \|\| p_inquiry_id/);
  });
});
