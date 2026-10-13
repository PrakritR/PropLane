import { AuthSplitShell } from "@/components/auth/auth-split-shell";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <AuthSplitShell>{children}</AuthSplitShell>;
}
