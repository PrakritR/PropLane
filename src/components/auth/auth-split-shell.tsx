import type { ReactNode } from "react";
import "@/components/public-site/public-site.css";
import "./auth-split.css";
import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";
import { AuthLayoutHomeMark } from "@/components/auth/auth-layout-chrome";
import { publicSiteFont } from "@/components/public-site/fonts/inter-tight";

/**
 * The two-column auth shell, in the homepage's look (concept A): the form on a
 * paper column on the left, an edge-to-edge blue panel on the right. Everything
 * on the page is one face (Inter Tight) because the root carries `ps`. The panel
 * hides on narrow screens and in the native shells (`auth-split.css`). Sign-in,
 * the invite page and the MCP screens share it.
 *
 * There is no site footer here (captain #27): the left column is the logo and the form, nothing else. The public
 * footer's styles live under `(public)`, so drawn here it rendered as a giant house mark and raw waves.
 */
export function AuthSplitShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={`auth-layout ps axis-page-frame relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden ${publicSiteFont.variable}`}
      data-auth-layout
    >
      <div className="auth-split-form">
        <AuthLayoutHomeMark />
        <main className="auth-layout-main">
          <div className="auth-layout-panel w-full max-w-[min(100%,52rem)]">{children}</div>
        </main>
      </div>
      <AuthBrandPanel />
    </div>
  );
}
