import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  loadResidentPortalAccessState,
  residentPortalHomePath,
} from "@/lib/resident-portal-access";
import {
  isResidentPathAllowedForAccess,
  residentSectionLockedForStage,
  resolveResidentPortalNavStage,
} from "@/lib/resident-portal-nav";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

function makeDbMock(options: {
  applicationRows?: Array<{ row_data: unknown; updated_at?: string; resident_email?: string }>;
  profile?: { application_approved?: boolean; manager_id?: string | null } | null;
  axisRecord?: { row_data: unknown } | null;
  /** Roles held in `profile_roles` — the multi-role source of truth. */
  profileRoles?: string[];
}) {
  const { applicationRows = [], profile = null, axisRecord = null, profileRoles = [] } = options;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === "manager_application_records") {
        return {
          select: vi.fn().mockImplementation((_cols: string, opts?: { head?: boolean }) => {
            if (opts?.head) {
              return {
                eq: vi.fn().mockResolvedValue({ count: applicationRows.length, error: null }),
              };
            }
            return {
              eq: vi.fn().mockImplementation((col: string) => {
                if (col === "resident_email") {
                  return {
                    order: vi.fn().mockResolvedValue({ data: applicationRows, error: null }),
                    // Pipeline-order owner lookup: first owned application row.
                    limit: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({ data: applicationRows[0] ?? null, error: null }),
                    }),
                  };
                }
                if (col === "id") {
                  return {
                    maybeSingle: vi.fn().mockResolvedValue({ data: axisRecord, error: null }),
                  };
                }
                return {
                  order: vi.fn().mockResolvedValue({ data: applicationRows, error: null }),
                };
              }),
            };
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: profile, error: null }),
            }),
          }),
        };
      }
      if (table === "profile_roles") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation(() => ({
              eq: vi.fn().mockImplementation((_col: string, value: string) => ({
                maybeSingle: vi
                  .fn()
                  .mockResolvedValue({ data: profileRoles.includes(value) ? { role: value } : null, error: null }),
              })),
            })),
          }),
        };
      }
      if (table === "resident_tour_links") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 0, error: null }),
          }),
        };
      }
      if (table === "portal_lease_pipeline_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      };
    }),
  };
}

