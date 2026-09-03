import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { AuthOAuthErrorHandler } from "@/components/auth/auth-oauth-error-handler";
import { GeneralAssistant } from "@/components/general/general-assistant";
import { NativeAppGate } from "@/components/native/native-app-gate";
import { NativeBridge } from "@/components/native/native-bridge";
import { CAPACITOR_BOOTSTRAP_SCRIPT, THEME_BOOTSTRAP_SCRIPT } from "@/lib/bootstrap-scripts";
import { brandSans } from "./fonts";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  themeColor: "#080b14",
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: {
    default: "PropLane",
    template: "%s · PropLane",
  },
  description:
    "PropLane: AI-powered property management for applications, screening, leases, and rent collection.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased ${brandSans.variable}`}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="min-h-full overflow-x-clip bg-background text-foreground">
        <Script id="axis-theme-bootstrap" strategy="beforeInteractive">
          {THEME_BOOTSTRAP_SCRIPT}
        </Script>
        <Script id="axis-capacitor-bootstrap" strategy="beforeInteractive">
          {CAPACITOR_BOOTSTRAP_SCRIPT}
        </Script>
        <ThemeProvider defaultTheme="light">
          <AppUiProvider>
            <AuthOAuthErrorHandler />
            <NativeBridge />
            <NativeAppGate>{children}</NativeAppGate>
            {/* Public-page assistant: bottom-right FAB + popup panel (portal uses AxisAssistant). */}
            <GeneralAssistant />
          </AppUiProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
