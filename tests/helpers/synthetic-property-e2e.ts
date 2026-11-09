import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { createDefaultListingSubmission } from "../../src/lib/manager-listing-submission";

/** Only a new, uniquely named fixture may be mutated by these browser tests. */
export async function createSyntheticProperty(page: Page): Promise<{ id: string; name: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const host = new URL(page.url()).hostname;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !["localhost", "127.0.0.1"].includes(host)) {
    throw new Error("Synthetic property test requires the exact dev/test project and localhost.");
  }
  const id = `e2e-safe-${randomUUID()}`;
  const name = `E2E Safe ${randomUUID()}`;
  const base = createDefaultListingSubmission();
  const listingSubmission = { ...base, buildingName: name, address: "1 Fictional Test Lane", city: "Seattle", state: "WA", zip: "98101", allowedLeaseTerms: ["12 months"], rooms: [{ ...base.rooms[0], id: `room-${randomUUID()}`, name: "Fixture Room", monthlyRent: 1000 }] };
  const propertyData = { id, title: name, buildingName: name, buildingId: id, address: listingSubmission.address, zip: listingSubmission.zip, neighborhood: "Test", unitLabel: "Fixture Room", tagline: "", adminPublishLive: true, beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now", petFriendly: false, listingSubmission };
  const before = await page.request.get("/api/property-records");
  if (!before.ok() || JSON.stringify(await before.json()).includes(id)) throw new Error("Synthetic property id is not confirmed absent.");
  const result = await page.request.post("/api/property-records", { data: { action: "upsert", id, status: "live", rowData: { id, name, fixturePurpose: "e2e-safe-isolated" }, propertyData } });
  if (!result.ok()) throw new Error(`Synthetic property creation failed (HTTP ${result.status()}).`);
  const snapshot = await page.request.get("/api/property-records");
  if (!snapshot.ok()) throw new Error("Synthetic property portfolio read failed.");
  const body = await snapshot.json() as { snapshot?: { extrasByUser?: Record<string, Array<{ id?: string; buildingName?: string; adminPublishLive?: boolean }>> } };
  const matching = Object.values(body.snapshot?.extrasByUser ?? {}).flat().filter((row) => row.id === id && row.buildingName === name && row.adminPublishLive === true);
  if (matching.length !== 1) throw new Error("Synthetic live property was not confirmed in the authenticated portfolio.");
  return { id, name };
}