describe("resident portal access state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks pre-application residents before any submission", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbMock({ applicationRows: [] }) as never);

    const access = await loadResidentPortalAccessState({
      userId: "user-1",
      role: "resident",
      email: "resident@example.com",
    });

    expect(access.hasSubmittedApplication).toBe(false);
    expect(access.isPreApplicationResident).toBe(true);
    expect(residentPortalHomePath(access)).toBe("/resident/applications/apply");
  });

  it("sends tour-only residents to the tour workspace", async () => {
    const db = makeDbMock({ applicationRows: [] });
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === "resident_tour_links") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ count: 1, error: null }),
          }),
        } as never;
      }
      return makeDbMock({ applicationRows: [] }).from(table);
    });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);

    const access = await loadResidentPortalAccessState({
      userId: "user-1",
      role: "resident",
      email: "resident@example.com",
    });

    expect(access.hasTourLink).toBe(true);
    expect(access.isPreLeaseResident).toBe(true);
    expect(residentPortalHomePath(access)).toBe("/resident/tour");
  });

  it("keeps application-phase home while application is pending approval", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-01-01T00:00:00Z",
            row_data: {
              id: "AXIS-ABC123",
              email: "resident@example.com",
              bucket: "pending",
              stage: "Submitted",
              property: "Test House",
            },
          },
        ],
        profile: { application_approved: false, manager_id: null },
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-1",
      role: "resident",
      email: "resident@example.com",
    });

    expect(access.hasSubmittedApplication).toBe(true);
    expect(access.hasCompletedApplicationSubmission).toBe(true);
    expect(access.isPreApplicationResident).toBe(false);
    expect(access.applicationApproved).toBe(false);
    expect(access.leaseSigned).toBe(false);
    expect(access.leaseAccessUnlocked).toBe(false);
    expect(access.fullPortalAccess).toBe(false);
    expect(access.isPreLeaseResident).toBe(true);
    expect(residentPortalHomePath(access)).toBe("/resident/dashboard");
  });

  it("does not treat in-progress drafts as completed submissions", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-01-01T00:00:00Z",
            row_data: {
              id: "AXIS-DRAFT1",
              email: "resident@example.com",
              bucket: "pending",
              stage: "In progress",
              property: "Test House",
            },
          },
        ],
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-1",
      role: "resident",
      email: "resident@example.com",
    });

    expect(access.hasSubmittedApplication).toBe(true);
    expect(access.hasCompletedApplicationSubmission).toBe(false);
  });

  // The captain's bug: the Applications tab read "Approved 1" while the nav
  // stayed at pre_approval, so Lease and Payments were locked in the sidebar AND
  // the phone bottom bar still led with Tour / Application. The resident-scoped
  // applications API keys off the `resident_email` COLUMN; this resolver used to
  // re-filter on the embedded `row_data.email` copy, so any drift between the two
  // made it blind to an approval the resident could plainly see.
  it("approves on the resident_email column even when row_data.email has drifted", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-02-01T00:00:00Z",
            resident_email: "drifted@example.com",
            row_data: {
              id: "AXIS-DRIFT1",
              email: "typed-a-different-address@example.com",
              bucket: "approved",
              stage: "Approved",
              property: "Test House",
              residentUserId: "user-drift",
            },
          },
        ],
        profile: { application_approved: false, manager_id: null },
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-drift",
      role: "resident",
      email: "drifted@example.com",
    });

    expect(access.applicationApproved).toBe(true);
    expect(access.hasCompletedApplicationSubmission).toBe(true);
  });

  it("keeps an approval when a NEWER in-progress application exists", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-03-02T00:00:00Z",
            resident_email: "second-apply@example.com",
            row_data: {
              id: "AXIS-NEWDRAFT",
              email: "second-apply@example.com",
              bucket: "pending",
              stage: "In progress",
              property: "Another House",
            },
          },
          {
            updated_at: "2026-03-01T00:00:00Z",
            resident_email: "second-apply@example.com",
            row_data: {
              id: "AXIS-APPROVED",
              email: "second-apply@example.com",
              bucket: "approved",
              stage: "Approved",
              property: "Test House",
            },
          },
        ],
        profile: { application_approved: false, manager_id: null },
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-second",
      role: "resident",
      email: "second-apply@example.com",
    });

    expect(access.applicationApproved).toBe(true);
  });

  it("ignores withdrawn applications, like the resident's own list does", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-04-01T00:00:00Z",
            resident_email: "withdrawn@example.com",
            row_data: {
              id: "AXIS-WITHDRAWN",
              email: "withdrawn@example.com",
              bucket: "pending",
              stage: "Submitted",
              property: "Test House",
              withdrawnAt: "2026-04-02T00:00:00Z",
            },
          },
        ],
        profile: { application_approved: false, manager_id: null },
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-withdrawn",
      role: "resident",
      email: "withdrawn@example.com",
    });

    expect(access.hasSubmittedApplication).toBe(false);
    expect(access.hasCompletedApplicationSubmission).toBe(false);
    expect(access.applicationApproved).toBe(false);
  });

  /**
   * Regression: production shipped a resident who is ALSO a manager. Their legacy
   * `profiles.role` stays "manager" forever, so the resolver bailed to
   * `emptyAccessState` and the portal locked Lease / House details / Services /
   * Payments / Documents and bounced `/resident/lease` to the apply wizard —
   * while the layout guard had already let them in off `profile_roles`.
   */
  const APPROVED_MULTI_ROLE_APPLICATION = [
    {
      updated_at: "2026-01-01T00:00:00Z",
      row_data: {
        id: "PROPLANE-MULTI1",
        email: "both@example.com",
        bucket: "approved",
        stage: "Approved",
        property: "Test House",
      },
    },
  ];

  it("approves a resident whose legacy profiles.role says manager but who holds the resident role", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: APPROVED_MULTI_ROLE_APPLICATION,
        profileRoles: ["manager", "resident"],
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-both",
      role: "manager",
      email: "both@example.com",
    });

    expect(access.roleOk).toBe(true);
    expect(access.applicationApproved).toBe(true);

    // The captain's symptom, stated in nav terms: the five padlocked sections.
    const stage = resolveResidentPortalNavStage(access);
    expect(stage).toBe("post_approval_pre_lease");
    expect(residentSectionLockedForStage("lease", stage)).toBe(false);
    expect(residentSectionLockedForStage("payments", stage)).toBe(false);
    expect(residentSectionLockedForStage("documents", stage)).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease", access)).toBe(true);
  });

  /**
   * The resolver and the resident API routes must answer the same question, or
   * the portal renders a section whose routes then 403. A null/empty legacy role
   * used to short-circuit to `roleOk` here while the routes read `profile_roles`.
   */
  it("resolves an empty legacy profiles.role from profile_roles, not by admitting it", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: APPROVED_MULTI_ROLE_APPLICATION,
        profileRoles: [],
      }) as never,
    );

    const refused = await loadResidentPortalAccessState({
      userId: "user-no-roles",
      role: "",
      email: "both@example.com",
    });
    expect(refused.roleOk).toBe(false);

    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: APPROVED_MULTI_ROLE_APPLICATION,
        profileRoles: ["resident"],
      }) as never,
    );

    const allowed = await loadResidentPortalAccessState({
      userId: "user-role-row-only",
      role: null,
      email: "both@example.com",
    });
    expect(allowed.roleOk).toBe(true);
  });

  it("still refuses an account that does not hold the resident role at all", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: APPROVED_MULTI_ROLE_APPLICATION,
        profileRoles: ["manager"],
      }) as never,
    );

    const access = await loadResidentPortalAccessState({
      userId: "user-mgr-only",
      role: "manager",
      email: "both@example.com",
    });

    expect(access.roleOk).toBe(false);
    expect(access.applicationApproved).toBe(false);
    expect(isResidentPathAllowedForAccess("/resident/lease", access)).toBe(false);
  });
});

