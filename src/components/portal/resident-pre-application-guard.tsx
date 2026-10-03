"use client";

import { isDemoModeActive } from "@/lib/demo/demo-session";
import type { ResidentPortalAccessState } from "@/lib/resident-portal-access-types";
import { isResidentPathAllowedForAccess, residentPortalHomePath } from "@/lib/resident-portal-nav";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

/** Restricts navigation based on resident portal access state. */
export function ResidentPreApplicationGuard({
  access,
  children,
}: {
  access: Pick<
    ResidentPortalAccessState,
    | "leaseAccessUnlocked"
    | "applicationApproved"
    | "hasSubmittedApplication"
    | "hasCompletedApplicationSubmission"
    | "hasTourLink"
    | "isPreLeaseResident"
  > &
    Partial<
      Pick<ResidentPortalAccessState, "isBookingResidency" | "pipelineOrder" | "hasLeaseFirstDraft">
    >;
  /** @deprecated Pass `access` instead */
  isPreApplicationResident?: boolean;
  leaseAccessUnlocked?: boolean;
  isPreLeaseResident?: boolean;
  hasCompletedApplicationSubmission?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (isDemoModeActive()) return;
    if (isResidentPathAllowedForAccess(pathname, access)) return;
    router.replace(residentPortalHomePath(access));
  }, [access, pathname, router]);

  return children;
}
