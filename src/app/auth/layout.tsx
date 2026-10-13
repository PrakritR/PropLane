import { AccountRecoverySetupGate } from "@/components/auth/account-recovery-setup-gate";
import { AuthSplitShell } from "@/components/auth/auth-split-shell";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthSplitShell>
      <AccountRecoverySetupGate>{children}</AccountRecoverySetupGate>
    </AuthSplitShell>
  );
}
