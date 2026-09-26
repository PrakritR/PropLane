import { DemoManagerShell } from "@/app/demo/demo-manager-shell";
import { DemoResetScroll } from "@/app/demo/demo-reset-scroll";

/**
 * Standalone public page for the `/demo` sandbox. Deliberately outside the
 * `(public)` route group, so it renders with NO marketing chrome (no
 * PublicNavbar, no PublicFooter, no light-theme lock) — just the real
 * manager portal shell (`DemoManagerShell`), unauthenticated (see
 * docs/agents/demo-sandbox.md).
 *
 * Captain 2026-09-25: rebuilt to look exactly like the real signed-in
 * `/portal` — the real `PortalSidebar`/`PortalTopBar`/docked assistant, not
 * `DemoPortalShell`'s own hand-rolled chrome (role switcher, "Run demo",
 * floating chat bubble) — see `demo-manager-shell.tsx`.
 *
 * The home page's Codex-style hero window (site/hero.tsx,
 * site/codex-hero-window.tsx) also puts this exact page in an `<iframe>` —
 * a genuinely separate browsing context, so a click inside it can never
 * navigate the marketing page (no listener needed; iframes don't bubble
 * events to the parent document). No robots override here: `/demo` carries
 * the same crawl policy as every other public route (`src/middleware.ts`'s
 * `stampCrawlPolicy`, which stamps `X-Robots-Tag: noindex` off the canonical
 * crawl host and leaves it indexable on the canonical host) rather than a
 * page-specific exception.
 */
export default function DemoPage() {
  return (
    <>
      <DemoResetScroll />
      <DemoManagerShell />
    </>
  );
}
