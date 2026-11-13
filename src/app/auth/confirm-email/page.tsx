"use client";

import { AuthCard } from "@/components/auth/auth-card";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

/**
 * Opens a personal email proof. The token is spent by pressing the button (a POST), never by merely loading the page,
 * so a mail scanner that prefetches the link cannot use it up. Works in any browser: no session or PKCE is involved.
 */
function Content() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"ask" | "busy" | "done" | "failed">("ask");
  const confirm = async () => {
    setState("busy");
    try {
      const res = await fetch("/api/auth/confirm-email-proof", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      setState(res.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  };
  if (state === "done") {
    return (
      <AuthCard>
        <h1 className="text-center text-[22px] font-bold tracking-tight text-foreground">Email confirmed</h1>
        <Link className="mt-8 flex w-full justify-center text-sm font-semibold text-primary hover:opacity-90" href="/auth/sign-in" data-attr="confirm-email-sign-in">
          Sign in with your email and password →
        </Link>
      </AuthCard>
    );
  }
  if (state === "failed" || !token) {
    return (
      <AuthCard>
        <h1 className="text-center text-[22px] font-bold tracking-tight text-foreground">Link invalid</h1>
        <p className="mt-2 text-center text-sm text-muted">This confirmation link is invalid or has expired.</p>
        <Link className="mt-8 flex w-full justify-center text-sm font-semibold text-primary hover:opacity-90" href="/auth/sign-in">← Back to sign in</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard>
      <h1 className="text-center text-[22px] font-bold tracking-tight text-foreground">Confirm your email</h1>
      <button type="button" disabled={state === "busy"} onClick={() => void confirm()} data-attr="confirm-email-button" className="mt-6 flex w-full justify-center rounded-full bg-primary py-3 text-sm font-semibold text-white disabled:opacity-60">
        {state === "busy" ? "Confirming…" : "Confirm email"}
      </button>
    </AuthCard>
  );
}

export default function ConfirmEmailPage() {
  return (
    <Suspense fallback={<AuthCard><p className="text-center text-sm text-muted">Loading…</p></AuthCard>}>
      <Content />
    </Suspense>
  );
}
