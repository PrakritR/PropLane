import { Suspense } from "react";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { PublicApplyClient } from "./public-apply-client";
import { ApplyPortalHandoff } from "./apply-portal-handoff";

function buildApplySearch(params: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") q.set(key, value);
    else if (Array.isArray(value)) value.forEach((entry) => q.append(key, entry));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const applyPath = `/resident/applications/apply${buildApplySearch(params)}`;
  const hasPropertyLink = Boolean(
    (typeof params.propertyId === "string" && params.propertyId.trim()) ||
      (typeof params.ids === "string" && params.ids.trim()),
  );

  const ctx = await getPortalAccessContext();
  if (ctx.user && hasRole(ctx, "resident")) {
    // Deliberately NOT `redirect()`. This decision needs an authenticated role
    // lookup, and by the time it resolves the response has already started
    // streaming — too late for Next to answer with a 307, so the redirect
    // degrades into client recovery and the resident watches the public
    // marketing page render and then reload. `ApplyPortalHandoff` owns both the
    // cover and the navigation; see the note there.
    return <ApplyPortalHandoff href={applyPath} />;
  }

  // A signed-in NON-resident (manager or vendor) does not apply as their current
  // identity — they create a separate resident account and apply from the
  // resident portal. Resolved server-side so the surface never flashes or blanks.
  const signedInNonResident = Boolean(ctx.user) && !hasRole(ctx, "resident");

  return (
    <Suspense fallback={<div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading application…</div>}>
      <PublicApplyClient signedInNonResident={signedInNonResident} />
    </Suspense>
  );
}
