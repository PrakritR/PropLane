import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "../../src/lib/manager-listing-submission";

type Fixture = { id: string; name: string; actorId: string; manifest: string; outcome: "pending" | "confirmed" | "unknown"; cleanupConfirmed?: boolean };
type Snapshot = { snapshot?: { extrasByUser?: Record<string, Array<{ id?: string; buildingName?: string; managerUserId?: string; fixturePurpose?: string; adminPublishLive?: boolean }>> } };
const fixtures = new WeakMap<Page, Fixture[]>();
const purpose = "e2e-safe-isolated";

function recordIntent(fixture: Fixture, initial = false): void {
  writeFileSync(fixture.manifest, JSON.stringify({ id: fixture.id, name: fixture.name, actorId: fixture.actorId, purpose, target: "emstjswhotsnyksqhqyf", outcome: fixture.outcome, cleanupConfirmed: fixture.cleanupConfirmed === true }, null, 2), { flag: initial ? "wx" : "w", mode: 0o600 });
}

function intentPath(id: string): string {
  const dir = process.env.E2E_PRIVATE_FIXTURE_DIR;
  if (!dir || !path.isAbsolute(dir) || realpathSync(dir) !== dir) throw new Error("Set E2E_PRIVATE_FIXTURE_DIR to an absolute, owned, mode-0700 real directory for synthetic property intent manifests.");
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw new Error("Set E2E_PRIVATE_FIXTURE_DIR to an absolute, owned, mode-0700 real directory for synthetic property intent manifests.");
  return path.join(dir, `property-intent-${id}.json`);
}


function assertDev(page: Page) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const host = new URL(page.url()).hostname;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !["localhost", "127.0.0.1"].includes(host)) throw new Error("Synthetic property test requires the exact dev/test project and localhost.");
}

export async function syntheticFixtureActorId(page: Page): Promise<string> {
  assertDev(page);
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
  const actor = await syntheticFixtureActorId(page);
  const errors: Error[] = [];
  const remaining: Fixture[] = [];
  for (const fixture of tracked) {
    try {
      if (fixture.outcome !== "confirmed") throw new Error(`Synthetic property write outcome unresolved; retain ${fixture.manifest} until the runtime has settled.`);
      if (actor !== fixture.actorId || !/^e2e-safe-[0-9a-f-]{36}$/.test(fixture.id)) throw new Error("Synthetic property cleanup actor or ID mismatch.");
      const matches = (await rows(page)).filter((row) => row.id === fixture.id);
      if (matches.length !== 1 || matches[0].buildingName !== fixture.name || matches[0].managerUserId !== actor || matches[0].fixturePurpose !== purpose) throw new Error("Synthetic property cleanup ownership or marker mismatch.");
      const response = await page.request.post("/api/property-records", { data: { action: "delete", id: fixture.id } });
      if (!response.ok()) throw new Error(`Synthetic property cleanup failed (HTTP ${response.status()}).`);
      if ((await rows(page)).some((row) => row.id === fixture.id)) throw new Error("Synthetic property cleanup was not confirmed.");
      fixture.cleanupConfirmed = true;
      recordIntent(fixture);
    } catch (error) {
      remaining.push(fixture);
      errors.push(error instanceof Error ? error : new Error("Synthetic property cleanup failed."));
    }
  }
  if (remaining.length) fixtures.set(page, remaining);
  else fixtures.delete(page);
  if (errors.length) throw new AggregateError(errors, "Synthetic property cleanup incomplete.");
}

/** Only a new, uniquely named fixture may be mutated by these browser tests. */
export async function createSyntheticProperty(page: Page): Promise<{ id: string; name: string; roomId: string; roomName: string }> {
  assertDev(page);
  const actor = await syntheticFixtureActorId(page);
  const id = `e2e-safe-${randomUUID()}`;
  const name = `E2E Safe ${randomUUID()}`;
  const base = createDefaultListingSubmission();
  const draftSubmission = { ...base, buildingName: name, address: "1 Fictional Test Lane", city: "Seattle", state: "WA", zip: "98101", allowedLeaseTerms: ["12 months"], rooms: [{ ...base.rooms[0], id: `room-${randomUUID()}`, name: "Fixture Room", monthlyRent: 1000 }] };
  // Persist the same normalized, complete listing shape the portal readers consume. Keep the
  // room's stable id: channel calendars, tours, and leases all resolve rooms from this catalog.
  const listingSubmission = normalizeManagerListingSubmissionV1(draftSubmission);
  const room = listingSubmission.rooms[0];
  if (!room?.id || room.name !== "Fixture Room") throw new Error("Synthetic property room did not survive listing normalization.");
  const propertyData = { id, fixturePurpose: purpose, title: name, buildingName: name, buildingId: id, address: listingSubmission.address, zip: listingSubmission.zip, neighborhood: "Test", unitLabel: room.name, tagline: "", adminPublishLive: true, beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now", petFriendly: false, listingSubmission };
  const before = await page.request.get("/api/property-records");
  if (!before.ok() || JSON.stringify(await before.json()).includes(id)) throw new Error("Synthetic property id is not confirmed absent.");
  const rowData = { id, name, buildingName: name, address: listingSubmission.address, fixturePurpose: purpose, submission: listingSubmission };
  const fixture: Fixture = { id, name, actorId: actor, manifest: intentPath(id), outcome: "pending" };
  recordIntent(fixture, true);
  const tracked = fixtures.get(page) ?? [];
  tracked.push(fixture);
  fixtures.set(page, tracked);
  try {
    const result = await page.request.post("/api/property-records", { data: { action: "upsert", id, status: "live", rowData, propertyData } });
    if (!result.ok()) throw new Error(`Synthetic property creation failed (HTTP ${result.status()}).`);
    fixture.outcome = "confirmed";
    recordIntent(fixture);
  } catch (error) {
    fixture.outcome = "unknown";
    recordIntent(fixture);
    throw error;
  }
  const matching = (await rows(page)).filter((row) => row.id === id && row.buildingName === name && row.managerUserId === actor && row.fixturePurpose === purpose && row.adminPublishLive === true);
  if (matching.length !== 1) throw new Error("Synthetic live property ownership was not confirmed in the authenticated portfolio.");
  return { id, name, roomId: room.id, roomName: room.name };
}
