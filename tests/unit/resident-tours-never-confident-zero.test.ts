/**
 * A failed tour read must never render as "you have no tours".
 *
 * The route used to answer HTTP 200 with `{tours: [], degraded: true}` whenever
 * the underlying read threw, and the panel cleared its own error on that flag —
 * so a resident holding a CONFIRMED tour was shown Pending 0 / Confirmed 0 /
 * Declined 0 and the "Schedule a tour" empty state. Two real bookings landed
 * and the list still read zero.
 *
 * These lock the server half. The client half is
 * `resident-tour-panel-load-failure.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getResidentTours } from "@/app/api/portal-resident-tours/route";

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(),
}));
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(),
  hasAdminRole: vi.fn(() => false),
  hasRole: vi.fn(() => false),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/auth/ensure-resident-portal-access.server", () => ({
  ensureMayAccessResidentPortal: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/tour-resident-link.server", () => ({
  loadResidentTourViews: vi.fn(),
  linkAllTourInquiriesForEmail: vi.fn(),
}));

import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadResidentTourViews, linkAllTourInquiriesForEmail } from "@/lib/tour-resident-link.server";

function signInResident() {
  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
  vi.mocked(hasRole).mockImplementation((_ctx, role) => role === "resident");
  vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
    user: { id: "res-1", email: "res@example.com", email_confirmed_at: "confirmed" },
    profile: { role: "resident", email: "res@example.com" },
  } as never);
}

describe("GET /api/portal-resident-tours never reports a failure as zero tours", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "res-1", email: "res@example.com", email_confirmed_at: "confirmed" },
      profile: null,
      roles: [],
      effectiveRole: null,
    } as never);
  });

  it("fails with an error when the resident_tour_links read throws", async () => {
    signInResident();
    vi.mocked(loadResidentTourViews).mockRejectedValue(
      new Error("Could not find the table 'public.resident_tour_links' in the schema cache"),
    );

    const res = await getResidentTours();

    expect(res.status).toBe(503);
    const body = (await res.json()) as { tours?: unknown[]; error?: string; degraded?: boolean };
    // The exact shape that shipped the bug: a 200 carrying an empty list.
    expect(res.status).not.toBe(200);
    expect(body.tours).toBeUndefined();
    expect(body.error).toBeTruthy();
    expect(body.degraded).toBe(true);
  });

  it("fails with an error on any other read failure", async () => {
    signInResident();
    vi.mocked(loadResidentTourViews).mockRejectedValue(new Error("connection reset"));

    const res = await getResidentTours();

    expect(res.status).toBe(500);
    const body = (await res.json()) as { tours?: unknown[]; error?: string };
    expect(body.tours).toBeUndefined();
    expect(body.error).toBe("connection reset");
  });

  it("still answers 200 with an empty list when the resident genuinely has no tours", async () => {
    signInResident();
    vi.mocked(linkAllTourInquiriesForEmail).mockResolvedValue([]);
    vi.mocked(loadResidentTourViews).mockResolvedValue([] as never);

    const res = await getResidentTours();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { tours: unknown[]; degraded?: boolean };
    expect(body.tours).toEqual([]);
    expect(body.degraded).toBeUndefined();
    expect(linkAllTourInquiriesForEmail).not.toHaveBeenCalled();
  });
});
