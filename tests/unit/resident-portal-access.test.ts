import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  loadResidentPortalAccessState,
  residentPortalHomePath,
  verifiedTourFallbackEmail,
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
  axisRecord?: { row_data: unknown; resident_email?: string | null } | null;
  /** Roles held in `profile_roles` — the multi-role source of truth. */
  profileRoles?: string[];
  leaseOwner?: string;
  tourOwner?: string;
}) {
  const { applicationRows = [], profile = null, axisRecord = null, profileRoles = ["resident"], leaseOwner, tourOwner } = options;

  return {
    auth: { admin: { getUserById: vi.fn(async (id: string) => ({ data: { user: { email: ({ "user-drift": "drifted@example.com", "user-second": "second-apply@example.com", "user-both": "both@example.com" } as Record<string, string>)[id] ?? "resident@example.com", email_confirmed_at: "confirmed" } }, error: null })) } },
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
            eq: vi.fn().mockImplementation((_column: string, id: string) => Promise.resolve({ count: id === tourOwner ? 1 : 0, error: null })),
          }),
        };
      }
      if (table === "portal_lease_pipeline_records") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockImplementation((_column: string, id: string) => ({
              order: vi.fn().mockResolvedValue({ data: id === leaseOwner ? [{ row_data: { managerSignature: { name: "M", signedAtIso: "now" }, residentSignature: { name: "R", signedAtIso: "now" } } }] : [], error: null }),
            })),
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

describe("resident history mailbox proof", () => {
  it.each([
    [{ email: "resident@example.com" }, ""],
    [{ email: "other@example.com", email_confirmed_at: "confirmed" }, ""],
    [{ email: "Resident@Example.com", email_confirmed_at: "confirmed" }, "resident@example.com"],
  ])("uses only a confirmed matching Auth mailbox", async (user, expected) => {
    const db = { auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }) } } };
    expect(await verifiedTourFallbackEmail(db as never, "u1", "resident@example.com")).toBe(expected);
  });
});

