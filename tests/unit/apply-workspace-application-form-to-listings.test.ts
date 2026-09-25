import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDefaultListingSubmission, type ManagerCustomApplicationField } from "@/lib/manager-listing-submission";
import { emptyWorkspaceApplicationFormTemplate, type WorkspaceApplicationFormTemplate } from "@/lib/rental-application/workspace-application-form";
import { pushWorkspaceApplicationFormToFollowingListings } from "@/lib/rental-application/apply-workspace-application-form-to-listings.server";

type Row = {
  id: string;
  workspace_id: string;
  row_data: Record<string, unknown>;
  property_data: Record<string, unknown>;
};

function makeDb(rows: Row[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "manager_property_records") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: async (_col: string, workspaceId: string) => ({
            data: rows.filter((row) => row.workspace_id === workspaceId),
            error: null,
          }),
        }),
        update: (patch: Partial<Row>) => ({
          eq: async (_col: string, id: string) => {
            const row = rows.find((candidate) => candidate.id === id);
            if (row) Object.assign(row, patch);
            return { error: null };
          },
        }),
      };
    },
  } as unknown as SupabaseClient;
}

function question(overrides: Partial<ManagerCustomApplicationField> = {}): ManagerCustomApplicationField {
  return {
    id: overrides.id ?? "ws1",
    key: overrides.key ?? "workspace-question",
    label: overrides.label ?? "Workspace question",
    type: overrides.type ?? "text",
    required: overrides.required ?? false,
    options: overrides.options ?? [],
    section: overrides.section,
    standardKey: overrides.standardKey,
    description: overrides.description,
    showIf: overrides.showIf,
  };
}

function newTemplate(overrides: Partial<WorkspaceApplicationFormTemplate> = {}): WorkspaceApplicationFormTemplate {
  return {
    ...emptyWorkspaceApplicationFormTemplate(),
    customApplicationFields: [question()],
    applicationConfigMode: "custom",
    ...overrides,
  };
}

function listingRow(
  id: string,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
  storage: "property_data" | "row_data" = "property_data",
): Row {
  const submission = { ...createDefaultListingSubmission(), ...overrides };
  return {
    id,
    workspace_id: workspaceId,
    row_data: storage === "row_data" ? { submission } : {},
    property_data: storage === "property_data" ? { listingSubmission: submission } : {},
  };
}

function storedSubmission(row: Row): Record<string, unknown> {
  const property = (row.property_data.listingSubmission ?? {}) as Record<string, unknown>;
  const pending = (row.row_data.submission ?? {}) as Record<string, unknown>;
  return Object.keys(property).length > 0 ? property : pending;
}

describe("pushWorkspaceApplicationFormToFollowingListings", () => {
  it("copies the resolved triplet onto a following listing's stored submission (property_data)", async () => {
    const rows = [listingRow("prop-1", "ws-a")];
    const db = makeDb(rows);
    const template = newTemplate();

    const result = await pushWorkspaceApplicationFormToFollowingListings(db, "ws-a", template);

    expect(result.listingsUpdated).toBe(1);
    const submission = storedSubmission(rows[0]);
    expect(submission.customApplicationFields).toEqual(template.customApplicationFields);
    expect(submission.applicationConfigMode).toBe("custom");
    expect(submission.shortTermCustomApplicationFields).toEqual(template.shortTermCustomApplicationFields);
    expect(submission.cosignerCustomApplicationFields).toEqual(template.cosignerCustomApplicationFields);
  });

  it("copies onto a pending listing's stored submission (row_data) too", async () => {
    const rows = [listingRow("prop-pending", "ws-a", {}, "row_data")];
    const db = makeDb(rows);
    const template = newTemplate();

    const result = await pushWorkspaceApplicationFormToFollowingListings(db, "ws-a", template);

    expect(result.listingsUpdated).toBe(1);
    const submission = storedSubmission(rows[0]);
    expect(submission.customApplicationFields).toEqual(template.customApplicationFields);
  });

  it("leaves a listing with applicationFormSource: 'custom' untouched", async () => {
    const ownField = question({ id: "own1", key: "own-question", label: "Listing-only question" });
    const rows = [
      listingRow("prop-custom", "ws-a", {
        applicationFormSource: "custom",
        customApplicationFields: [ownField],
        applicationConfigMode: "custom",
      }),
    ];
    const db = makeDb(rows);
    const template = newTemplate();

    const result = await pushWorkspaceApplicationFormToFollowingListings(db, "ws-a", template);

    expect(result.listingsUpdated).toBe(0);
    const submission = storedSubmission(rows[0]);
    expect(submission.customApplicationFields).toEqual([ownField]);
  });

  it("never touches a listing in a different workspace", async () => {
    const rows = [listingRow("prop-1", "ws-a"), listingRow("prop-2", "ws-b")];
    const db = makeDb(rows);
    const template = newTemplate();

    const result = await pushWorkspaceApplicationFormToFollowingListings(db, "ws-a", template);

    expect(result.listingsUpdated).toBe(1);
    const untouched = storedSubmission(rows[1]);
    expect(untouched.customApplicationFields).toEqual([]);
  });
});
