import { ShieldAlert } from "lucide-react";

/**
 * Shown when the server could not read which portal this account may open (a
 * Property owner membership that would not load). It withholds BOTH shells on
 * purpose: rendering the manager portal would hand an owner-only account the
 * surface the membership exists to keep them out of.
 */
export function PortalAccessUnavailable() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-5 py-12" data-attr="portal-access-unavailable">
      <section className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 sm:p-8" aria-labelledby="portal-access-unavailable-title">
        <ShieldAlert className="mb-5 h-8 w-8 text-primary" aria-hidden />
        <h1 id="portal-access-unavailable-title" className="text-2xl font-semibold tracking-tight text-foreground">
          We couldn&apos;t verify your account
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">Reload the page in a moment and it should come back.</p>
      </section>
    </main>
  );
}
