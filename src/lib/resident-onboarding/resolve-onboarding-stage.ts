import type { ManagerApplicationBucket } from "@/data/demo-portal";

/**
 * Where a manually onboarded resident lands, decided in ONE place.
 *
 * A manager migrating an existing portfolio knows wildly different amounts
 * about each resident: sometimes only a name and an email, sometimes a signed
 * paper lease. Both Add-resident surfaces used to answer "so where does this
 * person sit?" for themselves, and they answered differently — the residents
 * list hardcoded an Active/approved row for every save, while the document
 * import derived a bucket from the parse. Identical input produced two
 * different residents depending on which button the manager happened to press.
 *
 * This module is that single answer. It is pure and takes no storage, so both
 * surfaces can call it before they build a row, and the table it implements is
 * the thing under test rather than either screen's incidental behaviour.
 */

/**
 * What the manager said about the lease document, not what we guessed from its
 * presence.
 *
 * The distinction is load-bearing: `signed` sets `externallySignedLease`, which
 * is what `resident-portal-access.ts` reads to unlock the resident's Services
 * stage and what `lease-pipeline-storage.ts` uses to stamp `fullySignedAt`. A
 * draft filed as signed unlocks a resident as though a countersigned lease were
 * on file, so this can never be inferred from "a PDF was attached".
 */
export type ResidentLeaseFiling = "none" | "draft" | "signed";

export function normalizeResidentLeaseFiling(raw: unknown): ResidentLeaseFiling {
  // An allowlist, never a denylist: an unrecognised value must fall to the
  // weakest filing, not to the one that unlocks a portal.
  return raw === "signed" ? "signed" : raw === "draft" ? "draft" : "none";
}

export type ResidentOnboardingInput = {
  /** Trimmed by the caller or not — this module does not care about whitespace. */
  name?: string | null;
  email?: string | null;
  /** The property the resident is placed in. Absent = we do not know yet. */
  propertyId?: string | null;
  /** A room or bundle choice within that property, when one was picked. */
  roomChoice?: string | null;
  monthlyRent?: number | null;
  leaseFiling?: ResidentLeaseFiling;
};

export type ResidentOnboardingStage = {
  bucket: ManagerApplicationBucket;
  /** The `stage` string on the application row the manager's list renders. */
  stage: string;
  /**
   * `true` only for a lease the manager explicitly marked already-signed.
   * Callers spread this onto `manualResidentDetails` and must not set the flag
   * by any other route.
   */
  externallySignedLease: boolean;
  leaseFiling: ResidentLeaseFiling;
  /** True when the resident has everything and only needs to activate. */
  readyToActivate: boolean;
  /** One line for the manager, describing where this resident will land. */
  summary: string;
};

/** A resident is placed once we know which property they are in. */
export function hasPlacement(input: ResidentOnboardingInput): boolean {
  return Boolean(input.propertyId?.trim());
}

/**
 * The ladder, in the order the fields get filled in.
 *
 * | Known                     | Bucket   | Lease         | Resident sees            |
 * | ------------------------- | -------- | ------------- | ------------------------ |
 * | name + email only         | pending  | none          | invited, awaiting details|
 * | + property                | approved | none          | approved, no lease yet   |
 * | + lease filed as draft    | approved | manager review| lease coming             |
 * | + lease filed as signed   | approved | executed      | just needs to activate   |
 *
 * A filed lease implies a real tenancy even when the property was left blank,
 * so it approves on its own: refusing to approve someone whose signed lease the
 * manager just uploaded would be a stranger reading of the same evidence. It
 * does NOT invent a placement — an unplaced resident still has no property id,
 * and the manager's list shows them as needing one.
 */
export function resolveResidentOnboardingStage(
  input: ResidentOnboardingInput,
): ResidentOnboardingStage {
  const leaseFiling = normalizeResidentLeaseFiling(input.leaseFiling);
  const placed = hasPlacement(input);
  const approved = placed || leaseFiling !== "none";

  const bucket: ManagerApplicationBucket = approved ? "approved" : "pending";
  const externallySignedLease = leaseFiling === "signed";

  return {
    bucket,
    stage: approved ? "Active" : "Application",
    externallySignedLease,
    leaseFiling,
    readyToActivate: approved && externallySignedLease,
    summary: summarize({ approved, placed, leaseFiling }),
  };
}

function summarize(args: {
  approved: boolean;
  placed: boolean;
  leaseFiling: ResidentLeaseFiling;
}): string {
  if (!args.approved) {
    return "Saved as a pending applicant — add a property to move them in.";
  }
  if (args.leaseFiling === "signed") {
    return "Approved with a signed lease on file. They only need to activate their account.";
  }
  if (args.leaseFiling === "draft") {
    return "Approved. The lease is filed for your review and still needs signatures.";
  }
  return args.placed
    ? "Approved and placed. Add a lease when you have one."
    : "Approved. Add a property to place them.";
}
