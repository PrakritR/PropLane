"use client";

import { useState } from "react";
import { MobileAppDownloadPanel } from "@/components/marketing/ios-app-download-panel";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";

/**
 * N068: the phone-dock layout (`dockCtaOnMobile`) is a narrow, centered
 * column meant for phone width — on a desktop viewport it leaves most of the
 * page blank with no faster way to actually get the app onto a phone than
 * remembering a URL later. A QR code (the same download link the App Store
 * badge points at) fills that space with a real desktop-to-phone handoff, and
 * "Text me the link" sends that same fixed URL to a phone number the viewer
 * types in (`/api/manager/app-download-sms` — signed-in only, rate-limited,
 * never a caller-controlled message body). Rendered only at `lg`+, where the
 * dock layout's own phone mockup is the primary content instead.
 *
 * An Android/Play Store option is deliberately NOT added here: PropLane has
 * no shipped Android app yet (docs/mobile-app.md — "Android is not [shipped],
 * deferred"), so a Play Store link would point at a listing that doesn't
 * exist.
 */
function DesktopAppQrCard({ qrCodeSvg }: { qrCodeSvg: string }) {
  const { showToast } = useAppUi();
  const [phone, setPhone] = useState("");
  const [sending, setSending] = useState(false);

  const sendLink = async () => {
    if (!phone.trim()) {
      showToast("Enter a phone number.");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/manager/app-download-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not send the text.");
      showToast("Text sent.");
      setPhone("");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send the text.");
    } finally {
      setSending(false);
    }
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
      <div className="flex w-full flex-col gap-2">
        <Input
          type="tel"
          inputMode="tel"
          placeholder="(555) 555-5555"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          aria-label="Phone number"
          data-attr="manager-app-download-sms-phone"
        />
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={sending}
          onClick={() => void sendLink()}
          data-attr="manager-app-download-sms-send"
        >
          {sending ? "Sending…" : "Text me the link"}
        </Button>
      </div>
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
