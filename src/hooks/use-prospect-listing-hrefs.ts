"use client";

import { useMemo } from "react";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  buildProspectApplyHref,
  buildProspectMessageHref,
  buildProspectTourHref,
  stageResidentListingMessageCompose,
} from "@/lib/prospect-public-nav";
import type { RentalApplyFromListingParams } from "@/lib/rental-application/apply-from-listing";

export function useProspectListingHrefs(
  propertyId: string,
  applyParams?: Omit<RentalApplyFromListingParams, "propertyId">,
) {
  const autofill = useProspectContactAutofill();
  const auth = useMemo(
    () => ({
      ready: autofill.ready,
      userId: autofill.userId,
      hasResidentRole: autofill.hasResidentRole,
    }),
    [autofill.hasResidentRole, autofill.ready, autofill.userId],
  );

  return useMemo(() => {
    const params = { propertyId, ...applyParams };
    const isResident = auth.ready && Boolean(auth.userId) && auth.hasResidentRole;
    return {
      applyHref: buildProspectApplyHref(params, auth),
      tourHref: buildProspectTourHref(propertyId, auth, {
        // Read after mount only (the cache is browser-side), so the server render and first paint agree.
        applicationFirst: auth.ready && getPropertyById(propertyId)?.applicationBeforeTour === true,
      }),
      messageHref: buildProspectMessageHref(propertyId, auth),
      isResident,
      stageMessageCompose: () => {
        if (isResident) stageResidentListingMessageCompose(propertyId);
      },
    };
  }, [applyParams, auth, propertyId]);
}
