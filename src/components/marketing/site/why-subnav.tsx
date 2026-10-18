import Link from "next/link";
import { cn } from "@/lib/utils";

export type WhyTab = "overview" | "track-record" | "how-we-manage" | "software";

export const WHY_TABS: readonly { id: WhyTab; label: string; href: string }[] = [
  { id: "overview", label: "Overview", href: "/why-proplane" },
  { id: "track-record", label: "Our track record", href: "/why-proplane/track-record" },
  { id: "how-we-manage", label: "How we manage", href: "/why-proplane/how-we-manage" },
  { id: "software", label: "The software", href: "/why-proplane/software" },
];

/** The tabs under Why PropLane. Real links, so each tab is its own page and URL. */
export function WhySubnav({ active }: { active: WhyTab }) {
  return (
    <nav
      aria-label="Why PropLane"
      className="flex max-w-full flex-wrap items-center justify-center gap-1 rounded-[22px] border border-border bg-[var(--pl-surface-muted)] p-1 sm:rounded-full [html[data-theme=dark]_&]:bg-white/[0.04]"
    >
      {WHY_TABS.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          data-attr={`why-tab-${t.id}`}
          aria-current={active === t.id ? "page" : undefined}
          className={cn(
            "inline-flex min-h-[40px] items-center rounded-full px-4 text-[13.5px] font-bold transition-colors",
            active === t.id ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
