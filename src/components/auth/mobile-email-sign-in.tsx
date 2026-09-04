"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import Link from "next/link";
import { useState } from "react";
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

const LOGIN_TIMEOUT_MS = 6000;

type SignInResult = {
  data: { user: { id: string } | null; session: unknown | null };
  error: { message: string } | null;
};

function continueHref(nextPath: string): string {
  if (!nextPath.startsWith("/")) return "/auth/continue";
  return `/auth/continue?next=${encodeURIComponent(nextPath)}`;
}

async function tryResidentAutoConfirm(email: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/confirm-resident-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: normalizeAuthEmail(email) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function MobileEmailSignIn({
  nextPath,
  disabled = false,
}: {
  nextPath: string;
  disabled?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const signIn = async () => {
    if (!email.trim() || !password) {
      setErrorText("Enter email and password.");
      return;
    }
    setErrorText(null);
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      let authResult = (await Promise.race([
        supabase.auth.signInWithPassword({ email: normalizeAuthEmail(email), password }),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error("Login timed out. Check your connection.")), LOGIN_TIMEOUT_MS),
        ),
      ])) as SignInResult;

      let { data, error } = authResult;
      if (error?.message.toLowerCase().includes("email not confirmed")) {
        const repaired = await tryResidentAutoConfirm(email);
        if (repaired) {
          authResult = (await supabase.auth.signInWithPassword({ email: normalizeAuthEmail(email), password })) as SignInResult;
          data = authResult.data;
          error = authResult.error;
        }
      }
      if (error) {
        setErrorText(error.message);
        return;
      }
      if (!data.user) {
        throw new Error("No active session.");
      }
      window.location.replace(continueHref(nextPath));
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const locked = disabled || busy;

  return (
    <div className="space-y-3">
      <Input
        id="mobile-sign-in-email"
        type="email"
        autoComplete="email"
        // iOS/macOS autocapitalise the first letter by default, which used to
        // make Manager@… a different account from manager@… (PRP-196).
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={locked}
      />
      <PasswordInput
        id="mobile-sign-in-pw"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={locked}
        onKeyDown={(e) => {
          if (e.key === "Enter") void signIn();
        }}
      />
      {errorText ? <p className="text-center text-xs text-rose-600">{errorText}</p> : null}
      <Button
        type="button"
        className="w-full rounded-full py-2.5 text-[15px] font-semibold"
        disabled={locked}
        onClick={() => signIn()}
      >
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-[12px] text-muted">
        <Link className="font-semibold text-primary hover:opacity-90" href="/auth/forgot-password">
          Forgot password?
        </Link>
      </p>
    </div>
  );
}
