import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { SignInErrorPresentation } from "@/lib/auth/sign-in-error";

export function SignInErrorNotice({
  error,
  createAccountHref,
}: {
  error: SignInErrorPresentation;
  createAccountHref: string;
}) {
  return (
    <div
      id="auth-sign-in-error"
      role="alert"
      className="rounded-xl border border-[color-mix(in_srgb,var(--status-overdue-fg)_25%,transparent)] bg-[var(--status-overdue-bg)] px-3 py-3 text-[var(--status-overdue-fg)]"
    >
      <p className="text-center text-xs font-medium leading-relaxed">{error.message}</p>
      {error.credentialMismatch ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Button asChild variant="outline" className="w-full px-4 text-xs">
            <Link href="/auth/forgot-password" data-attr="auth-error-reset-password">
              Reset password
            </Link>
          </Button>
          <Button asChild variant="secondary" className="w-full px-4 text-xs">
            <Link href={createAccountHref} data-attr="auth-error-create-account">
              Create account
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
