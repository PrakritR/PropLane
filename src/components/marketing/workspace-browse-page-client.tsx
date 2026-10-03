"use client";

import { RentBrowsePageClient } from "@/components/marketing/rent-browse-page-client";

/** Same browse grid as `/rent/browse`, scoped to server-authorized listing ids. */
export function WorkspaceBrowsePageClient({
  workspaceName,
  propertyIds,
}: {
  workspaceName: string;
  propertyIds: string[];
}) {
  return (
    <div data-attr="workspace-browse-page">
      <p className="sr-only">{workspaceName}</p>
      <RentBrowsePageClient forcedBrowseIds={propertyIds} />
    </div>
  );
}
