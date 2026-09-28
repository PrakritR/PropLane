"use client";

import { useEffect, useMemo, useState } from "react";
import { TourScheduleFlow } from "@/components/marketing/tour-schedule-flow";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PORTAL_DATA_TABLE_WRAP } from "@/components/portal/portal-data-table";
import { loadPublicPropertyLeadFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import { notifyResidentToursChanged } from "@/lib/resident-tour-sync-client";
import { useSearchParams } from "next/navigation";

export function ResidentTourScheduleClient() {
  const searchParams = useSearchParams();
  const propertyId = searchParams.get("propertyId")?.trim() ?? "";
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!propertyId) return;
    const on = () => setTick((n) => n + 1);
    void loadPublicPropertyLeadFromServer(propertyId).then(() => on());
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [propertyId]);

  const property = useMemo(() => {
    void tick;
    if (!propertyId) return undefined;
    return getPropertyForPublicLink(propertyId);
  }, [propertyId, tick]);

  return (
    <ManagerPortalPageShell title="Schedule tour" hideTitleOnMobileNav compactFilterRow>
      <div className={PORTAL_DATA_TABLE_WRAP}>
        {!propertyId || !property ? (
          <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">
            {propertyId ? "This listing is not available to tour right now." : "Choose a home from Browse to schedule a tour."}
          </div>
        ) : (
          <div className="px-4 py-4 sm:px-6 sm:py-6">
            <TourScheduleFlow
              property={property}
              returnAfterAuth="/resident/tour/pending"
              embedded
              onSuccess={notifyResidentToursChanged}
            />
          </div>
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