describe("resident portal access state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load email history when Auth mailbox is unconfirmed", async () => {
    const db = makeDbMock({ applicationRows: [{ resident_email: "resident@example.com", row_data: { id: "A", bucket: "approved", stage: "Approved" } }] });
    db.auth.admin.getUserById.mockResolvedValueOnce({ data: { user: { email: "resident@example.com", email_confirmed_at: "" } }, error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const access = await loadResidentPortalAccessState({ userId: "unconfirmed", role: "resident", email: "resident@example.com" });
    expect(access.applicationApproved).toBe(false);
    expect(access.hasSubmittedApplication).toBe(false);
  });

  it("loads phone-only exact-subject applications, leases and tours without crossing subjects", async () => {
    const db = makeDbMock({ applicationRows: [{ row_data: { id: "OWN", residentUserId: "phone-owner", bucket: "approved", stage: "Approved" } }], leaseOwner: "phone-owner", tourOwner: "phone-owner" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const owned = await loadResidentPortalAccessState({ userId: "phone-owner", role: "resident", email: "" });
    expect(owned.applicationApproved).toBe(true);
    expect(owned.leaseSigned).toBe(true);
    expect(owned.hasTourLink).toBe(true);
    const other = await loadResidentPortalAccessState({ userId: "phone-other", role: "resident", email: "" });
    expect(other.applicationApproved).toBe(false);
    expect(other.leaseSigned).toBe(false);
    expect(other.hasTourLink).toBe(false);
  });

  it("recognizes an exact subject-bound application without a mailbox", async () => {
    const db = makeDbMock({ applicationRows: [{ row_data: { id: "OWN", residentUserId: "phone-user", bucket: "approved", stage: "Approved" } }] });
    db.auth.admin.getUserById.mockResolvedValueOnce({ data: { user: { email: "phone@phone.proplane.invalid", email_confirmed_at: "" } }, error: null });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    const access = await loadResidentPortalAccessState({ userId: "phone-user", role: "resident", email: "phone@phone.proplane.invalid" });
    expect(access.applicationApproved).toBe(true);
  });

  it("never derives access from a stale profile application id owned by another email", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbMock({ profile: { manager_id: "PROPLANE-OTHER", application_approved: false }, axisRecord: { resident_email: "victim@example.com", row_data: { id: "PROPLANE-OTHER", bucket: "approved", stage: "Approved" } } }) as never);
    const access = await loadResidentPortalAccessState({ userId: "user-1", role: "resident", email: "resident@example.com" });
    expect(access.hasSubmittedApplication).toBe(false);
    expect(access.applicationApproved).toBe(false);
  });

  it("accepts the exact owned subject on the legacy application fallback", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(makeDbMock({ profile: { manager_id: "PROPLANE-OWN", application_approved: false }, axisRecord: { resident_email: " Resident@Example.com ", row_data: { id: "PROPLANE-OWN", residentUserId: "user-1", bucket: "approved", stage: "Approved" } } }) as never);
    const access = await loadResidentPortalAccessState({ userId: "user-1", role: "resident", email: "resident@example.com" });
    expect(access.hasSubmittedApplication).toBe(true);
    expect(access.applicationApproved).toBe(true);
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

  /**
   * `residentHasTourLinks` throws on every `resident_tour_links` read failure except a genuinely
   * absent table — the one error rule that table needs, and `GET /api/portal-resident-tours` still
   * answers 500 on it. But this access state is awaited by `app/resident/layout.tsx`,
   * `app/resident/page.tsx` and `renderPortalSection`, none of which has an error boundary, so
   * letting the throw escape turned a transient permission or timeout error on one table into an
   * outage of EVERY resident page.
   *
   * It is absorbed into the one field it answers. `false` is the NARROWER state (no pre-lease tour
   * nav), so this cannot widen access.
   */
  it("survives an unreadable resident_tour_links by hiding the tour nav, not by failing the portal", async () => {
    for (const error of [
      { code: "42501", message: "permission denied for table resident_tour_links" },
      { code: "57014", message: "canceling statement due to statement timeout" },
      { message: "connection reset" },
    ]) {
      const db = makeDbMock({ applicationRows: [] });
      vi.mocked(db.from).mockImplementation((table: string) => {
        if (table === "resident_tour_links") {
          return {
            select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ count: null, error }) }),
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

      expect(access.hasTourLink).toBe(false);
      expect(access.roleOk).toBe(true);
    }
  });

  it("keeps application-phase home while application is pending approval", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      makeDbMock({
        applicationRows: [
          {
            updated_at: "2026-01-01T00:00:00Z",
            row_data: {
              id: "AXIS-ABC123",
              residentUserId: "user-1",
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
              residentUserId: "user-1",
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
              residentUserId: "user-second",
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
              residentUserId: "user-second",
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
        residentUserId: "user-both",
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
      query.or = () => query;
      query.limit = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(forms === "error" ? { data: null, error: { code: "500", message: "boom" } } : { data: forms, error: null }).then(resolve);
      return query;
    });
    return base;
  }
  const load = () => loadResidentPortalAccessState({ userId: "user-1", role: "resident", email: "resident@example.com" });
  // The shape the access state's narrow select returns: the two snapshot keys, projected out of the jsonb.
  const sent = (id: string, blocks: string, extra: Record<string, unknown> = {}) => ({
    id, form_id: "f", status: "sent", sent_at: "2026-10-01T00:00:00Z", resident_user_id: "user-1",
    snapshot_kind: "other", snapshot_blocks: blocks, ...extra,
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

  // The application scope an unbound form is weighed against is the one this load already read, not
  // a second unindexed `row_data->>residentUserId` scan on every resident page.
  it("hands the forms read the application scope it already loaded, and reads the lease rows once", async () => {
    const db = dbWithForms([sent("a", "move_in_details")]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(db as never);
    await load();
    expect(db.from.mock.calls.filter(([table]) => table === "manager_application_records")).toHaveLength(1);
    expect(db.from.mock.calls.filter(([table]) => table === "portal_lease_pipeline_records")).toHaveLength(1);
  });

  // A joint lease names the co-applicant's application too. Only this resident's OWN primary
  // application may scope an unbound form; a co-applicant's unbound form never locks this resident.
  describe("joint lease: unbound forms scope to this resident's own application only", () => {
    function dbWithJointLease(forms: Array<Record<string, unknown>>) {
      const base = dbWithForms(forms);
      const original = base.from.getMockImplementation()!;
      base.from.mockImplementation((table: string) => {
        if (table !== "portal_lease_pipeline_records") return original(table);
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              order: () => Promise.resolve({
                data: id === "user-1"
                  ? [{ row_data: { axisId: "AXIS-OWN", jointLeaseMembers: [{ applicationId: "AXIS-COAPP", email: "coapp@example.com" }] } }]
                  : [],
                error: null,
              }),
            }),
          }),
        };
      });
      return base;
    }
    const unbound = (id: string, applicationId: string) =>
      sent(id, "move_in_details", { resident_user_id: null, application_id: applicationId });

    it("a co-applicant's unbound blocking form does not lock this resident", async () => {
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(dbWithJointLease([unbound("x", "AXIS-COAPP")]) as never);
      expect((await load()).blockingFormsPending).toMatchObject({ moveInDetails: false });
    });

    it("an unbound blocking form on this resident's own lease application locks move-in details", async () => {
      vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(dbWithJointLease([unbound("y", "AXIS-OWN")]) as never);
      expect((await load()).blockingFormsPending).toMatchObject({ moveInDetails: true });
    });
  });
});
