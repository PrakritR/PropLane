// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockProperty } from "@/data/types";
import {
  appendExtraListing,
  deriveLegacyFields,
  resetPropertyPipelineClientCache,
  updatePendingManagerProperty,
  upsertPropertyRecordToServer,
  type ManagerPendingPropertyRow,
} from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const PENDING_SESSION_KEY =
  "axis_property_pipeline_cache_v1:axis_manager_pending_by_user_v1";

function acceptedFetch() {
  return vi.fn(async () =>
    ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
  );
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function listing(overrides: Partial<MockProperty> = {}): MockProperty {
  return {
    id: "mgr-payload-live",
    title: "Payload House · Unit 1",
    tagline: "Test listing",
    address: "5200 Ravenna Ave NE",
    zip: "98105",
    neighborhood: "Ravenna",
    beds: 1,
    baths: 1,
    rentLabel: "$1800",
    available: "Now",
    petFriendly: false,
    buildingId: "payload-house",
    buildingName: "Payload House",
    unitLabel: "Unit 1",
    managerUserId: "manager-payload",
    adminPublishLive: true,
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/portal/properties");
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetPropertyPipelineClientCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("property record upsert payloads", () => {
  it("omits unspecified payloads, preserves explicit clears, and strips only publicProjection", async () => {
    const fetchMock = acceptedFetch();
    vi.stubGlobal("fetch", fetchMock);

    await upsertPropertyRecordToServer({
      id: "mgr-omitted",
      managerUserId: "manager-payload",
      status: "live",
    });
    await upsertPropertyRecordToServer({
      id: "mgr-cleared",
      managerUserId: "manager-payload",
      status: "live",
      rowData: null,
      propertyData: null,
    });
    await upsertPropertyRecordToServer({
      id: "mgr-object",
      managerUserId: "manager-payload",
      status: "live",
      rowData: { marker: "owned-fixture" },
      propertyData: {
        id: "mgr-object",
        title: "Stored listing",
        publicProjection: true,
        customStoredField: "kept",
      },
    });

    const omitted = requestBody(fetchMock, 0);
    expect(omitted).not.toHaveProperty("rowData");
    expect(omitted).not.toHaveProperty("propertyData");

    expect(requestBody(fetchMock, 1)).toMatchObject({
      rowData: null,
      propertyData: null,
    });

    expect(requestBody(fetchMock, 2)).toMatchObject({
      rowData: { marker: "owned-fixture" },
      propertyData: {
        id: "mgr-object",
        title: "Stored listing",
        customStoredField: "kept",
      },
    });
    expect(requestBody(fetchMock, 2).propertyData).not.toHaveProperty(
      "publicProjection",
    );
  });

  it("keeps rowData absent when the fire-and-forget mirror sends a live listing", () => {
    const fetchMock = acceptedFetch();
    vi.stubGlobal("fetch", fetchMock);

    appendExtraListing(listing({ publicProjection: true }), "manager-payload");

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty("rowData");
    expect(body.propertyData).toMatchObject({
      id: "mgr-payload-live",
      title: "Payload House · Unit 1",
    });
    expect(body.propertyData).not.toHaveProperty("publicProjection");
  });

  it("keeps propertyData absent when the fire-and-forget mirror sends a pending row", () => {
    const managerUserId = "manager-pending-payload";
    const submission = {
      ...createDefaultListingSubmission(),
      buildingName: "Pending Payload House",
      address: "100 Test Fixture Ave",
      zip: "98105",
    };
    const pending: ManagerPendingPropertyRow = {
      ...deriveLegacyFields(submission),
      id: "pending-payload",
      submittedAt: "2026-09-19T12:00:00.000Z",
      submittedByUserId: managerUserId,
      submission,
    };
    window.sessionStorage.setItem(
      PENDING_SESSION_KEY,
      JSON.stringify({ [managerUserId]: [pending] }),
    );
    const fetchMock = acceptedFetch();
    vi.stubGlobal("fetch", fetchMock);

    expect(
      updatePendingManagerProperty(pending.id, submission, managerUserId),
    ).toBe(true);

    const body = requestBody(fetchMock);
    expect(body.rowData).toMatchObject({
      id: pending.id,
      submittedByUserId: managerUserId,
    });
    expect(body).not.toHaveProperty("propertyData");
  });
});
