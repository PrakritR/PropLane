import type { ReactNode } from "react";
import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";
import { AuthLayoutBackdrop, AuthLayoutFooter, AuthLayoutHomeMark, AuthLayoutSubstrate } from "@/components/auth/auth-layout-chrome";
import { siteDisplayFont } from "@/components/marketing/fonts/site-display-font";

/**
 * The two-column auth shell: the form on the left, the brand panel on the
 * right. The brand panel hides on narrow screens and in the native shells
 * (`auth-split.css`). Sign-in, the invite page and the MCP screens share it.
 */
export function AuthSplitShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={`auth-layout axis-page-frame relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden ${siteDisplayFont.variable}`}
      data-auth-layout
    >
      <AuthLayoutSubstrate />
      <AuthLayoutBackdrop />
      <div className="auth-split-form">
        <AuthLayoutHomeMark />
        <main className="auth-layout-main">
          <div className="auth-layout-panel w-full max-w-[min(100%,52rem)]">{children}</div>
        </main>
        <AuthLayoutFooter />
      </div>
      <AuthBrandPanel />
    </div>
  );
}
