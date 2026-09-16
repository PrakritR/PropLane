"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { ResidentHousingBrowse } from "@/components/marketing/resident-housing-browse";
import { SignedOutOnly } from "@/components/marketing/signed-out-only";
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

        {isNative === true || fromApplication ? (
          <header className={`text-center ${isNative === true ? "mt-4" : "mt-2"}`}>
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Browse homes
            </h1>
          </header>
        ) : (
          /*
           * The signed-out landing hero. /rent is the live browse app and stays
           * one: the hero sits on top (Airbnb/Zillow's shape) and is kept short
           * so the first listing is never pushed below the fold on a phone.
           */
          <SignedOutOnly>
            <header className="mx-auto mt-1 max-w-[760px] text-center sm:mt-2">
              <p className="text-[12.5px] font-bold uppercase tracking-[0.08em] text-primary">For residents</p>
              <h1 className="mt-3 text-[clamp(1.9rem,4.4vw,3rem)] font-bold leading-[1.05] tracking-[-0.03em] text-foreground">
                Find a room or a home. Apply from your phone.
              </h1>
              <ul className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[12.5px] font-semibold text-foreground/85">
                {["Tour in a minute", "One application, e-signed lease", "Rent by card or bank, reminders first"].map((p) => (
                  <li key={p} className="rounded-full border border-border bg-card px-3 py-1.5">
                    {p}
                  </li>
                ))}
              </ul>
            </header>
          </SignedOutOnly>
        )}

        <div className="mb-8 mt-5 sm:mb-10 sm:mt-7">
          <ResidentHousingBrowse propertyIds={browseIds} />
        </div>

        {isNative !== true ? (
          <section
            className="mx-auto mt-6 flex max-w-5xl flex-col items-stretch gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            aria-label="Create an account to apply"
          >
            <p className="text-sm text-foreground">
              <span className="text-[15px] font-bold">Ready to apply?</span>{" "}
              <span className="text-muted">Create a free account to save homes and apply in minutes.</span>
            </p>
            <div className="flex items-center justify-center gap-2 sm:justify-end">
              <Link
                href={residentSignInHref()}
                data-attr="resident-browse-sign-in"
                className="rounded-full px-3 py-2 text-sm font-semibold text-primary hover:underline"
              >
                Sign in
              </Link>
              <Button asChild className="rounded-full px-5">
                <Link href={residentCreateAccountHref()} data-attr="resident-browse-get-started">
                  Get started
                </Link>
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
