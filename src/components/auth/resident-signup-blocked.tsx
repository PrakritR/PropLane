"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Shown when someone tries to create a resident account without an emailed setup link. */
export function ResidentSignupBlocked({ compact = false }: { compact?: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const resend = async () => {
    if (!email.trim().includes("@")) {
      setNotice("Enter the email you used on your rental application.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/auth/resident-setup-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        setNotice("Too many requests. Wait a moment and try again.");
        return;
      }
      // Neutral either way — never reveal whether an application exists.
      setNotice("If an application matches that email, we've sent your account setup link. Check your inbox.");
    } catch {
      setNotice("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <AuthPageHeader
        eyebrow="Resident"
        title="Apply first"
        subtitle="Resident accounts are created from the setup link we email after you submit a rental application."
      />
      <div className="space-y-2.5">
        <Link
          href="/rent/browse"
          className="btn-cobalt inline-flex min-h-[44px] w-full items-center justify-center rounded-full px-6 text-[15px] font-semibold"
          data-attr="resident-blocked-browse"
        >
          Browse homes &amp; apply
        </Link>
        <Link
          href="/auth/sign-in?intent=resident&next=/resident/applications"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-border px-6 text-[15px] font-semibold text-foreground"
        >
          Already have an account? Sign in
        </Link>
      </div>

      <div className="rounded-2xl border border-border/70 bg-background/40 p-4">
        <p className="text-[13px] font-semibold text-foreground">Already applied? Lost the email?</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">
          Enter the email from your application and we&apos;ll resend your account setup link.
        </p>
        <div className="mt-3 space-y-2">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            // iOS/macOS autocapitalise the first letter by default, which used to
            // make Manager@… a different account from manager@… (PRP-196).
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter") void resend();
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="w-full rounded-full py-2.5 text-[14px] font-semibold"
            disabled={busy}
            onClick={() => resend()}
            data-attr="resident-blocked-resend-setup-link"
          >
            {busy ? "Sending…" : "Email my setup link"}
          </Button>
          {notice ? <p className="text-center text-[12px] text-muted">{notice}</p> : null}
        </div>
      </div>
    </div>
  );
}
