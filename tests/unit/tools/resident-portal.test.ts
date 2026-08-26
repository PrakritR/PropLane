import { describe, it, expect } from "vitest";
import { listMySharedDocumentsTool } from "@/lib/tools/domains/resident/documents";
import { reportMaintenanceIssueTool } from "@/lib/tools/domains/resident/maintenance";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";

/**
 * The two resident tools ported onto the one framework's ResidentAgentContext:
 * shared documents (Pro-gated read) and maintenance filing (a WORK ORDER, not
 * an add-on service request). Cross-resident isolation for the rest of the
 * catalog lives in tests/unit/tools/resident-scope-isolation.test.ts.
 */
const RESIDENT = { userId: "resident_a", email: "resa@axis.test" };

function docRow(over: Partial<FakeRow>): FakeRow {
  return {
    id: "doc_1",
    visibility: "resident",
    display_name: "Lease.pdf",
    category: "lease",
    created_at: "2026-07-01T00:00:00.000Z",
    deleted_at: null,
    ...over,
  };
}

describe("list_my_shared_documents", () => {
  it("returns only documents shared with this resident, by user id or email", async () => {
    const { ctx } = makeResidentToolCtx({
      manager_documents: [
        docRow({ id: "mine_by_id", resident_user_id: RESIDENT.userId }),
        docRow({ id: "mine_by_email", resident_email: RESIDENT.email }),
        docRow({ id: "theirs", resident_user_id: "resident_b" }),
      ],
    });
    const res = (await listMySharedDocumentsTool.handler(ctx, {})) as {
      count: number;
      documents: { id: string }[];
    };
    expect(res.documents.map((d) => d.id).sort()).toEqual(["mine_by_email", "mine_by_id"]);
    expect(JSON.stringify(res)).not.toContain("theirs");
  });

  it("excludes soft-deleted rows and anything not shared with residents", async () => {
    const { ctx } = makeResidentToolCtx({
      manager_documents: [
        docRow({ id: "deleted", resident_user_id: RESIDENT.userId, deleted_at: "2026-07-02T00:00:00.000Z" }),
        docRow({ id: "internal", resident_user_id: RESIDENT.userId, visibility: "manager" }),
        docRow({ id: "ok", resident_user_id: RESIDENT.userId }),
      ],
    });
    const res = (await listMySharedDocumentsTool.handler(ctx, {})) as { documents: { id: string }[] };
    expect(res.documents.map((d) => d.id)).toEqual(["ok"]);
  });
});

describe("report_maintenance_issue", () => {
  function seeded(managerIds: string[] = ["manager_1"]) {
    return makeResidentToolCtx(
      {
        manager_application_records: [
          {
            manager_user_id: "manager_1",
            resident_email: RESIDENT.email,
            updated_at: "2026-07-01T00:00:00.000Z",
            row_data: { bucket: "approved", name: "Res A", property: "Maple House", propertyId: "prop_1" },
          },
        ],
        profiles: [{ id: "manager_1", email: "mgr@axis.test", full_name: "Mgr One" }],
      },
      { managerIds },
    );
  }

  it("shows the resident exactly what will be filed", async () => {
    const { ctx } = seeded();
    const preview = await reportMaintenanceIssueTool.preview(ctx, { description: "Kitchen sink is leaking" });
    expect(preview.fields.some((f) => f.value.includes("Kitchen sink is leaking"))).toBe(true);
    expect(preview.fields.some((f) => f.value.includes(RESIDENT.email))).toBe(true);
    expect(preview.warnings?.[0]).toMatch(/manager is notified/i);
  });

  it("refuses to file anything for a resident with no linked manager", async () => {
    const { ctx } = seeded([]);
    await expect(
      reportMaintenanceIssueTool.preview(ctx, { description: "Kitchen sink is leaking" }),
    ).rejects.toThrow(/linked to a property manager/i);
  });

  it("routes an SMS maintenance proposal to the texted work-number owner", async () => {
    const { ctx } = makeResidentToolCtx(
      {
        manager_application_records: [
          {
            manager_user_id: "manager_2",
            resident_email: RESIDENT.email,
            updated_at: "2026-08-01T00:00:00.000Z",
            row_data: {
              bucket: "approved",
              name: "Res A",
              property: "Wrong Manager House",
              propertyId: "prop_2",
            },
          },
          {
            manager_user_id: "manager_1",
            resident_email: RESIDENT.email,
            updated_at: "2026-07-01T00:00:00.000Z",
            row_data: {
              bucket: "approved",
              name: "Res A",
              property: "Maple House",
              propertyId: "prop_1",
            },
          },
        ],
        profiles: [
          { id: "manager_1", email: "one@axis.test", full_name: "Mgr One" },
          { id: "manager_2", email: "two@axis.test", full_name: "Mgr Two" },
        ],
      },
      { managerIds: ["manager_1", "manager_2"], activeManagerId: "manager_1" },
    );

    const preview = await reportMaintenanceIssueTool.preview(ctx, {
      description: "Kitchen sink is leaking",
    });
    expect(preview.fields).toEqual(
      expect.arrayContaining([
        { label: "Property", value: "Maple House" },
      ]),
    );
    expect(preview.summary).toContain("Mgr One");
    expect(JSON.stringify(preview)).not.toContain("Wrong Manager House");
    expect(JSON.stringify(preview)).not.toContain("Mgr Two");
  });
});

describe("resident registry shape", () => {
  const tools = [...residentAgentRegistry.values()];

  it("gives every resident write tool a preview so nothing executes unseen", () => {
    for (const tool of tools) {
      if (tool.kind !== "write") continue;
      expect(typeof tool.preview, `${tool.name} needs a preview`).toBe("function");
      expect(typeof tool.handler, `${tool.name} needs a handler`).toBe("function");
    }
  });

  it("has unique, Anthropic-valid tool names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
