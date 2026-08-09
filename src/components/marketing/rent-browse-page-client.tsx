"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { ResidentHousingBrowse } from "@/components/marketing/resident-housing-browse";
import { Button } from "@/components/ui/button";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { portalNavClick } from "@/lib/portal-nav-client";
import { BROWSE_IDS_PARAM, parseBrowseIdsParam } from "@/lib/manager-property-links";
import { residentCreateAccountHref, residentSignInHref } from "@/lib/resident-public-nav";

function authCreateResidentPath() {
  return "/auth/create-account?mode=create&role=resident";
}

export function RentBrowsePageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromAuth = searchParams.get("from") === "auth";
  const fromApplication = searchParams.get("from") === "application";
  const applicationReturn = searchParams.get("return")?.trim() ?? "";
  const browseIds = useMemo(
    () => parseBrowseIdsParam(searchParams.get(BROWSE_IDS_PARAM)),
    [searchParams],
  );
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

  return (
    <div className="native-auth-screen min-h-[100dvh] px-4 py-5 [html[data-native]_&]:pt-[max(1rem,env(safe-area-inset-top))] [html[data-native]_&]:pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:py-8">
      <div className="mx-auto w-full max-w-7xl">
        {(isNative === true || fromApplication) && (
          <Link
            href={backHref}
            onClick={onBackClick}
            data-attr="resident-browse-back"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:opacity-90"
          >
            ← {fromApplication ? "Back to application" : "Back"}
          </Link>
        )}

        <header className={`text-center ${isNative === true ? "mt-4" : "mt-2"}`}>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Browse homes
          </h1>
        </header>

        <div className="mb-10 mt-6 sm:mb-12 sm:mt-8">
          <ResidentHousingBrowse propertyIds={browseIds} />
        </div>

        {isNative !== true ? (
          <section className="mx-auto mt-10 max-w-2xl rounded-3xl border border-border/50 bg-card px-6 py-10 text-center shadow-sm sm:mt-14 sm:px-10">
            <h2 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Ready to make one of these your home?
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted">
              Create a free account to save the homes you like and apply in minutes.
            </p>
            <div className="mt-6">
              <Button asChild className="w-full sm:w-auto sm:px-8">
                <Link href={residentCreateAccountHref()} data-attr="resident-browse-get-started">
                  Get started
                </Link>
              </Button>
            </div>
            <p className="mt-5 text-sm text-muted">
              Already have an account?{" "}
              <Link
                href={residentSignInHref()}
                data-attr="resident-browse-sign-in"
                className="font-semibold text-primary hover:underline"
              >
                Sign in
              </Link>
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
