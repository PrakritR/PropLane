import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveSessionForPortal: vi.fn(),
}));
// The route gates on the resolved ROLE SET, not on `profile.role` — an admin in
// resident preview is allowed through, everyone else is not. `hasRole` /
// `hasAdminRole` stay real (they are pure reads over `ctx.roles`); only the two
// cookie-backed lookups are doubled, since neither can run outside a request.
vi.mock("@/lib/auth/portal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-access")>()),
  getPortalAccessContext: vi.fn(),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: vi.fn(),
}));
vi.mock("@/lib/auth/ensure-resident-portal-access.server", () => ({
  ensureMayAccessResidentPortal: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/tour-resident-link.server", () => ({
  linkTourInquiryToResident: vi.fn(),
}));

import { getAdminPreviewFromCookies } from "@/lib/auth/admin-preview";
import { ensureMayAccessResidentPortal } from "@/lib/auth/ensure-resident-portal-access.server";
import { getEffectiveSessionForPortal } from "@/lib/auth/effective-session";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { linkTourInquiryToResident } from "@/lib/tour-resident-link.server";
import { POST as linkTourInquiry } from "@/app/api/auth/link-tour-inquiry/route";

/** The role set the access layer resolves for this caller. */
function accessContext(roles: Array<"resident" | "manager" | "admin" | "vendor">) {
  vi.mocked(getPortalAccessContext).mockResolvedValue({
    user: null,
    profile: null,
    roles,
    effectiveRole: roles[0] ?? null,
  } as never);
}

describe("POST /api/auth/link-tour-inquiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({} as never);
    vi.mocked(getAdminPreviewFromCookies).mockResolvedValue(null as never);
    vi.mocked(ensureMayAccessResidentPortal).mockResolvedValue({ ok: true });
    accessContext([]);
  });

  it("denies unauthenticated callers", async () => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({ user: null, profile: null } as never);
    const res = await linkTourInquiry(
      jsonRequest("http://localhost/api/auth/link-tour-inquiry", {
        method: "POST",
        body: { tourInquiryId: "inq-1" },
      }),
    );
    expect(res.status).toBe(401);
    expect(linkTourInquiryToResident).not.toHaveBeenCalled();
  });

  it("promotes managers and links the tour", async () => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
      user: { id: "mgr-1", email: "mgr@example.com", email_confirmed_at: "confirmed" },
      profile: { role: "manager", email: "mgr@example.com" },
    } as never);
    accessContext(["manager"]);
    vi.mocked(linkTourInquiryToResident).mockResolvedValue({ ok: true, linked: true, inquiryId: "inq-1" });
    const res = await linkTourInquiry(
      jsonRequest("http://localhost/api/auth/link-tour-inquiry", {
        method: "POST",
        body: { tourInquiryId: "inq-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(ensureMayAccessResidentPortal).toHaveBeenCalled();
    expect(linkTourInquiryToResident).toHaveBeenCalledWith(expect.anything(), {
      userId: "mgr-1",
      inquiryId: "inq-1",
      email: "mgr@example.com",
    });
  });

  it("links a tour for authenticated residents", async () => {
    vi.mocked(getEffectiveSessionForPortal).mockResolvedValue({
      user: { id: "res-1", email: "res@example.com", email_confirmed_at: "confirmed" },
      profile: { role: "resident", email: "res@example.com" },
    } as never);
    accessContext(["resident"]);
    vi.mocked(linkTourInquiryToResident).mockResolvedValue({ ok: true, linked: true, inquiryId: "inq-1" });
    const res = await linkTourInquiry(
      jsonRequest("http://localhost/api/auth/link-tour-inquiry", {
        method: "POST",
        body: { tourInquiryId: "inq-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(linkTourInquiryToResident).toHaveBeenCalledWith(expect.anything(), {
      userId: "res-1",
      inquiryId: "inq-1",
      email: "res@example.com",
    });
  });
});
