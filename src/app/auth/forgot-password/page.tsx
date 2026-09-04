"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestPasswordReset } from "@/lib/auth/request-password-reset";
import Link from "next/link";
import { useState } from "react";

export default function ForgotPasswordPage() {
  const { showToast } = useAppUi();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const sendResetLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      showToast("Enter the email you use to sign in.");
      return;
    }
    setBusy(true);
    try {
      const result = await requestPasswordReset(trimmed);
      if (!result.ok) {
        showToast(result.message);
        return;
      }
      setSent(true);
      showToast("If an account exists for that email, a reset link is on its way.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard>
      <h1 className="text-center text-[22px] font-semibold tracking-tight text-foreground">Reset password</h1>
      <p className="mt-2 text-center text-sm text-muted">
        Enter the email you use to sign in. We&apos;ll send a secure link to choose a new password.
      </p>

      <div className="mt-8">
        <label className="text-xs font-semibold text-muted" htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          className="mt-1.5"
          placeholder="you@example.com"
          autoComplete="email"
          // iOS/macOS autocapitalise the first letter by default, which used to
          // make Manager@… a different account from manager@… (PRP-196).
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>

      {sent ? (
        <p className="mt-4 text-center text-sm text-emerald-700">
          Check your inbox for a reset link. It may take a minute to arrive, and it works on any device.
        </p>
      ) : null}

      <Button
        type="button"
        className="mt-8 w-full rounded-full py-3 text-base font-semibold"
        disabled={busy}
        onClick={() => sendResetLink()}
      >
        {busy ? "Sending…" : "Send reset link"}
      </Button>

      <Link
        className="mt-8 flex w-full justify-center text-sm font-semibold text-primary hover:opacity-90"
        href="/auth/sign-in"
      >
        ← Back to sign in
      </Link>
    </AuthCard>
  );
}
