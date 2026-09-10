/**
 * @vitest-environment jsdom
 *
 * Editing an existing listing in the redesigned wizard writes to THAT listing.
 *
 * Two bugs this covers, both reported from production on co-managed rows:
 *
 * 1. The wizard was never told which listing it had opened, so publishing an
 *    edit created a second listing beside the one the manager was editing.
 * 2. A co-managed listing belongs to somebody else. Ownership is never
 *    reassignable from a request body (docs/agents/property-ownership.md), so
 *    the write has to be made under the OWNER's id or it is refused.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const updateExtraListing = vi.fn();
const submitPending = vi.fn();

vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: (...args: unknown[]) => submitPending(...args),
  updateExtraListingFromSubmissionOnServer: (...args: unknown[]) => updateExtraListing(...args),
}));
vi.mock("@/lib/demo-admin-property-inventory", () => ({
  saveManagerPropertyDraftToServer: vi.fn(),
  publishManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/manager-access", () => ({
  managerTierPropertyLimitReached: () => true, // at the plan limit on purpose
  managerPropertyLimitMessage: () => "Plan limit reached.",
}));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));

import { renderHook, act } from "@testing-library/react";
import { useListingPersistence } from "@/components/portal/listing-wizard-v2/use-listing-persistence";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const sub = {} as ManagerListingSubmissionV1;

describe("publishing an edit", () => {
  beforeEach(() => {
    updateExtraListing.mockReset().mockResolvedValue(true);
    submitPending.mockReset().mockResolvedValue("new-id");
  });

  it("updates the listing it opened instead of creating another", async () => {
    const { result } = renderHook(() =>
      useListingPersistence({
        userId: "co-manager-1",
        skuTier: "free",
        propertyCount: 0,
        editListingId: "listing-9",
      }),
    );
    await act(async () => {
      const r = await result.current.publish(sub);
      expect(r).toEqual({ ok: true, id: "listing-9" });
    });
    expect(submitPending).not.toHaveBeenCalled();
    expect(updateExtraListing).toHaveBeenCalledWith(
      "listing-9",
      "co-manager-1",
      sub,
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("writes a co-managed listing under its OWNER, not the co-manager", async () => {
    const { result } = renderHook(() =>
      useListingPersistence({
        userId: "co-manager-1",
        skuTier: "free",
        propertyCount: 0,
        editListingId: "listing-9",
        editListingOwnerUserId: "owner-7",
      }),
    );
    await act(async () => {
      await result.current.publish(sub);
    });
    expect(updateExtraListing).toHaveBeenCalledWith(
      "listing-9",
      "owner-7",
      sub,
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("still saves when the account is at its plan limit — an edit takes no new slot", async () => {
    const { result } = renderHook(() =>
      useListingPersistence({
        userId: "m1",
        skuTier: "free",
        propertyCount: 99,
        editListingId: "listing-9",
      }),
    );
    await act(async () => {
      const r = await result.current.publish(sub);
      expect(r.ok).toBe(true);
    });
  });

  it("surfaces a refused save rather than reporting success", async () => {
    updateExtraListing.mockResolvedValue(false);
    const { result } = renderHook(() =>
      useListingPersistence({ userId: "m1", skuTier: "pro", propertyCount: 0, editListingId: "listing-9" }),
    );
    await act(async () => {
      const r = await result.current.publish(sub);
      expect(r.ok).toBe(false);
    });
  });

  it("repeats the server's own reason instead of blaming the connection", async () => {
    // A promo code already live on another listing is refused by the route with
    // a sentence that tells the manager what to change. Reporting "check your
    // connection" for it sends them to fix the wrong thing.
    updateExtraListing.mockImplementation(
      async (
        _id: string,
        _owner: string,
        _input: unknown,
        opts?: { onError?: (message: string) => void },
      ) => {
        opts?.onError?.(
          "Application-fee promo code: That code is already in use on another property. Give this one its own code.",
        );
        return false;
      },
    );
    const { result } = renderHook(() =>
      useListingPersistence({ userId: "m1", skuTier: "pro", propertyCount: 0, editListingId: "listing-9" }),
    );
    await act(async () => {
      const r = await result.current.publish(sub);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("already in use on another property");
      expect(r.message).not.toContain("connection");
    });
  });

  it("creates a new listing when there is no edit target", async () => {
    const { result } = renderHook(() =>
      useListingPersistence({ userId: "m1", skuTier: "pro", propertyCount: 0 }),
    );
    await act(async () => {
      await result.current.publish(sub);
    });
    expect(updateExtraListing).not.toHaveBeenCalled();
  });
});
