"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

/**
 * The Codex-style hero window (openai.com/codex reference): a big rounded
 * dark app frame holding a real, live `<iframe>` of `/demo` — the actual
 * manager portal (sidebar, workspace switcher, topbar, Ask PropLane, the
 * real Dashboard), genuinely interactive, not a redrawn mock. An iframe is a
 * separate browsing context, so a click inside it can never navigate this
 * marketing page away — no click-guard needed, nothing bubbles out.
 *
 * Lazy: the same dashboard screenshot the old hero used renders first as a
 * poster, and the iframe mounts only once the window is near the viewport
 * (IntersectionObserver, generous rootMargin) — a phone visitor who never
 * scrolls this far never pays for the sandbox's JS or seeded data.
 */
export function CodexHeroWindow() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

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

  return (
    <div
      ref={ref}
      className="codex-hero-window relative mx-auto h-[600px] w-full max-w-[1450px] overflow-hidden rounded-2xl border border-white/10 bg-[#1b1b1b] shadow-[0_60px_120px_-30px_rgba(0,0,0,0.65)] sm:h-[640px]"
    >
      {active ? (
        <iframe
          src="/demo"
          title="PropLane manager portal"
          loading="lazy"
          className="block h-full w-full border-0 bg-[#1b1b1b]"
        />
      ) : (
        <Image
          src="/marketing/product/dashboard.webp"
          alt=""
          fill
          sizes="(max-width: 767px) 100vw, 1450px"
          className="object-cover object-top"
        />
      )}
    </div>
  );
}
