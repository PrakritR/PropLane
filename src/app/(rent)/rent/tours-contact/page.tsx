import { Suspense } from "react";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { redirect } from "next/navigation";
import {
  residentPortalListingMessagePath,
  residentPortalTourSchedulePath,
} from "@/lib/prospect-public-nav";
import { ToursContactPageClient } from "./tours-contact-page-client";

export const dynamic = "force-dynamic";

export default async function ToursContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const propertyId = typeof params.propertyId === "string" ? params.propertyId.trim() : "";
  const tab = typeof params.tab === "string" ? params.tab.trim().toLowerCase() : "";
  const ctx = await getPortalAccessContext();

  if (ctx.user && hasRole(ctx, "resident") && propertyId) {
    redirect(tab === "message" ? residentPortalListingMessagePath(propertyId) : residentPortalTourSchedulePath(propertyId));
  }

  const signedInNonResident = Boolean(ctx.user) && !hasRole(ctx, "resident");

  return (
    <Suspense fallback={<div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted">Loading…</div>}>
      <ToursContactPageClient signedInNonResident={signedInNonResident} />
    </Suspense>
  );
}
