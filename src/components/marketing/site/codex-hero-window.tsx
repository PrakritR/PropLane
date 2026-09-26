"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

const PHONE_VIEWPORT_WIDTH = 390;
const PHONE_VIEWPORT_HEIGHT = 844;
/** Visual size of the bezel in the hero — the iframe inside is the real
 * 390×844 phone viewport, scaled down with a CSS transform to fit here.
 * 250 = 200 × 1.25 (captain 2026-09-25: "bigger phone" pass). */
const PHONE_BEZEL_WIDTH = 250;
const PHONE_SCALE = PHONE_BEZEL_WIDTH / PHONE_VIEWPORT_WIDTH;
const PHONE_BEZEL_HEIGHT = Math.round(PHONE_VIEWPORT_HEIGHT * PHONE_SCALE);

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <rect x="7" y="2" width="10" height="20" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11 18.2h2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Lifted straight from the dashboard's own queue — today's live home page
 * (site/hero.tsx, before the Codex redesign) carries the exact same card;
 * kept verbatim per the captain's request, just restyled for the light wash.
 * Dismissible with its own ✕, same as the phone mockup.
 */
function CodexHeroActivityCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="codex-hero-activity-card">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-muted transition hover:bg-foreground/5 hover:text-foreground"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
      <p className="mb-1.5 flex items-center gap-2 pr-5 text-[11px] font-bold text-primary">
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
 * The phone mockup: a real, second `/demo` embed — not a narrow iframe of
 * the desktop layout (that rendered the desktop dashboard squeezed into a
 * phone-wide box: truncated labels, wrapping KPI cards). The iframe's own
 * viewport is the REAL phone size (390×844, the same width the captain
 * checked http://localhost:3000/portal/dashboard against), so it renders the
 * app's actual phone shell — workspace header, 2-up KPI grid, full-label
 * bottom tabs, floating ✦ — and a CSS `transform: scale()` shrinks that
 * whole real viewport down to fit the small bezel here. Dismissible with its
 * own ✕; a small phone-icon chip brings it back.
 */
function CodexHeroPhoneMockup({
  active,
  visible,
  onHide,
  onShow,
}: {
  active: boolean;
  visible: boolean;
  onHide: () => void;
  onShow: () => void;
}) {
  if (!visible) {
    return (
      <button
        type="button"
        onClick={onShow}
        aria-label="Show phone preview"
        className="codex-hero-phone-chip hidden lg:flex"
      >
        <PhoneIcon className="h-4 w-4" />
      </button>
    );
  }
  return (
    <div className="codex-hero-phone hidden lg:block">
      <button
        type="button"
        onClick={onHide}
        aria-label="Hide phone preview"
        className="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-black/35 text-white transition hover:bg-black/55"
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
      {active ? (
        <div
          style={{
            width: PHONE_VIEWPORT_WIDTH,
            height: PHONE_VIEWPORT_HEIGHT,
            transform: `scale(${PHONE_SCALE})`,
            transformOrigin: "top left",
          }}
        >
          <iframe
            src="/demo"
            title="PropLane manager portal — phone"
            loading="lazy"
            style={{ width: PHONE_VIEWPORT_WIDTH, height: PHONE_VIEWPORT_HEIGHT, border: 0 }}
            className="block bg-white"
          />
        </div>
      ) : (
        <Image src="/marketing/product/phone-dashboard.webp" alt="" fill sizes="250px" className="object-cover object-top" />
      )}
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
 * 2026-09-25): the phone mockup (see `CodexHeroPhoneMockup` above) and the
 * small "Needs attention" activity card overlapping the left edge, both
 * dismissible. Desktop-only; a phone visitor already sees the real phone
 * layout in the one window it has room for.
 *
 * Lazy: the dashboard screenshot renders first as a poster, and the main
 * iframe mounts only once the window is near the viewport (IntersectionObserver,
 * generous rootMargin) — a phone visitor who never scrolls this far never
 * pays for the sandbox's JS or seeded data. The phone mockup's iframe mounts
 * only once the main window's has finished loading (falling back to a fixed
 * delay): both are independent mounts of the SAME /demo page in the SAME
 * browser tab sharing sessionStorage, and seeding both on the exact same
 * tick raced and threw — staggering them lets the first seed settle first.
 */
export function CodexHeroWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [phoneActive, setPhoneActive] = useState(false);
  const [phoneVisible, setPhoneVisible] = useState(true);
  const [cardVisible, setCardVisible] = useState(true);

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
    <div ref={ref} className="relative mx-auto w-full">
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
            sizes="96vw"
            className="object-cover object-top"
          />
        )}
      </div>

      <CodexHeroPhoneMockup
        active={phoneActive}
        visible={phoneVisible}
        onHide={() => setPhoneVisible(false)}
        onShow={() => setPhoneVisible(true)}
      />

      {cardVisible ? <CodexHeroActivityCard onDismiss={() => setCardVisible(false)} /> : null}
    </div>
  );
}
