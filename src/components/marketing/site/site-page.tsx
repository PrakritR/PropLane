import type { ReactNode } from "react";
import { SiteBackdrop } from "@/components/marketing/site/site-backdrop";
import { cn } from "@/lib/utils";

/**
 * Wraps a public page in the home page's look: the atmosphere behind everything
 * (one continuous soft background, no white bands), the display heading face
 * and the shared ink. Every public marketing page's content is a child of this.
 */
export function SitePage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("site-page", className)}>
      <SiteBackdrop />
      <div className="site-page-content">{children}</div>
    </div>
  );
}
