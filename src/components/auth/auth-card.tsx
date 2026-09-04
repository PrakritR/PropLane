import type { ReactNode } from "react";

type AuthCardVariant = "card" | "blend";

/** Portal auth card — frosted glass with accent edge; `blend` drops the panel for wallpaper/native auth. */
export function AuthCard({
  children,
  wide = false,
  /**
   * Wider still, for the plan chooser.
   *
   * `wide` (52rem) left roughly 15rem per column for three plan cards, which on
   * a desktop browser wrapped the feature copy every two or three words and
   * pushed the page well past one screen. The plans are a side-by-side
   * COMPARISON — the web layout needs room to actually be one, rather than
   * inheriting a width chosen for a single-column form, and framing it in a wide
   * empty margin makes the page look like the form it is not.
   */
  widest = false,
  variant = "card",
}: {
  children: ReactNode;
  wide?: boolean;
  widest?: boolean;
  variant?: AuthCardVariant;
}) {
  const maxWidth = widest ? "max-w-[88rem]" : wide ? "max-w-[52rem]" : "max-w-[460px]";
  const shellClass = `auth-card-shell relative mx-auto w-full ${maxWidth}`;

  if (variant === "blend") {
    return (
      <div className={shellClass}>
        <div className="auth-card auth-card-blend relative w-full">{children}</div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <div
        className="pointer-events-none absolute -inset-px rounded-[21px] bg-[linear-gradient(145deg,rgba(47,107,255,0.35),rgba(143,180,255,0.12),rgba(47,107,255,0.2))] opacity-80 sm:rounded-[25px]"
        aria-hidden
      />
      <div className="auth-card glass-card relative rounded-[20px] px-4 py-5 sm:rounded-[24px] sm:px-8 sm:py-8 md:px-10 md:py-10">
        <div
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.55),transparent)]"
          aria-hidden
        />
        {children}
      </div>
    </div>
  );
}
