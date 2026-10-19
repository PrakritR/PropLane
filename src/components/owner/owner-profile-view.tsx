import type { ReactNode } from "react";
import { OwnerPageTitle } from "@/components/owner/owner-ui";

/** Shared profile presentation; the caller owns its session action. */
export function OwnerProfileView({ name, email, action }: { name: string | null; email: string | null; action: ReactNode }) {
  return (
    <div data-attr="owner-profile">
      <OwnerPageTitle>Settings</OwnerPageTitle>
      <div className="max-w-md divide-y divide-border/60 rounded-2xl border border-border bg-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted">Name</span>
          <span className="font-medium text-foreground">{name?.trim() || "—"}</span>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span className="text-muted">Email</span>
          <span className="truncate font-medium text-foreground">{email?.trim() || "—"}</span>
        </div>
        <div className="px-4 py-3">{action}</div>
      </div>
    </div>
  );
}
