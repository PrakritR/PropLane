import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEASING_PIPELINE,
  effectiveLeaseSigningFeeCents,
  leaseSendRequiresApprovedApplication,
  leaseUnlocksWithoutApplicationApproval,
  normalizeLeasingPipelinePreferences,
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
});
