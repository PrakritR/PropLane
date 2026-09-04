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

function respondWith(body: Record<string, unknown>, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);
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
    expect(anonymous.preview?.repeatApplicantFeeWaived).toBeUndefined();

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_1" } } });
    const signedIn = await fetchApplicationFeePreview(previewInput);

    expect(signedIn.preview?.repeatApplicantFeeWaived).toBe(true);
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

    expect(first.preview?.repeatApplicantFeeWaived).toBe(true);
    expect(second.preview?.repeatApplicantFeeWaived).toBe(true);
    expect(third.preview?.repeatApplicantFeeWaived).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve one signed-in viewer's answer to another", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000, repeatApplicantFeeWaived: true }))
      .mockImplementationOnce(() => respondWith({ applicationFeeCents: 5000 }));
    vi.stubGlobal("fetch", fetchMock);

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_1" } } });
    expect((await fetchApplicationFeePreview(previewInput)).preview?.repeatApplicantFeeWaived).toBe(true);

    safeBrowserGetSession.mockResolvedValue({ session: { user: { id: "user_2" } } });
    expect((await fetchApplicationFeePreview(previewInput)).preview?.repeatApplicantFeeWaived).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns propertyNotFound for a missing listing without caching a fee", async () => {
    const fetchMock = vi.fn(() => respondWith({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchApplicationFeePreview({ propertyId: "missing_prop" });
    expect(result).toEqual({ preview: null, propertyNotFound: true });

    const cached = await fetchApplicationFeePreview({ propertyId: "missing_prop" });
    expect(cached.propertyNotFound).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("omits managerUserId from the request when the catalog did not have one", async () => {
    const fetchMock = vi.fn(() =>
      respondWith({ applicationFeeCents: 2500, managerUserId: "mgr_from_server" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchApplicationFeePreview({ propertyId: "prop_1" });
    expect(result.preview?.applicationFeeCents).toBe(2500);
    expect(result.managerUserId).toBe("mgr_from_server");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.managerUserId).toBeUndefined();
  });
});
