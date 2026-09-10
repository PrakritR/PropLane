"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";

const UNGATED = ["/auth/sign-in", "/auth/forgot-password", "/auth/reset-password", "/auth/recover-account", "/auth/callback", "/auth/sign-out"];

/** Do not mount provisioning forms until a retained account's choice is resolved. */
export function AccountRecoverySetupGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const bypass = UNGATED.some(path => pathname === path || pathname.startsWith(`${path}/`));
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ path: string; attempt: number; state: "ready" | "error" }>({ path: "", attempt: -1, state: "ready" });
  useEffect(() => {
    if (bypass) return;
    let mounted = true;
    async function check() {
      try {
        const response = await fetch("/api/auth/account-recovery", { cache: "no-store" });
        if (!mounted) return;
        if (response.status === 401) { setResult({ path: pathname, attempt, state: "ready" }); return; }
        if (!response.ok) throw new Error("Recovery status unavailable");
        const data = await response.json();
        if (!mounted) return;
        if (data.request) { window.location.replace(`/auth/recover-account?portal=${encodeURIComponent(data.request.portal)}`); return; }
        setResult({ path: pathname, attempt, state: "ready" });
      } catch { if (mounted) setResult({ path: pathname, attempt, state: "error" }); }
    }
    void check();
    return () => { mounted = false; };
  }, [pathname, bypass, attempt]);
  if (bypass) return children;
  const current = result.path === pathname && result.attempt === attempt;
  if (current && result.state === "ready") return children;
  return <AuthCard><div className="space-y-4">
    <p role={current ? "alert" : "status"}>{current ? "We couldn't check your account. Your data has not been changed." : "Checking your account…"}</p>
    {current && <Button variant="outline" data-attr="account-recovery-setup-retry" onClick={() => setAttempt(value => value + 1)}>Try again</Button>}
  </div></AuthCard>;
}
