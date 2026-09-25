import type { Metadata } from "next";
import { DemoPortalShell } from "@/components/demo/demo-portal-shell";

/**
 * Bare embed target for the `/demo` sandbox. Deliberately outside the
 * `(public)` route group, so it renders with NO marketing chrome (no
 * PublicNavbar, no PublicFooter, no light-theme lock) — just the real,
 * signed-out demo portal, exactly as `DemoPortalShell` already seeds and
 * renders it (see docs/agents/demo-sandbox.md).
 *
 * This route exists so the home page's Codex-style hero window
 * (site/hero.tsx, site/codex-hero-window.tsx) can put the real, live portal
 * in an <iframe> — a genuinely separate browsing context, so a click inside
 * it can never navigate the marketing page (no listener needed; iframes
 * don't bubble events to the parent document). Not indexed: the home page,
 * not a bare `/demo` link, is where a visitor is meant to meet the sandbox.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-background">
      <DemoPortalShell />
    </div>
  );
}
