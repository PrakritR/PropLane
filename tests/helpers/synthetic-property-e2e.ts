import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { createDefaultListingSubmission } from "../../src/lib/manager-listing-submission";

type Fixture = { id: string; name: string; actorId: string };
type Snapshot = { snapshot?: { extrasByUser?: Record<string, Array<{ id?: string; buildingName?: string; managerUserId?: string; fixturePurpose?: string; adminPublishLive?: boolean }>> } };
const fixtures = new WeakMap<Page, Fixture[]>();
const purpose = "e2e-safe-isolated";

function assertDev(page: Page) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const host = new URL(page.url()).hostname;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !["localhost", "127.0.0.1"].includes(host)) throw new Error("Synthetic property test requires the exact dev/test project and localhost.");
}

async function actorId(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const chunks = cookies.filter((c) => /^sb-emstjswhotsnyksqhqyf-auth-token(\.\d+)?$/.test(c.name)).sort((a, b) => Number(a.name.match(/\.(\d+)$/)?.[1] ?? 0) - Number(b.name.match(/\.(\d+)$/)?.[1] ?? 0)).map((c) => decodeURIComponent(c.value)).join("");
  const raw = chunks.startsWith("base64-") ? Buffer.from(chunks.slice(7), "base64").toString("utf8") : chunks;
  const id = (JSON.parse(raw) as { user?: { id?: string } }).user?.id;
  if (!id) throw new Error("Synthetic property requires an authenticated actor.");
  return id;
}

async function rows(page: Page) {
  const response = await page.request.get("/api/property-records");
  if (!response.ok()) throw new Error("Synthetic property portfolio read failed.");
  const body = await response.json() as Snapshot;
  if (!body.snapshot?.extrasByUser) throw new Error("Synthetic property portfolio is unavailable.");
  return Object.values(body.snapshot.extrasByUser).flat();
}

/** Deletes only fixtures created by this page after confirming their current identity and owner. */
export async function cleanupSyntheticProperties(page: Page): Promise<void> {
  const tracked = fixtures.get(page) ?? [];
  if (!tracked.length) return;
  assertDev(page);
  const actor = await actorId(page);
  for (const fixture of tracked) {
    if (actor !== fixture.actorId || !/^e2e-safe-[0-9a-f-]{36}$/.test(fixture.id)) throw new Error("Synthetic property cleanup actor or ID mismatch.");
    const matches = (await rows(page)).filter((row) => row.id === fixture.id);
    if (matches.length !== 1 || matches[0].buildingName !== fixture.name || matches[0].managerUserId !== actor || matches[0].fixturePurpose !== purpose) throw new Error("Synthetic property cleanup ownership or marker mismatch.");
    const response = await page.request.post("/api/property-records", { data: { action: "delete", id: fixture.id } });
    if (!response.ok()) throw new Error(`Synthetic property cleanup failed (HTTP ${response.status()}).`);
    if ((await rows(page)).some((row) => row.id === fixture.id)) throw new Error("Synthetic property cleanup was not confirmed.");
  }
  fixtures.delete(page);
}

/** Only a new, uniquely named fixture may be mutated by these browser tests. */
export async function createSyntheticProperty(page: Page): Promise<{ id: string; name: string }> {
  assertDev(page);
  const actor = await actorId(page);
  const id = `e2e-safe-${randomUUID()}`;
  const name = `E2E Safe ${randomUUID()}`;
  const base = createDefaultListingSubmission();
  const listingSubmission = { ...base, buildingName: name, address: "1 Fictional Test Lane", city: "Seattle", state: "WA", zip: "98101", allowedLeaseTerms: ["12 months"], rooms: [{ ...base.rooms[0], id: `room-${randomUUID()}`, name: "Fixture Room", monthlyRent: 1000 }] };
  const propertyData = { id, fixturePurpose: purpose, title: name, buildingName: name, buildingId: id, address: listingSubmission.address, zip: listingSubmission.zip, neighborhood: "Test", unitLabel: "Fixture Room", tagline: "", adminPublishLive: true, beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now", petFriendly: false, listingSubmission };
  const before = await page.request.get("/api/property-records");
  if (!before.ok() || JSON.stringify(await before.json()).includes(id)) throw new Error("Synthetic property id is not confirmed absent.");
  const result = await page.request.post("/api/property-records", { data: { action: "upsert", id, status: "live", rowData: { id, name, fixturePurpose: purpose }, propertyData } });
  if (!result.ok()) throw new Error(`Synthetic property creation failed (HTTP ${result.status()}).`);
  const tracked = fixtures.get(page) ?? [];
  tracked.push({ id, name, actorId: actor });
  fixtures.set(page, tracked);
  const matching = (await rows(page)).filter((row) => row.id === id && row.buildingName === name && row.managerUserId === actor && row.fixturePurpose === purpose && row.adminPublishLive === true);
  if (matching.length !== 1) throw new Error("Synthetic live property ownership was not confirmed in the authenticated portfolio.");
  return { id, name };
}
