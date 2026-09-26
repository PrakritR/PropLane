"use client";

import { MobileAppDownloadPanel } from "@/components/marketing/ios-app-download-panel";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";

/**
 * N068: the phone-dock layout (`dockCtaOnMobile`) is a narrow, centered
 * column meant for phone width — on a desktop viewport it leaves most of the
 * page blank with no faster way to actually get the app onto a phone than
 * remembering a URL later. A QR code (the same download link the App Store
 * badge points at) fills that space with a real desktop-to-phone handoff.
 * Rendered only at `lg`+, where the dock layout's own phone mockup is the
 * primary content instead.
 */
function DesktopAppQrCard({ qrCodeSvg }: { qrCodeSvg: string }) {
  return (
    <div
      className="hidden w-full max-w-[280px] flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-8 text-center lg:flex"
      data-attr="manager-app-qr-card"
    >
      <p className="text-sm font-semibold text-foreground">Scan to open on your phone</p>
      <div
        className="h-40 w-40 [&_svg]:h-full [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: qrCodeSvg }}
      />
    </div>
  );
}

/** Manager portal → App tab: download the PropLane mobile app. */
export function ManagerMobileAppPanel({ qrCodeSvg }: { qrCodeSvg?: string }) {
  return (
    <ManagerPortalPageShell title="App" hideTitleOnMobileNav viewportFillBody>
      <div className="flex min-h-0 flex-1 flex-col items-center gap-6 overflow-hidden lg:flex-row lg:justify-center lg:gap-10">
        <MobileAppDownloadPanel showPortalLink={false} dockCtaOnMobile className="min-h-0 overflow-hidden" />
        {qrCodeSvg ? <DesktopAppQrCard qrCodeSvg={qrCodeSvg} /> : null}
      </div>
    </ManagerPortalPageShell>
  );
}
