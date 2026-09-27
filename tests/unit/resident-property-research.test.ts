import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

const { research } = vi.hoisted(() => ({ research: vi.fn() }));
vi.mock("@/lib/property-location-research.server", () => ({ researchPropertyLocation: research }));

import { researchMyPropertyLocationTool } from "@/lib/tools/domains/resident/property-research";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import { getMyApplicationStatusTool } from "@/lib/tools/domains/resident/lease";
import { makeResidentToolCtx } from "./tools/fake-resident-ctx";

const APPLICATION = { resident_email: "resident@example.test", property_id: "house-1", manager_user_id: "manager-1", row_data: { propertyId: "house-1", email: "resident@example.test" } };
const PROPERTY = {
  id: "house-1", manager_user_id: "manager-1", status: "live",
  property_data: { address: "12 Main St", city: "Portland", state: "OR", zip: "97201", neighborhood: "Pearl", mapLat: 45.52, mapLng: -122.68, managerNotes: "private details" },
  row_data: { address: "wrong address" },
};

function makeDb(options: { applications?: unknown[]; property?: unknown; applicationError?: Error } = {}) {
  const filters: Record<string, unknown> = {};
  const db = {
    from: vi.fn((table: string) => {
      const query: Record<string, unknown> = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn((key: string, value: unknown) => { filters[`${table}.${key}`] = value; return query; });
      query.order = vi.fn(() => query);
      query.range = vi.fn(async (from: number, to: number) => ({ data: (options.applications ?? [APPLICATION]).slice(from, to + 1), error: options.applicationError ?? null }));
      query.maybeSingle = vi.fn(async () => ({ data: options.property ?? PROPERTY, error: null }));
      return query;
    }),
  };
  return { db, filters };
}

function context(db: unknown, overrides: Partial<ResidentAgentContext> = {}) {
  return {
    kind: "resident", userId: "resident-1", email: "resident@example.test", managerIds: ["manager-1"],
    phase: "application", managerTier: "free", landlordId: "resident-1", db,
    ...overrides,
  } as ResidentAgentContext;
}

describe("resident property location research", () => {
  beforeEach(() => research.mockReset().mockResolvedValue({ verified: true, sources: [{ title: "City", url: "https://city.example" }] }));

  it("discovers an assigned property from the real application projection and researches it", async () => {
    const { ctx } = makeResidentToolCtx({
      manager_application_records: [
        { id: "app-own", manager_user_id: "manager-1", resident_email: "resident@example.test", property_id: "original-house", assigned_property_id: "house-1", row_data: { id: "app-own", property: "Main House", stage: "Approved", bucket: "approved", assignedPropertyId: "house-1", application: { propertyId: "sibling-house", ssn: "SECRET" } } },
        { id: "app-foreign", manager_user_id: "manager-1", resident_email: "foreign@example.test", property_id: "foreign-house", row_data: { id: "app-foreign", property: "Foreign House", bucket: "approved" } },
        { id: "app-other-manager", manager_user_id: "manager-2", resident_email: "resident@example.test", property_id: "other-house", row_data: { id: "app-other-manager", property: "Other House", bucket: "approved" } },
      ],
      manager_property_records: [PROPERTY],
    });
    const actor = { ...ctx, userId: "resident-1", email: "resident@example.test", activeManagerId: "manager-1" } as ResidentAgentContext;
    const status = await getMyApplicationStatusTool.handler(actor, {});
    expect(status).toMatchObject({ count: 1, applications: [{ id: "app-own", propertyId: "house-1" }] });
    expect(JSON.stringify(status)).not.toContain("SECRET");
    const propertyId = status.applications[0]?.propertyId;
    expect(propertyId).toBe("house-1");
    expect(await researchMyPropertyLocationTool.handler(actor, { propertyId: propertyId!, topic: "parks" })).toMatchObject({ found: true });
    expect(await researchMyPropertyLocationTool.handler(actor, { propertyId: "original-house", topic: "parks" })).toMatchObject({ found: false });
    expect(await researchMyPropertyLocationTool.handler(actor, { propertyId: "sibling-house", topic: "parks" })).toMatchObject({ found: false });
    expect(await researchMyPropertyLocationTool.handler(actor, { propertyId: "foreign-house", topic: "parks" })).toMatchObject({ found: false });
    expect(await researchMyPropertyLocationTool.handler(actor, { propertyId: "other-house", topic: "parks" })).toMatchObject({ found: false });
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("scopes the application, confirms a live matching property, and sends only location fields", async () => {
    const { db, filters } = makeDb();
    const result = await researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "parks" });
    expect(result).toMatchObject({ found: true, research: { verified: true } });
    expect(filters).toMatchObject({ "manager_application_records.resident_email": "resident@example.test", "manager_property_records.id": "house-1", "manager_property_records.manager_user_id": "manager-1", "manager_property_records.status": "live" });
    expect(research).toHaveBeenCalledWith({
      scopeKey: "resident:resident-1", propertyId: "house-1", topic: "parks",
      location: { address: "12 Main St", city: "Portland", state: "OR", zip: "97201", neighborhood: "Pearl", mapLat: 45.52, mapLng: -122.68 },
    });
  });

  it("falls back to the application's published listing fields when property_data is empty", async () => {
    const nested = { ...PROPERTY, property_data: {}, row_data: { submission: { address: "12 Main St", city: "Portland", state: "OR", zip: "97201", neighborhood: "Pearl", mapLat: 45.52, mapLng: -122.68, managerNotes: "must not pass" } } };
    const { db } = makeDb({ property: nested });
    await researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "parks" });
    expect(research).toHaveBeenCalledWith(expect.objectContaining({ location: { address: "12 Main St", city: "Portland", state: "OR", zip: "97201", neighborhood: "Pearl", mapLat: 45.52, mapLng: -122.68 } }));
  });

  it("fails closed when the requested property is not in the resident's application", async () => {
    const { db } = makeDb({ applications: [{ ...APPLICATION, property_id: "other-house", row_data: { propertyId: "other-house" } }] });
    const result = await researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "schools" });
    expect(result).toMatchObject({ found: false });
    expect(research).not.toHaveBeenCalled();
  });

  it("finds an authorized application after the first database page", async () => {
    const fillers = Array.from({ length: 1000 }, (_, n) => ({ ...APPLICATION, id: `app-${String(n).padStart(4, "0")}`, property_id: `other-${n}`, row_data: { propertyId: `other-${n}` } }));
    const { db } = makeDb({ applications: [...fillers, { ...APPLICATION, id: "app-last" }] });
    expect(await researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "schools" })).toMatchObject({ found: true });
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the property is not live", async () => {
    const { db } = makeDb({ property: { ...PROPERTY, status: "unlisted" } });
    const result = await researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "transit_stops" });
    expect(result).toMatchObject({ found: false });
    expect(research).not.toHaveBeenCalled();
  });

  it("does not query without the resident email and keeps the tool available in application phase", async () => {
    const { db } = makeDb();
    await researchMyPropertyLocationTool.handler(context(db, { email: " " }), { propertyId: "house-1", topic: "groceries" });
    expect(db.from).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(buildResidentRegistry(context(db, { email: "resident@example.test" })).has("research_my_property_location")).toBe(true);
  });

  it("fails closed on an application lookup error", async () => {
    const { db } = makeDb({ applicationError: new Error("database unavailable") });
    await expect(researchMyPropertyLocationTool.handler(context(db), { propertyId: "house-1", topic: "schools" })).rejects.toThrow("database unavailable");
    expect(research).not.toHaveBeenCalled();
  });
});
