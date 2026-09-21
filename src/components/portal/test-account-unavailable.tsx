import { ShieldAlert } from "lucide-react";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";

export function TestAccountUnavailable({ state }: { state: "active" | "suspended" | "expired" }) {
  const detail = state === "expired"
    ? "This test account has expired. Ask a trusted operator to extend it."
    : state === "suspended"
      ? "This test account is suspended. Ask a trusted operator to restore it."
      : "Private test workspaces are unavailable in this environment.";
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-5 py-12" data-attr="test-account-unavailable">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 sm:p-8" aria-labelledby="test-account-unavailable-title">
        <ShieldAlert className="mb-5 h-8 w-8 text-primary" aria-hidden />
        <h1 id="test-account-unavailable-title" className="text-2xl font-semibold tracking-tight text-foreground">
          Test workspace unavailable
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">{detail}</p>
        <p className="mt-2 text-sm leading-6 text-muted">Customer data and live deliveries remain blocked for this account.</p>
        <PortalSignOutButton
          className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-foreground px-4 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-60"
          dataAttr="test-account-unavailable-sign-out"
        />
      </section>
    </main>
  );
}
