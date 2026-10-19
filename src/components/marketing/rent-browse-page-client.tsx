"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { BrowseApplyBand, ResidentHousingBrowse } from "@/components/marketing/resident-housing-browse";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { portalNavClick } from "@/lib/portal-nav-client";
import { BROWSE_IDS_PARAM, parseBrowseIdsParam } from "@/lib/manager-property-links";
import "@/components/public-site/browse.css";

function authCreateResidentPath() {
  return "/auth/create-account?mode=create&role=resident";
}

export function RentBrowsePageClient({
  forcedBrowseIds,
}: {
  /** Server-authorized ids from `/rent/w/<slug>` — overrides `?ids=` when set. */
  forcedBrowseIds?: string[];
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromAuth = searchParams.get("from") === "auth";
  const fromApplication = searchParams.get("from") === "application";
  const applicationReturn = searchParams.get("return")?.trim() ?? "";
  const browseIds = useMemo(() => {
    if (forcedBrowseIds?.length) return forcedBrowseIds;
    return parseBrowseIdsParam(searchParams.get(BROWSE_IDS_PARAM));
  }, [forcedBrowseIds, searchParams]);
  const { isNative } = useIsNativeApp();
  const backHref =
    fromApplication && applicationReturn.startsWith("/")
      ? applicationReturn
      : fromAuth || isNative
        ? authCreateResidentPath()
        : "/";
  const onBackClick = useMemo(
    () =>
      isNative === true
        ? portalNavClick(router, backHref, { preferFullNavigation: true })
        : undefined,
    [backHref, isNative, router],
  );
  const titled = isNative === true || fromApplication;

  return (
    <div className="ps ps-browse native-auth-screen [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))] [html[data-native]_&]:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="ps-wrap ps-page">
        {titled && (
          <Link href={backHref} onClick={onBackClick} data-attr="resident-browse-back" className="ps-link ps-browse-back">
            ← {fromApplication ? "Back to application" : "Back"}
          </Link>
        )}

        <ResidentHousingBrowse propertyIds={browseIds} heading={titled ? "Browse homes" : "Find a home"} />

        {isNative !== true ? (
          <BrowseApplyBand />
        ) : null}
      </div>
    </div>
  );
}
