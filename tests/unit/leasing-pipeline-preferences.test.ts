import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEASING_PIPELINE,
  effectiveLeaseSigningFeeCents,
  effectiveSharedRoomLeaseKind,
  leaseSendRequiresApprovedApplication,
  leaseUnlocksWithoutApplicationApproval,
  loadLeasingPipelineStatesByManagerId,
  normalizeLeasingPipelinePreferences,
  resolveLeasingPipelineForProperty,
  signingOrderForPipeline,
  validateLeaseSigningFeeCents,
} from "@/lib/leasing-pipeline-preferences";

describe("leasing-pipeline-preferences", () => {
  it("defaults to application-first with both required", () => {
    expect(normalizeLeasingPipelinePreferences(undefined)).toEqual(DEFAULT_LEASING_PIPELINE);
  });

  it("normalizes lease-first order", () => {
    const next = normalizeLeasingPipelinePreferences({
      pipelineOrder: "lease_then_application",
      requireApplication: false,
      leaseSigningFeeCents: 2500,
    });
    expect(next.pipelineOrder).toBe("lease_then_application");
    expect(next.requireApplication).toBe(false);
    expect(next.leaseSigningFeeCents).toBe(2500);
  });

  it("lease-first unlocks lease without approved application", () => {
    expect(
      leaseUnlocksWithoutApplicationApproval({
        ...DEFAULT_LEASING_PIPELINE,
        pipelineOrder: "lease_then_application",
      }),
    ).toBe(true);
    expect(leaseUnlocksWithoutApplicationApproval(DEFAULT_LEASING_PIPELINE)).toBe(false);
  });

  it("send gate skips approval only for lease-first or optional application", () => {
    expect(leaseSendRequiresApprovedApplication(DEFAULT_LEASING_PIPELINE)).toBe(true);
    expect(
      leaseSendRequiresApprovedApplication({
        ...DEFAULT_LEASING_PIPELINE,
        pipelineOrder: "lease_then_application",
      }),
    ).toBe(false);
    expect(
      leaseSendRequiresApprovedApplication({
        ...DEFAULT_LEASING_PIPELINE,
        requireApplication: false,
      }),
    ).toBe(false);
  });

  it("the signing order and shared-room lease default come from the workspace even when a house override stored its own", () => {
    const state = {
      portfolio: normalizeLeasingPipelinePreferences({ pipelineOrder: "lease_then_application", sharedRoomLease: "joint" }),
      byPropertyId: {
        "prop-1": normalizeLeasingPipelinePreferences({
          pipelineOrder: "application_then_lease",
          sharedRoomLease: "individual",
          leaseSigningFeeCents: 2500,
          defaultLeaseTemplateId: "lease-1",
        }),
      },
    };
    const resolved = resolveLeasingPipelineForProperty(state, "prop-1");
    expect(resolved.pipelineOrder).toBe("lease_then_application");
    expect(resolved.sharedRoomLease).toBe("joint");
    // The house still owns its own fee and default template.
    expect(resolved.leaseSigningFeeCents).toBe(2500);
    expect(resolved.defaultLeaseTemplateId).toBe("lease-1");
  });

  it("a shared room says Property default only when it follows the workspace", () => {
    expect(effectiveSharedRoomLeaseKind("property_default", { sharedRoomLease: "joint" })).toBe("joint");
    expect(effectiveSharedRoomLeaseKind(undefined, { sharedRoomLease: "joint" })).toBe("joint");
    expect(effectiveSharedRoomLeaseKind("individual", { sharedRoomLease: "joint" })).toBe("individual");
    expect(effectiveSharedRoomLeaseKind("joint", { sharedRoomLease: "individual" })).toBe("joint");
    expect(normalizeLeasingPipelinePreferences({}).sharedRoomLease).toBe("individual");
  });

  it("treats unset signing fee as free", () => {
    expect(effectiveLeaseSigningFeeCents(DEFAULT_LEASING_PIPELINE)).toBe(0);
    expect(
      effectiveLeaseSigningFeeCents({ ...DEFAULT_LEASING_PIPELINE, leaseSigningFeeCents: 0 }),
    ).toBe(0);
    expect(
      effectiveLeaseSigningFeeCents({ ...DEFAULT_LEASING_PIPELINE, leaseSigningFeeCents: 2500 }),
    ).toBe(2500);
  });

  it("rejects sub-dollar signing fees", () => {
    expect(validateLeaseSigningFeeCents(50).ok).toBe(false);
    expect(validateLeaseSigningFeeCents(0)).toEqual({ ok: true, leaseSigningFeeCents: 0 });
    expect(validateLeaseSigningFeeCents(100)).toEqual({ ok: true, leaseSigningFeeCents: 100 });
  });

  it("collapses pipelineOrder to the minimal public-safe signingOrder label", () => {
    expect(signingOrderForPipeline(DEFAULT_LEASING_PIPELINE)).toBe("application_first");
    expect(
      signingOrderForPipeline({ ...DEFAULT_LEASING_PIPELINE, pipelineOrder: "lease_then_application" }),
    ).toBe("lease_first");
  });

  it("batch-loads leasing-pipeline state for several managers in one query, keyed by manager id", async () => {
    const rows = [
      {
        manager_user_id: "mgr-lease-first",
        row_data: {
          leasingPipeline: { pipelineOrder: "lease_then_application", leaseSigningFeeCents: 5000 },
          leasingPipelineByPropertyId: { "prop-1": { pipelineOrder: "application_then_lease" } },
        },
      },
      { manager_user_id: "mgr-default", row_data: {} },
    ];
    const db = {
      from: (table: string) => {
        expect(table).toBe("manager_automation_settings");
        return {
          select: (cols: string) => {
            expect(cols).toBe("manager_user_id, row_data");
            return {
              in: (col: string, ids: string[]) => {
                expect(col).toBe("manager_user_id");
                expect(ids).toEqual(["mgr-lease-first", "mgr-default"]);
                return Promise.resolve({ data: rows, error: null });
              },
            };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const states = await loadLeasingPipelineStatesByManagerId(db, ["mgr-lease-first", "mgr-default", ""]);
    expect(states.size).toBe(2);

    const leaseFirstState = states.get("mgr-lease-first")!;
    expect(signingOrderForPipeline(leaseFirstState.portfolio)).toBe("lease_first");
    // The signing order is a workspace setting: a stored per-property order is ignored (C2-CP7).
    expect(
      signingOrderForPipeline(resolveLeasingPipelineForProperty(leaseFirstState, "prop-1")),
    ).toBe("lease_first");
    expect(
      signingOrderForPipeline(resolveLeasingPipelineForProperty(leaseFirstState, "some-other-property")),
    ).toBe("lease_first");

    const defaultState = states.get("mgr-default")!;
    expect(defaultState.portfolio).toEqual(DEFAULT_LEASING_PIPELINE);

    // A manager with no id in the batch is simply absent, never a thrown error.
    expect(states.has("mgr-never-saved")).toBe(false);
  });

  it("returns an empty map without querying when given no manager ids", async () => {
    const db = {
      from: () => {
        throw new Error("must not query with an empty id list");
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const states = await loadLeasingPipelineStatesByManagerId(db, []);
    expect(states.size).toBe(0);
  });
});
