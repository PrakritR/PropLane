"use client";

import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { OwnerPageTitle } from "@/components/owner/owner-ui";

/** Profile: who is signed in, and Sign out. An owner has no plan, billing or workspace to manage. */
export function OwnerProfile({ name, email }: { name: string | null; email: string | null }) {
  return (
    <div data-attr="owner-profile">
      <OwnerPageTitle>Profile</OwnerPageTitle>
      <div className="max-w-md divide-y divide-border/60 rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted">Name</span>
          <span className="font-medium text-foreground">{name?.trim() || "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted">Email</span>
          <span className="truncate font-medium text-foreground">{email?.trim() || "—"}</span>
        </div>
        <div className="px-4 py-3">
          <PortalSignOutButton className="text-sm font-semibold text-red-600" dataAttr="owner-sign-out" />
        </div>
      </div>
    </div>
  );
}
