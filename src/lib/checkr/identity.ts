import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";

/**
 * Whether Checkr's ID-verification product cleared for this check. Derived ONLY from the report Checkr returned
 * (re-fetched server-side), never from a request or a client flag, and never true while the check is pending, the
 * add-on was not ordered, or the product came back `consider`. No ID image or document number is ever stored:
 * the snapshot keeps the product status and reasons only; the report stays at Checkr.
 */
export function applicationIdentityVerified(
  check:
    | Pick<ApplicationBackgroundCheck, "status" | "reportSnapshot" | "addOnProducts" | "carriedIdentity">
    | null
    | undefined,
): boolean {
  if (!check || check.status !== "complete") return false;
  if (check.carriedIdentity) return check.carriedIdentity.status === "clear";
  if (!check.addOnProducts?.includes("identity_verification")) return false;
  return check.reportSnapshot?.identity_verification?.status === "clear";
}
