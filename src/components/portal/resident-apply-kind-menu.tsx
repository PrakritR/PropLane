"use client";

/**
 * The Application page's round blue +. It offers the two things a resident can start: a Long-term lease
 * (the application wizard) or a Short stay (the stay request form). One menu, so a short stay is started
 * from the same place as any application (captain, Oct 27: no separate Stays tab).
 */
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ReactElement } from "react";

/** `children` is the band's round + (a `PortalPrimaryIconAction`), which the menu opens. */
export function ResidentApplyKindMenu({
  children,
  onLongTerm,
  onShortStay,
}: {
  children: ReactElement;
  onLongTerm: () => void;
  onShortStay: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem data-attr="resident-applications-apply-long-term" onSelect={onLongTerm}>
          Long-term lease
        </DropdownMenuItem>
        <DropdownMenuItem data-attr="resident-applications-apply-short-stay" onSelect={onShortStay}>
          Short stay
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
