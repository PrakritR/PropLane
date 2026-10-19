"use client";

import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { OwnerProfileView } from "@/components/owner/owner-profile-view";

/** Profile: who is signed in, and Sign out. An owner has no plan, billing or workspace to manage. */
export function OwnerProfile({ name, email }: { name: string | null; email: string | null }) {
  return <OwnerProfileView name={name} email={email} action={<PortalSignOutButton className="text-sm font-semibold text-red-600" dataAttr="owner-sign-out" />} />;
}
