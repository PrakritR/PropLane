import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  reconcileListingApplicationFormOnWrite,
  recopyWorkspaceApplicationFormOntoFollowingListings,
} from "@/lib/listing-application-form-write.server";
import { emptyWorkspaceApplicationFormTemplate, type WorkspaceApplicationFormTemplate } from "@/lib/rental-application/workspace-application-form";

const OWNER = "mgr_N037";
const WORKSPACE_ID = "ws_N037";

const PET_QUESTION = {
  id: "q_pet",
  key: "pet",
  label: "Do you have a pet?",
  type: "yes_no" as const,
  required: false,
  options: [] as string[],
  section: "additional",
};
const PET_DETAILS_QUESTION = {
  id: "q_pet_details",
  key: "pet_details",
  label: "If yes, describe your pet",
  type: "text" as const,
  required: false,
  options: [] as string[],
  section: "additional",
  showIf: { fieldKey: "pet", equals: "yes" },
};

function workspaceFormWithQuestions(): WorkspaceApplicationFormTemplate {
  return {
    ...emptyWorkspaceApplicationFormTemplate(),
    customApplicationFields: [PET_QUESTION, PET_DETAILS_QUESTION],
    applicationConfigMode: "custom",
  };
}

/**
 * Minimal fake Supabase client covering only the three tables/queries this
 * module reads and writes. `updates` records every `manager_property_records`
 * update so a test can assert on it directly instead of re-reading through
 * more fake-db plumbing.
 */
function makeFakeDb(input: {
  workspaceId?: string | null;
  workspaceFormRowData?: Record<string, unknown> | null;
  properties?: Array<{ id: string; manager_user_id: string; row_data: unknown; property_data: unknown }>;
}) {
  const updates: Array<{ id: string; row_data: unknown; property_data: unknown }> = [];
  const properties = input.properties ?? [];

  const db = {
    from(table: string) {
      if (table === "portal_workspaces") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () =>
                  input.workspaceId
                    ? { data: { id: input.workspaceId }, error: null }
                    : { data: null, error: null },
              }),
            }),
          }),
        };
      }
      if (table === "workspace_automation_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                input.workspaceFormRowData
                  ? { data: { row_data: input.workspaceFormRowData }, error: null }
                  : { data: null, error: null },
            }),
          }),
        };
      }
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: async (_col: string, value: string) => ({
              data: properties.filter((p) => p.manager_user_id === value),
              error: null,
            }),
          }),
          update: (patch: { row_data: unknown; property_data: unknown }) => ({
            eq: async (_col: string, id: string) => {
              updates.push({ id, row_data: patch.row_data, property_data: patch.property_data });
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { db, updates };
}

describe("reconcileListingApplicationFormOnWrite (N037)", () => {
  it("FAILS BEFORE THE FIX: a listing that follows the workspace form never got the workspace's questions copied onto its own stored submission", async () => {
    // This assertion is the regression: before the write-time copy existed,
    // a save of a listing with no workspace form ever applied left
    // customApplicationFields exactly as submitted (empty) even though a
    // configured workspace form existed for the owner — the bug the public
    // applicant wizard and the resident-wizard both hit, since neither reads
    // through `resolveEffectiveApplicationForm`.
    const { db } = makeFakeDb({
      workspaceId: WORKSPACE_ID,
      workspaceFormRowData: { applicationFormTemplate: workspaceFormWithQuestions() },
    });

    const result = await reconcileListingApplicationFormOnWrite(db, {
      ownerUserId: OWNER,
      rowData: null,
      propertyData: { listingSubmission: { applicationFormSource: "workspace", customApplicationFields: [] } },
    });

    const submission = (result.propertyData as { listingSubmission: { customApplicationFields: unknown[] } }).listingSubmission;
    expect(submission.customApplicationFields).toHaveLength(2);
    expect(submission.customApplicationFields[0]).toMatchObject({ key: "pet" });
    expect(submission.customApplicationFields[1]).toMatchObject({ key: "pet_details" });
  });

  it("never touches a listing that opted into its own custom form", async () => {
    const { db } = makeFakeDb({
      workspaceId: WORKSPACE_ID,
      workspaceFormRowData: { applicationFormTemplate: workspaceFormWithQuestions() },
    });
    const ownField = [{ ...PET_QUESTION, key: "own_question" }];
    const result = await reconcileListingApplicationFormOnWrite(db, {
      ownerUserId: OWNER,
      rowData: null,
      propertyData: { listingSubmission: { applicationFormSource: "custom", customApplicationFields: ownField } },
    });
    const submission = (result.propertyData as { listingSubmission: { customApplicationFields: unknown[] } }).listingSubmission;
    expect(submission.customApplicationFields).toEqual(ownField);
  });

  it("leaves a submission untouched when the owner has never saved a workspace form", async () => {
    const { db } = makeFakeDb({ workspaceId: WORKSPACE_ID, workspaceFormRowData: null });
    const result = await reconcileListingApplicationFormOnWrite(db, {
      ownerUserId: OWNER,
      rowData: null,
      propertyData: { listingSubmission: { applicationFormSource: "workspace", customApplicationFields: [] } },
    });
    const submission = (result.propertyData as { listingSubmission: { customApplicationFields: unknown[] } }).listingSubmission;
    expect(submission.customApplicationFields).toEqual([]);
  });

  it("is best-effort: a database that throws on the workspace lookup still returns the original, unreconciled data", async () => {
    // A property save must never fail because this copy failed (integration
    // finding: three property-records tests' db doubles didn't stub
    // `portal_workspaces` and the unconditional lookup threw, 500ing the
    // route). Any consumer whose `.from()` doesn't recognize the new query —
    // an outdated test double, a real transient database error — must still
    // let the save proceed with the caller's original data.
    const throwingDb = {
      from: () => {
        throw new Error("boom: unexpected table");
      },
    } as unknown as SupabaseClient;
    const originalRowData = { submission: { applicationFormSource: "workspace", customApplicationFields: [] } };
    const originalPropertyData = { listingSubmission: { applicationFormSource: "workspace", customApplicationFields: [] } };
    const result = await reconcileListingApplicationFormOnWrite(throwingDb, {
      ownerUserId: OWNER,
      rowData: originalRowData,
      propertyData: originalPropertyData,
    });
    expect(result.rowData).toBe(originalRowData);
    expect(result.propertyData).toBe(originalPropertyData);
  });
});

describe("recopyWorkspaceApplicationFormOntoFollowingListings (N037)", () => {
  it("re-copies onto every following listing when the workspace form is republished, skipping a custom listing", async () => {
    const { db, updates } = makeFakeDb({
      properties: [
        { id: "prop_follow", manager_user_id: OWNER, row_data: null, property_data: { listingSubmission: { applicationFormSource: "workspace", customApplicationFields: [] } } },
        { id: "prop_custom", manager_user_id: OWNER, row_data: null, property_data: { listingSubmission: { applicationFormSource: "custom", customApplicationFields: [{ ...PET_QUESTION, key: "own" }] } } },
        { id: "prop_other_owner", manager_user_id: "someone_else", row_data: null, property_data: { listingSubmission: { applicationFormSource: "workspace", customApplicationFields: [] } } },
      ],
    });

    const { updated } = await recopyWorkspaceApplicationFormOntoFollowingListings(db, OWNER, workspaceFormWithQuestions());

    expect(updated).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe("prop_follow");
    const submission = (updates[0]!.property_data as { listingSubmission: { customApplicationFields: unknown[] } }).listingSubmission;
    expect(submission.customApplicationFields).toHaveLength(2);
  });
});
