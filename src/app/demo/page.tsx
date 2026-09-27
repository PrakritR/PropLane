import { DemoManagerShell } from "@/app/demo/demo-manager-shell";
import { DemoResetScroll } from "@/app/demo/demo-reset-scroll";
import type { DemoPortalRole } from "@/lib/demo/demo-session";

const DEMO_ROLES = new Set<DemoPortalRole>(["manager", "resident", "vendor"]);

function readRole(value: string | undefined): DemoPortalRole | undefined {
  return value && DEMO_ROLES.has(value as DemoPortalRole) ? (value as DemoPortalRole) : undefined;
}

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
 *
 * `?role=&section=` deep-links straight into one slice for another page's
 * embed (e.g. the home page's "Three sign-ins" tabs) — read on the SERVER
 * from the actual request so the initial render is already correct, rather
 * than a client-side `useSearchParams()` read that would first paint the
 * default Manager/Dashboard and then flash to the deep-linked role.
 */
export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; section?: string; tab?: string }>;
}) {
  const params = await searchParams;
  return (
    <>
      <DemoResetScroll />
      <DemoManagerShell
        initialRole={readRole(params.role)}
        initialSection={params.section}
        initialTab={params.tab}
      />
    </>
  );
}
