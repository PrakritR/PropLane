import { backgroundCheckStatusFromCheckr } from "@/lib/application-background-check";
import { buildCosignerScreeningRow } from "@/lib/cosigner-screening";
import { patchCosignerBackgroundCheckInCache } from "@/lib/cosigner-submissions-storage";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { buildDemoBackgroundCheck } from "@/lib/checkr/demo-simulate";
import type { CheckrPackage } from "@/lib/checkr/config";
import type { CheckrAddOnSlug } from "@/lib/checkr/packages";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { replaceManagerApplicationRowInCache } from "@/lib/manager-applications-storage";

/** Resolve a simulated Checkr report locally (demo / screening test mode). */
export function applyDemoBackgroundCheckResolution(
  signerRow: DemoApplicantRow,
  opts?: {
    cosignerSubmissionId?: string;
    cosignerSub?: CosignerSubmission;
    packageSlug?: CheckrPackage;
    addOnProducts?: CheckrAddOnSlug[];
  },
): ApplicationBackgroundCheck {
  const targetRow = opts?.cosignerSub
    ? buildCosignerScreeningRow(signerRow, opts.cosignerSub)
    : signerRow;
  const resolved = buildDemoBackgroundCheck(targetRow, {
    packageSlug: opts?.packageSlug,
    addOnProducts: opts?.addOnProducts,
  });
  if (opts?.cosignerSubmissionId) {
    patchCosignerBackgroundCheckInCache(signerRow.id, opts.cosignerSubmissionId, resolved);
  } else {
    replaceManagerApplicationRowInCache({
      ...signerRow,
      backgroundCheck: resolved,
      backgroundCheckStatus: backgroundCheckStatusFromCheckr(resolved),
    });
  }
  return resolved;
}
