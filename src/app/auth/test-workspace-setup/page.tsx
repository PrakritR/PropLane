"use client";

import { FormEvent, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function TestWorkspaceSetupPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setBusy(true);
    setError(null);
    const { error: updateError } = await createSupabaseBrowserClient().auth.updateUser({ password });
    if (updateError) {
      setError("Could not set your password. Open the invitation again or ask the operator for a new one.");
      setBusy(false);
      return;
    }
    window.location.replace("/auth/continue");
  }

  return (
    <AuthCard>
      <form onSubmit={submit} className="space-y-5" aria-busy={busy}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Private test workspace</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">Set your password</h1>
          <p className="mt-2 text-sm leading-6 text-muted">Finish securing this test account before entering its portal.</p>
        </div>
        <label className="grid gap-1.5 text-sm font-medium text-foreground" htmlFor="test-workspace-password">
          Password
          <PasswordInput
            id="test-workspace-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium text-foreground" htmlFor="test-workspace-password-confirm">
          Confirm password
          <PasswordInput
            id="test-workspace-password-confirm"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Saving…" : "Continue to portal"}
        </Button>
      </form>
    </AuthCard>
  );
}
