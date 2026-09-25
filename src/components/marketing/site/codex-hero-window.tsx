"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

/**
 * Lifted straight from the dashboard's own queue — today's live home page
 * (site/hero.tsx, before the Codex redesign) carries the exact same card;
 * kept verbatim per the captain's request, just restyled for the light wash.
 */
function CodexHeroActivityCard() {
  return (
    <div className="codex-hero-activity-card" aria-hidden>
      <p className="mb-1.5 flex items-center gap-2 text-[11px] font-bold text-primary">
        Needs attention
        <span className="rounded-full bg-[#e8f7ee] px-2 py-0.5 text-[10px] font-bold text-[#15803d]">Done</span>
      </p>
      <p className="text-[12.5px] font-semibold leading-snug text-[#17181a]">
        PropLane · Pacific Plumbing dispatched to Maple 2A
      </p>
      <p className="text-[11px] text-[#4a4e56]">Service request #1042 · Thu 10–12 · resident notified</p>
      <p className="mt-2 text-[11px] text-[#4a4e56]">
        Tour booked with Jamie P. · Sat 2:00 PM · <span className="font-bold text-[#15803d]">Done</span>
      </p>
    </div>
  );
}

/**
 * The Codex-style hero window (openai.com/codex reference): a big rounded
 * white app frame holding a real, live `<iframe>` of `/demo` — the actual
 * manager portal (sidebar, workspace switcher, topbar, Ask PropLane, the
 * real Dashboard), genuinely interactive, not a redrawn mock. An iframe is a
 * separate browsing context, so a click inside it can never navigate this
 * marketing page away — no click-guard needed, nothing bubbles out.
 *
 * Two more real pieces, carried over from today's live home page (captain
 * 2026-09-25): a phone-shaped SECOND `/demo` embed overlapping the window's
 * bottom-right corner — the iframe's own CSS box is phone-width, so the same
 * responsive page renders its real phone layout (workspace header, bottom
 * tabs) inside it, not a screenshot — and the small "Needs attention"
 * activity card overlapping the left edge. Both are desktop-only; a phone
 * visitor already sees the real phone layout in the one window it has room
 * for, so the extra phone mockup is hidden and the card stays small.
 *
 * Lazy: the dashboard screenshot renders first as a poster, and BOTH iframes
 * mount only once the window is near the viewport (IntersectionObserver,
 * generous rootMargin) — a phone visitor who never scrolls this far never
 * pays for the sandbox's JS or seeded data, and the desktop phone mockup
 * never double-loads ahead of the window it overlaps.
 */
export function CodexHeroWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // The main window and the phone mockup are two independent mounts of the
  // SAME /demo page in the SAME browser tab — they share sessionStorage, so
  // both seeding on the exact same tick raced and threw (the phone mockup
  // showed the app's error boundary, "This page could not load."). Mounting
  // the phone iframe only once the main one has finished its own first load
  // (falling back to a fixed delay if `onLoad` never fires) lets the main
  // window's seed settle first.
  const [phoneActive, setPhoneActive] = useState(false);

  useEffect(() => {
    if (active) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // Defer off the effect body so this never fires a synchronous setState
      // during the effect itself (react-hooks/set-state-in-effect).
      const id = window.setTimeout(() => setActive(true), 0);
      return () => window.clearTimeout(id);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          io.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active || phoneActive) return;
    // Fallback only — the main iframe's onLoad below normally sets this first.
    const id = window.setTimeout(() => setPhoneActive(true), 3000);
    return () => window.clearTimeout(id);
  }, [active, phoneActive]);

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-[1360px]">
      <div className="codex-hero-window relative h-[560px] w-full overflow-hidden rounded-[24px] border border-black/[0.06] bg-white shadow-[0_60px_140px_-40px_rgba(15,23,42,0.35)] sm:h-[760px]">
        {active ? (
          <iframe
            src="/demo"
            title="PropLane manager portal"
            loading="lazy"
            onLoad={() => setPhoneActive(true)}
            className="block h-full w-full border-0 bg-white"
          />
        ) : (
          <Image
            src="/marketing/product/dashboard.webp"
            alt=""
            fill
            priority
            sizes="(max-width: 767px) 100vw, 1360px"
            className="object-cover object-top"
          />
        )}
      </div>

      {/* Phone mockup: a real, second /demo embed sized like a phone — desktop only. */}
      <div className="codex-hero-phone hidden lg:block" aria-hidden>
        {phoneActive ? (
          <iframe src="/demo" title="PropLane manager portal — phone" loading="lazy" className="block h-full w-full border-0 bg-white" />
        ) : (
          <Image
            src="/marketing/product/phone-dashboard.webp"
            alt=""
            fill
            sizes="200px"
            className="object-cover object-top"
          />
        )}
      </div>

      <CodexHeroActivityCard />
    </div>
  );
}
