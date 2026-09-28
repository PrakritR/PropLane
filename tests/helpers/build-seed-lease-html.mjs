/**
 * Generates real AI lease HTML for test seeds using the same template pipeline
 * as the manager portal (buildAiGeneratedLeaseHtml).
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../../src");

const jiti = createJiti(import.meta.url, {
  alias: { "@": srcRoot },
  interopDefault: true,
});

const jitiLoader = (specifier) => jiti(specifier);
const leaseModule = jitiLoader(path.join(srcRoot, "lib/generated-lease.ts"));
const listingModule = jitiLoader(path.join(srcRoot, "lib/manager-listing-submission.ts"));
const buildAiGeneratedLeaseHtml = leaseModule.buildAiGeneratedLeaseHtml;
const leaseContextFromApplication = leaseModule.leaseContextFromApplication;
const normalizeManagerListingSubmissionV1 = listingModule.normalizeManagerListingSubmissionV1;

/** Build a MockProperty-shaped object from seed property_data. */
export function mockPropertyFromSeed({
  id,
  title,
  address,
  listingSubmission,
  managerUserId,
  monthlyRent,
}) {
  const zip = listingSubmission.zip ?? "";
  const neighborhood = listingSubmission.neighborhood ?? "";
  const roomCount = listingSubmission.rooms?.length ?? 1;
  return {
    id,
    title,
    tagline: listingSubmission.tagline ?? "",
    address,
    zip,
    neighborhood,
    beds: roomCount,
    baths: Math.max(1, Math.ceil(roomCount / 2)),
    rentLabel: `$${Number(monthlyRent).toLocaleString("en-US")} / mo`,
    available: "Now",
    petFriendly: Boolean(listingSubmission.petFriendly),
    buildingId: `${id}-bld`,
    buildingName: listingSubmission.buildingName ?? title,
    unitLabel: `${roomCount} room${roomCount === 1 ? "" : "s"}`,
    managerUserId,
    adminPublishLive: true,
    listingSubmission,
  };
}

/** Render jurisdiction-correct lease HTML from application + property listing data. */
export function buildSeedLeaseHtml({ application, propertyData, monthlyRent }) {
  const submission =
    propertyData.listingSubmission?.v === 1
      ? normalizeManagerListingSubmissionV1(propertyData.listingSubmission)
      : undefined;
  const mockProperty = mockPropertyFromSeed({
    id: propertyData.id,
    title: propertyData.title ?? propertyData.name ?? "Property",
    address: propertyData.address,
    listingSubmission: submission ?? propertyData.listingSubmission,
    managerUserId: propertyData.managerUserId,
    monthlyRent: monthlyRent ?? application.managerRentOverride ?? 0,
  });
  const baseCtx = leaseContextFromApplication(application);
  const ctx = {
    ...baseCtx,
    application: {
      ...baseCtx.application,
      ...application,
    },
    leasedRoom: mockProperty,
    listingProperty: mockProperty,
    submission: mockProperty.listingSubmission?.v === 1 ? mockProperty.listingSubmission : undefined,
    generatedAtIso: new Date().toISOString(),
  };
  // The builder returns an outcome, not HTML. Storing the outcome object put
  // `{ html, kind, ... }` where the app expects a string, so every seeded lease
  // read as having no document.
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") throw new Error(outcome.error ?? "Lease generation failed.");
  return outcome.html;
}
