import { AuthBrandPanel } from "@/components/auth/auth-brand-panel";
import { AccountRecoverySetupGate } from "@/components/auth/account-recovery-setup-gate";
import { AuthLayoutBackdrop, AuthLayoutFooter, AuthLayoutHomeMark, AuthLayoutSubstrate } from "@/components/auth/auth-layout-chrome";
import { siteDisplayFont } from "@/components/marketing/fonts/site-display-font";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
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
          <div className="auth-layout-panel w-full max-w-[min(100%,52rem)]"><AccountRecoverySetupGate>{children}</AccountRecoverySetupGate></div>
        </main>
        <AuthLayoutFooter />
      </div>
      <AuthBrandPanel />
    </div>
  );
}