describe("resident portal access state — blockingFormsPending", () => {
  const approvedRow = {
    updated_at: "2026-01-01T00:00:00Z",
    row_data: { id: "AXIS-A1", email: "resident@example.com", bucket: "approved", stage: "Approved", property: "Test House" },
  };

  function dbWithForms(forms: Array<Record<string, unknown>> | "error") {
    const base = makeDbMock({ applicationRows: [approvedRow], profile: { application_approved: true, manager_id: null } });
    const original = base.from.getMockImplementation()!;
    base.from.mockImplementation((table: string) => {
      if (table !== "resident_move_in_forms") return original(table);
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.neq = () => query;
      query.limit = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(forms === "error" ? { data: null, error: { code: "500", message: "boom" } } : { data: forms, error: null }).then(resolve);
      return query;
    });
    return base;
  }
  const load = () => loadResidentPortalAccessState({ userId: "user-1", role: "resident", email: "resident@example.com" });
  const sent = (id: string, blocks: string, extra: Record<string, unknown> = {}) => ({
    id, form_id: "f", status: "sent", sent_at: "2026-10-01T00:00:00Z", resident_user_id: "user-1", snapshot: { kind: "other", blocks }, ...extra,
  });

  it("is computed on the server from the resident's unsubmitted forms, with the form that unlocks each", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      dbWithForms([sent("a", "move_in_details"), sent("b", "lease_signing"), sent("c", "nothing")]) as never,
    );
    const access = await load();
    expect(access.blockingFormsPending).toMatchObject({ moveInDetails: true, leaseSigning: true, approval: false });
    expect(access.blockingFormsPending?.formIds).toEqual({ moveInDetails: "a", leaseSigning: "b" });
  });

  it("a resident with nothing owed has nothing blocked, and a submitted form never blocks", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(dbWithForms([sent("a", "move_in_details", { status: "submitted" })]) as never);
    expect((await load()).blockingFormsPending).toMatchObject({ moveInDetails: false, leaseSigning: false, approval: false });
  });

  it("fails closed when the forms cannot be read", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(dbWithForms("error") as never);
    expect((await load()).blockingFormsPending).toMatchObject({ moveInDetails: true, leaseSigning: true });
  });

  // This load runs on every resident page, so both forms facts come from ONE select of the
  // non-cancelled copies (AGENTS.md § Performance & egress).
  it("reads the forms table exactly once for both blockingFormsPending and hasMoveInForms", async () => {
    const db = dbWithForms([sent("a", "move_in_details")]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    await load();
    expect(db.from.mock.calls.filter(([table]) => table === "resident_move_in_forms")).toHaveLength(1);
  });
});
