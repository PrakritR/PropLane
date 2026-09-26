"use client";

import { MobileAppDownloadPanel } from "@/components/marketing/ios-app-download-panel";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";

/**
 * N068: the phone-dock layout (`dockCtaOnMobile`) is a narrow, centered
 * column meant for phone width — on a desktop viewport it leaves most of the
 * page blank with no faster way to actually get the app onto a phone than
 * remembering a URL later. A QR code (the same download link the App Store
 * badge points at) fills that space with a real desktop-to-phone handoff, and
 * "Email me the link" sends that same fixed URL to the signed-in manager's
 * own account email (`/api/manager/app-download-email` — manager-only,
 * rate-limited, takes no destination from the request at all). Rendered only
 * at `lg`+, where the dock layout's own phone mockup is the primary content
 * instead.
 *
 * This was originally an SMS "text me the link" with a phone number the
 * viewer typed in. That let any signed-in account make the platform's own
 * Twilio number text an arbitrary worldwide number (SMS-pumping / toll-fraud
 * risk) and broke the "outbound from the work number only" invariant, so it
 * was replaced with this email-to-self version.
 *
 * An Android/Play Store option is deliberately NOT added here: PropLane has
 * no shipped Android app yet (docs/mobile-app.md — "Android is not [shipped],
 * deferred"), so a Play Store link would point at a listing that doesn't
 * exist.
 */
function DesktopAppQrCard({ qrCodeSvg }: { qrCodeSvg: string }) {
  const { showToast } = useAppUi();

  const emailLink = async () => {
    const res = await fetch("/api/manager/app-download-email", { method: "POST", credentials: "include" });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      showToast(data.error ?? "Could not send the email.");
      return;
    }
    showToast("Email sent.");
  };

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
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => emailLink()}
        data-attr="manager-app-download-email-send"
      >
        Email me the link
      </Button>
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
