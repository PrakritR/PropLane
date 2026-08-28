// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `repeatApplicantFeeWaived` is resolved from the caller's SESSION, so the
 * preview cache is keyed on the viewer too. Serving a signed-out answer back to
 * the same device after sign-in would charge a genuine repeat applicant a fee
 * the server would have waived.
 */

const safeBrowserGetSession = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({}),
}));
vi.mock("@/lib/supabase/safe-browser-session", () => ({
  safeBrowserGetSession: () => safeBrowserGetSession(),
}));

import {
  clearApplicationFeePreviewCacheForTests,
  fetchApplicationFeePreview,
} from "@/lib/rental-application/application-fee-preview-client";

function respondWith(body: Record<string, unknown>) {
  return Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
}

const previewInput = {
  propertyId: "prop_1",
  managerUserId: "mgr_A",
  residentEmail: "rent@example.com",
};

describe("fetchApplicationFeePreview cache keying", () => {
  beforeEach(() => {
    clearApplicationFeePreviewCacheForTests();
    safeBrowserGetSession.mockReset().mockResolvedValue({ session: null });
    vi.restoreAllMocks();
  });

  it("does not serve a signed-out answer to the signed-in viewer", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000 }))
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000, repeatApplicantFeeWaived: true }));
    vi.stubGlobal("fetch", fetchMock);

    const anonymous = await fetchApplicationFeePreview(previewInput);
    expect(anonymous?.repeatApplicantFeeWaived).toBeUndefined();

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_1" } } });
    const signedIn = await fetchApplicationFeePreview(previewInput);

    expect(signedIn?.repeatApplicantFeeWaived).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still shares one request between consumers with the same viewer", async () => {
    const fetchMock = vi.fn(() => respondWith({ applicationFeeCents: 5000, repeatApplicantFeeWaived: true }));
    vi.stubGlobal("fetch", fetchMock);
    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_1" } } });

    const [first, second] = await Promise.all([
      fetchApplicationFeePreview(previewInput),
      fetchApplicationFeePreview(previewInput),
    ]);
    const third = await fetchApplicationFeePreview(previewInput);

    expect(first?.repeatApplicantFeeWaived).toBe(true);
    expect(second?.repeatApplicantFeeWaived).toBe(true);
    expect(third?.repeatApplicantFeeWaived).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one signed-in viewer's answer to another", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000, repeatApplicantFeeWaived: true }))
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000 }));
    vi.stubGlobal("fetch", fetchMock);

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_1" } } });
    expect((await fetchApplicationFeePreview(previewInput))?.repeatApplicantFeeWaived).toBe(true);

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_2" } } });
    expect((await fetchApplicationFeePreview(previewInput))?.repeatApplicantFeeWaived).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
