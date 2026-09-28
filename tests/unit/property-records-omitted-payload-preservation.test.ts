/**
 * Background property mirrors intentionally send only one payload bucket.
 * The client must omit the other key, and this route must interpret that
 * omission as "keep the stored value". Explicit null remains the only way to
 * clear a bucket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
const MANAGER = "manager-payload-preservation";
const PROPERTY_ID = "mgr-payload-preservation";
const STORED_ROW_DATA = { marker: "owned-e2e-fixture", workspaceId: "workspace-1" };
const STORED_PROPERTY_DATA = { id: PROPERTY_ID, title: "Stored listing" };
const updateResult = vi.fn();
const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ select: updateResult }) }) }));

let existing = {
  manager_user_id: MANAGER,
  status: "live",
  row_data: STORED_ROW_DATA as unknown,
  property_data: STORED_PROPERTY_DATA as unknown,
  updated_at: "2026-09-24T00:00:00.000Z",
};
let upserts: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: null }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      // N037's reconcile reads this to find the owner's default workspace
      // before copying its application form onto the listing — none exists
      // in this fixture set, so the reconcile cleanly no-ops.
      if (table === "portal_workspaces") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }),
        }),
        update,
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
      };
    },
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  existing = {
    manager_user_id: MANAGER,
    status: "live",
    row_data: STORED_ROW_DATA,
    property_data: STORED_PROPERTY_DATA,
    updated_at: "2026-09-24T00:00:00.000Z",
  };
  upserts = [];
  updateResult.mockResolvedValue({ data: [{ id: PROPERTY_ID }], error: null });
  getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
});

describe("POST /api/property-records omitted payload preservation", () => {
  it("keeps stored row_data when a live-listing mirror sends only propertyData", async () => {
    const nextPropertyData = { id: PROPERTY_ID, title: "Mirrored listing" };

    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "live",
      propertyData: nextPropertyData,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      manager_user_id: MANAGER,
      row_data: STORED_ROW_DATA,
      property_data: nextPropertyData,
    });
  });

  it("keeps stored property_data when a pending-row mirror sends only rowData", async () => {
    const nextRowData = { marker: "owned-e2e-fixture", workspaceId: "workspace-2" };

    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "pending",
      rowData: nextRowData,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      manager_user_id: MANAGER,
      row_data: nextRowData,
      property_data: STORED_PROPERTY_DATA,
    });
  });

  it("still clears both stored payloads when null is explicit", async () => {
    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      managerUserId: MANAGER,
      status: "live",
      rowData: null,
      propertyData: null,
    });

    expect(response.status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ row_data: null, property_data: null });
  });

  it("retains published application history on explicit null and conditionally writes the saved revision", async () => {
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
    const template = publishApplicationTemplateQuestionDraft({
      ...createPropertyApplicationTemplate({ kind: "long-term" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }),
    });
    existing.property_data = { listingSubmission: { propertyApplicationTemplates: [template] } };
    const response = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: null });
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(upserts).toHaveLength(0);
    const saved = update.mock.calls[0]?.[0] as { property_data?: { listingSubmission?: { propertyApplicationTemplates?: unknown[] } } };
    expect(saved.property_data?.listingSubmission?.propertyApplicationTemplates).toEqual([template]);
  });

  it("returns a conflict when a protected-template save loses the revision race", async () => {
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
    const template = publishApplicationTemplateQuestionDraft({
      ...createPropertyApplicationTemplate({ kind: "long-term" }),
      draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }),
    });
    existing.property_data = { listingSubmission: { propertyApplicationTemplates: [template] } };
    updateResult.mockResolvedValue({ data: [], error: null });
    const response = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: {} });
    expect(response.status).toBe(409);
    expect(upserts).toHaveLength(0);
  });

  it("also conditionally writes when a legacy row_data submission holds the protected template", async () => {
    const { createPropertyApplicationTemplate, applicationTemplateQuestionConfigFromSlice, publishApplicationTemplateQuestionDraft } = await import("@/lib/property-application-templates");
    const template = publishApplicationTemplateQuestionDraft({ ...createPropertyApplicationTemplate({ kind: "long-term" }), draftQuestionConfig: applicationTemplateQuestionConfigFromSlice({ disabledStandardApplicationKeys: [], customApplicationFields: [], applicationConfigMode: "custom" }) });
    existing.row_data = { listingSubmission: { propertyApplicationTemplates: [template] } };
    updateResult.mockResolvedValue({ data: [], error: null });
    const response = await post({ action: "upsert", id: PROPERTY_ID, status: "live", rowData: { marker: "fresh" } });
    expect(response.status).toBe(409);
    expect(update).toHaveBeenCalledOnce();
    expect(upserts).toHaveLength(0);
  });

  /**
   * Regression for a real data-loss bug found during property-forms proof
   * (2026-09-27): a lease-template save returned `{"ok":true}` but the
   * template was gone after reload. Root cause: the optimistic-concurrency
   * guard below only ever looked at `propertyApplicationTemplates` — a lease
   * template save always fell through to a plain `upsert`, so any other
   * write landing after it silently overwrote it wholesale, with no 409 and
   * no signal to the caller that anything was lost. `propertyLeaseTemplates`
   * now gets the exact same protection as application templates.
   */
  it("conditionally writes (not a plain upsert) when the incoming submission holds a lease template", async () => {
    const { createPropertyLeaseTemplate } = await import("@/lib/property-lease-templates");
    const template = { ...createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" }), listingSeedKey: "primary" as const };
    const nextPropertyData = { id: PROPERTY_ID, listingSubmission: { propertyLeaseTemplates: [template] } };
    const response = await post({ action: "upsert", id: PROPERTY_ID, status: "live", propertyData: nextPropertyData });
    expect(response.status).toBe(200);
    // The critical assertion: a save that carries a lease template goes
    // through the compare-and-swap `update`, never the unguarded `upsert` —
    // exactly the same path an application-template save already takes.
    expect(update).toHaveBeenCalledOnce();
    expect(upserts).toHaveLength(0);
    const saved = update.mock.calls[0]?.[0] as { property_data?: { listingSubmission?: { propertyLeaseTemplates?: unknown[] } } };
    expect(saved.property_data?.listingSubmission?.propertyLeaseTemplates).toEqual([template]);
  });

  it("returns a conflict (never a silent overwrite) when a lease-template save loses the revision race", async () => {
    const { createPropertyLeaseTemplate } = await import("@/lib/property-lease-templates");
    const template = { ...createPropertyLeaseTemplate({ kind: "long-term", source: "axis_default" }), listingSeedKey: "primary" as const };
    existing.property_data = { listingSubmission: { propertyLeaseTemplates: [template] } };
    // Simulate another writer having already moved `updated_at` between this
    // request's read and write — the exact shape of the bug: two overlapping
    // saves, one of which used to win by silently discarding the other.
    updateResult.mockResolvedValue({ data: [], error: null });
    const response = await post({
      action: "upsert",
      id: PROPERTY_ID,
      status: "live",
      propertyData: { listingSubmission: { propertyLeaseTemplates: [] } },
    });
    expect(response.status).toBe(409);
    expect(update).toHaveBeenCalledOnce();
    // The critical assertion: no `upsert` ever ran, so the newer row in the
    // "database" (the `existing` fixture, standing in for the row another
    // writer already landed) is never blindly replaced.
    expect(upserts).toHaveLength(0);
  });

  it("also protects a lease template stored on the legacy row_data submission", async () => {
    const { createPropertyLeaseTemplate } = await import("@/lib/property-lease-templates");
    const template = { ...createPropertyLeaseTemplate({ kind: "short-term", source: "axis_default" }), listingSeedKey: "short-term" as const };
    existing.row_data = { listingSubmission: { propertyLeaseTemplates: [template] } };
    updateResult.mockResolvedValue({ data: [], error: null });
    const response = await post({ action: "upsert", id: PROPERTY_ID, status: "live", rowData: { marker: "fresh" } });
    expect(response.status).toBe(409);
    expect(update).toHaveBeenCalledOnce();
    expect(upserts).toHaveLength(0);
  });
});
