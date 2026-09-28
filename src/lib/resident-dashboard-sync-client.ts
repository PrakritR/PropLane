import { createCoalescedRefresher } from "@/lib/coalesced-refresh";
import { syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";
import { syncServiceRequestsFromServer } from "@/lib/service-requests-storage";

// Keep only active mount reads, not a second data cache. A later mount starts
// fresh, while equivalent concurrent mounts share one forced underlying read.
function mountReader<T>(scope: string, load: (viewerId: string) => Promise<T>) {
  const flights = new Map<string, ReturnType<typeof createCoalescedRefresher<T>>>();
  return (viewerId: string): Promise<T> => {
    const key = JSON.stringify([viewerId, "resident", scope]);
    let refresher = flights.get(key);
    if (!refresher) {
      refresher = createCoalescedRefresher(() => load(viewerId));
      flights.set(key, refresher);
    }
    const current = refresher;
    return current.run().finally(() => {
      if (flights.get(key) === current) flights.delete(key);
    });
  };
}

export const refreshResidentDashboardApplications = mountReader("applications:self", (viewerId) =>
  syncManagerApplicationsFromServer({ force: true, selfScope: true, managerUserId: viewerId }),
);
export const refreshResidentDashboardServices = mountReader("services:resident", () =>
  syncServiceRequestsFromServer({ force: true }),
);
