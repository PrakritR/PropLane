"use client";

import { useMemo, useState } from "react";
import { ManagerBookingsWorkspace } from "@/components/portal/pro-bookings";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { ManagerBookingBucketId } from "@/lib/portal-detail-routes";

/**
 * One house's Bookings tab — same chrome as portfolio Bookings (PRP-333).
 */
export function ManagerPropertyBookingsPanel({
  propertyId,
  propertyLabel,
  submission,
}: {
  propertyId: string;
  propertyLabel: string;
  submission: ManagerListingSubmissionV1 | null;
  managerUserId: string | null;
  showToast: (message: string) => void;
}) {
  const [bucket, setBucket] = useState<ManagerBookingBucketId>("upcoming");
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [roomFilterId, setRoomFilterId] = useState("");

  const propertyOptions = useMemo(
    () => [{ id: propertyId, label: propertyLabel }],
    [propertyId, propertyLabel],
  );

  const roomOptions = useMemo(() => {
    if (!submission || isEntireHomeListing(submission)) return [];
    return submission.rooms.map((room, index) => ({
      id: room.id,
      label: room.name?.trim() || `Room ${index + 1}`,
    }));
  }, [submission]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ManagerBookingsWorkspace
        bucket={bucket}
        onBucketChange={setBucket}
        propertyIds={propertyId ? [propertyId] : []}
        propertyOptions={propertyOptions}
        showPropertyFilter={false}
        showRoomFilter={roomOptions.length > 1}
        roomOptions={roomOptions}
        roomFilterId={roomFilterId}
        onRoomFilterIdChange={setRoomFilterId}
        emptyMessage="This house is not listed yet, so it has no bookings."
        propertyTick={0}
        refreshSignal={refreshSignal}
        onRefreshSignal={() => setRefreshSignal((n) => n + 1)}
      />
    </div>
  );
}
