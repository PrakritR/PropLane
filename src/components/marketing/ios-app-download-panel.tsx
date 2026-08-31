"use client";

import Link from "next/link";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileAppPreview } from "@/components/marketing/mobile-app-preview";
import { iosAppDownloadIsTestFlight, iosAppDownloadLabel, iosAppDownloadUrl } from "@/lib/ios-app-download";
import { isNativeRuntimeSync } from "@/lib/native/detect-native";
import { cn } from "@/lib/utils";

export function MobileAppDownloadPanel({
  className,
  compact = false,
  showPortalLink = false,
  /** Portal App tab: pin the store CTA above the mobile bottom nav. */
  dockCtaOnMobile = false,
}: {
  className?: string;
  compact?: boolean;
  showPortalLink?: boolean;
  dockCtaOnMobile?: boolean;
}) {
  const inNativeShell = isNativeRuntimeSync();
  const downloadUrl = iosAppDownloadUrl();
  const testFlight = iosAppDownloadIsTestFlight(downloadUrl);

  if (inNativeShell) {
    return (
      <div
        className={cn(
          "rounded-2xl border border-border bg-accent/20 px-5 py-6 text-center sm:px-8",
          className,
        )}
        data-attr="mobile-app-download-installed"
      >
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Smartphone className="h-6 w-6" strokeWidth={2} aria-hidden />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">You&apos;re in the PropLane app</h2>
      </div>
    );
  }

  if (compact) {
    return (
      <div
        className={cn(
          "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
          className,
        )}
        data-attr="mobile-app-download-panel"
      >
        <h2 className="text-lg font-semibold text-foreground">Get PropLane on your phone</h2>
        <Button asChild variant="primary" className="h-11 min-h-0 shrink-0 rounded-full px-6 text-sm font-semibold">
          <Link href="/app" data-attr="mobile-app-download-learn-more">
            View app
          </Link>
        </Button>
      </div>
    );
  }

  const heading = testFlight ? "Install the PropLane mobile beta" : "Get PropLane on your phone";
  const renderDownloadCta = (fullWidthOnMobile: boolean, prominent = false) => (
    <Button
      asChild
      variant="primary"
      className={cn(
        "min-h-0 rounded-full font-semibold",
        prominent ? "h-12 px-7 text-[15px] shadow-md" : "h-11 px-6 text-sm",
        fullWidthOnMobile && "w-full justify-center",
      )}
      data-attr="mobile-app-download-cta"
    >
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
        {iosAppDownloadLabel(downloadUrl)}
      </a>
    </Button>
  );

  if (dockCtaOnMobile) {
    return (
      <div
        className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
        data-attr="mobile-app-download-panel"
      >
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-hidden px-1 pb-[calc(var(--portal-native-bottom-nav-inset,0px)+0.5rem)] pt-1 max-lg:pb-[calc(var(--portal-native-bottom-nav-inset,0px)+0.5rem)] lg:gap-4 lg:pb-4 lg:pt-2">
          <div className="flex min-h-0 w-full max-w-[min(318px,calc(100vw-1.25rem))] flex-1 items-center justify-center overflow-hidden">
            <MobileAppPreview portalMobile />
          </div>
          <div className="w-full shrink-0 max-w-[min(318px,calc(100vw-1.25rem))] px-1">
            {renderDownloadCta(true, true)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("grid gap-8 lg:grid-cols-[minmax(0,1fr)_292px] lg:items-start", className)}
      data-attr="mobile-app-download-panel"
    >
      <div
        className="flex flex-col items-start gap-6 rounded-2xl border border-border bg-card px-5 py-6 sm:px-8 sm:py-8"
      >
        <h2 className="text-2xl font-semibold text-foreground">{heading}</h2>
        <div className="flex flex-wrap gap-2">
          {renderDownloadCta(false)}
          {showPortalLink ? (
            <Button asChild variant="outline" className="h-11 min-h-0 rounded-full px-6 text-sm">
              <Link href="/portal/app" data-attr="mobile-app-download-portal-tab">
                Open in manager portal
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <MobileAppPreview className="lg:justify-self-end" />

    </div>
  );
}

/** @deprecated Use MobileAppDownloadPanel */
export const IosAppDownloadPanel = MobileAppDownloadPanel;

/** Compact web-only promo — hidden inside the native shell via `.native-hide`. */
export function MobileAppPromoStrip({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "native-hide flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3",
        className,
      )}
      data-attr="mobile-app-promo-strip"
    >
      <p className="text-sm font-semibold text-foreground">PropLane mobile app</p>
      <Button asChild variant="outline" className="h-9 min-h-0 shrink-0 rounded-full px-4 text-xs font-semibold">
        <Link href="/app" data-attr="mobile-app-promo-strip-cta">
          View app
        </Link>
      </Button>
    </div>
  );
}

/** @deprecated Use MobileAppPromoStrip */
export const IosAppPromoStrip = MobileAppPromoStrip;
