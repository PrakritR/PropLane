/** Bounded replacement for #145; the original failure remains separate evidence. */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { persistMetadataManifest, preflightMetadataOnDev, type MetadataMirrorManifest } from "../helpers/metadata-mirror-proof";
const storageState = process.env.SPLIT_B_STORAGE_STATE;
test.use({ trace: "off", screenshot: "off", video: "off", ...(storageState ? { storageState } : {}) });
test("exact live property partial upsert preserves stored row metadata", async ({ page }) => {
  test.skip(process.env.METADATA_PROOF_RUNNER !== "1", "Dedicated metadata proof required");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const managerId = process.env.SPLIT_B_MANAGER_ID, workspaceId = process.env.SPLIT_B_WORKSPACE_ID, dir = process.env.METADATA_PROOF_DIR, expectedEmail = process.env.SPLIT_B_EXPECTED_EMAIL;
  if (url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key || !managerId || !workspaceId || !expectedEmail || !/^[a-z0-9][a-z0-9-]{10,80}@example\.invalid$/.test(expectedEmail) || !storageState || !path.isAbsolute(storageState) || (!lstatSync(storageState).isFile() || (lstatSync(storageState).mode & 0o777) !== 0o600) || !dir || !path.isAbsolute(dir)) throw new Error("Exact DEV fixture required.");
  const db = createClient(url, key, { auth: { persistSession: false } });
  let propertyId = "";
  const encoded = (await page.context().cookies()).filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/.test(cookie.name)).sort((a, b) => a.name.localeCompare(b.name)).map((cookie) => decodeURIComponent(cookie.value)).join("");
  const json = encoded.startsWith("base64-") ? Buffer.from(encoded.slice(7), "base64").toString("utf8") : encoded;
  const accessToken = (JSON.parse(json) as { access_token?: string }).access_token;
  if (!accessToken) throw new Error("Manager session unavailable.");
  const auth = await db.auth.getUser(accessToken);
  if (auth.error || auth.data.user?.id !== managerId || !auth.data.user.email_confirmed_at || auth.data.user.email?.toLowerCase() !== expectedEmail) throw new Error("Exact verified synthetic manager required.");
  const roles = await db.from("profile_roles").select("role").eq("user_id", managerId).eq("role", "manager");
  if (roles.error || roles.data?.length !== 1) throw new Error("Stored manager role required.");
  const active = await page.request.get("/api/workspaces");
  if (!active.ok() || (await active.json()).activeWorkspaceId !== workspaceId) throw new Error("Expected owned workspace must already be active.");
  propertyId = randomUUID();
  const marker = `metadata-proof-${randomUUID()}`;
  const manifest: MetadataMirrorManifest = { managerId, workspaceId, propertyId, marker, state: "reserved" };
  const file = path.join(dir, "metadata-manifest.json");
  await preflightMetadataOnDev(manifest, "absent");
  persistMetadataManifest(file, manifest);
  const rowData = { id: propertyId, name: marker, status: "live", testRunId: marker, fixturePurpose: "property-metadata-omission-preservation" };
  const address = "200 Fixture Preservation Lane";
  const listingSubmission = { v: 1, buildingName: marker, address, zip: "98101", neighborhood: "Fixture district", listingPlaceCategoryId: "private_room", tagline: "", petFriendly: false, houseOverview: "", houseRulesText: "", housePhotoDataUrls: [], allowedLeaseTerms: ["12 months"], leaseTermsBody: "", sharedSpaces: [], bathrooms: [], bundles: [], quickFacts: [], rooms: [{ id: randomUUID(), name: "Fixture room", floor: "1", monthlyRent: 1000, availability: "Now", moveInAvailableDate: "2026-10-01", manualUnavailableRanges: [], detail: "", furnishing: "Unfurnished", roomAmenitiesText: "", photoDataUrls: [], videoDataUrl: null }] };
  const propertyData = { id: propertyId, title: marker, tagline: "", address, zip: "98101", neighborhood: "Fixture district", beds: 1, baths: 1, rentLabel: "$1,000 / mo", available: "Now", petFriendly: false, buildingId: propertyId, buildingName: marker, unitLabel: "Fixture room", managerUserId: managerId, adminPublishLive: true, listingSubmission };
  const inserted = await db.from("manager_property_records").insert({ id: propertyId, manager_user_id: managerId, workspace_id: workspaceId, status: "live", row_data: rowData, property_data: propertyData });
  if (inserted.error) throw new Error("Synthetic property insert failed; manifest retained.");
  const initial = await db.from("manager_property_records").select("updated_at,row_data,property_data").eq("id", propertyId).eq("manager_user_id", managerId).eq("workspace_id", workspaceId).single();
  if (initial.error || !initial.data?.updated_at) throw new Error("Synthetic property revision unavailable.");
  expect(initial.data.row_data).toEqual(rowData);
  manifest.rowDataDigest = createHash("sha256").update(JSON.stringify(initial.data.row_data)).digest("hex");
  manifest.updatedAt = initial.data.updated_at; manifest.state = "saved"; persistMetadataManifest(file, manifest);
  await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });
  const listed = await page.request.get("/api/property-records");
  expect(listed.status()).toBe(200);
  const listedBody = await listed.json() as { snapshot?: unknown };
  expect(JSON.stringify(listedBody.snapshot)).toContain(propertyId);
  // Portfolio hydration now reads the authoritative snapshot. Exercise the
  // route's omitted-rowData contract with one explicit, authenticated write.
  const partial = await page.request.post("/api/property-records", { data: {
    action: "upsert", id: propertyId, managerUserId: managerId, status: "live",
    propertyData: initial.data.property_data,
  } });
  expect(partial.status()).toBe(200);
  const after = await db.from("manager_property_records").select("updated_at,row_data").eq("id", propertyId).eq("manager_user_id", managerId).eq("workspace_id", workspaceId).single();
  if (after.error || !after.data?.updated_at) throw new Error("Synthetic property missing after mirror.");
  expect(after.data.row_data).toEqual(initial.data.row_data);
  manifest.updatedAt = after.data.updated_at; persistMetadataManifest(file, manifest);
  await preflightMetadataOnDev(manifest, "live");
});
