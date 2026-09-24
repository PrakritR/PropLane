/** Client-safe resident portal access shape (no server imports). */

export type ManagerSubscriptionTier = "free" | "paid" | null;

export type ResidentPortalAccessState = {
  roleOk: boolean;
  /**
   * True when the resident owns at least one non-withdrawn
   * `manager_application_records` row — same ownership predicate and
   * withdrawn-row exclusion as their own Applications tab.
   */
  hasSubmittedApplication: boolean;
  /** True when at least one owned application is past the in-progress draft stage. */
  hasCompletedApplicationSubmission: boolean;
  /** Resident with no submitted application yet — Applications-only portal. */
  isPreApplicationResident: boolean;
  /** True when a tour inquiry is linked to this account by record id. */
  hasTourLink: boolean;
  /** Tour booked or application submitted, but lease access not yet unlocked. */
  isPreLeaseResident: boolean;
  /** True when ANY owned application is approved, not only the most recent one. */
  applicationApproved: boolean;
  applicationId: string | null;
  applicationStage: string | null;
  applicationProperty: string | null;
  /** Both manager and resident have signed the active lease. */
  leaseSigned: boolean;
  /** Full workspace (services, payments, move-in) — requires a signed lease. */
  leaseAccessUnlocked: boolean;
  /**
   * A "Add booking" resident: created from a manager's booking, never an
   * application or lease. Unlocks Lease/Payments/Documents/Services/My home
   * the same as an approved-application-plus-signed-lease resident, but
   * Applications and Lease stay out of the nav (there is nothing there to
   * show) — see `resolveResidentPortalNavStage`'s `booking_residency` stage.
   */
  isBookingResidency: boolean;
  /**
   * A signed lease is the whole decision. The resident-role check lives in
   * `loadResidentPortalAccessState`, which is where `leaseSigned` comes from —
   * an account without the resident role gets `emptyAccessState`
   * (`leaseSigned: false`), so re-checking a role here adds nothing. Re-checking
   * the LEGACY `profiles.role` actively stranded a manager+resident with a
   * signed lease on the placeholder workspace.
   */
  fullPortalAccess: boolean;
  managerSubscriptionTier: ManagerSubscriptionTier;
  /**
   * Manager leasing pipeline order for this resident's property/workspace
   * (PLAN-0924-1254). Defaults to application-first when unknown.
   */
  pipelineOrder: "application_then_lease" | "lease_then_application";
};
