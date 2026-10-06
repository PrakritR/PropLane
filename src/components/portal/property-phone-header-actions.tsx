"use client";

import { MoreHorizontal } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";
import { splitPropertyPhoneHeaderActions } from "@/lib/property-phone-header-actions";

/**
 * The property header on a phone: Edit plus one ⋯ (Share, Unlist, Duplicate,
 * Delete, and the preview's Email). Two round icons leave the title a whole
 * line, so the name truncates with an ellipsis and the address shows instead of
 * the name wrapping over two lines.
 */
export function PropertyPhoneHeaderActions({
  actions,
  extra,
}: {
  actions: PortalAdaptiveAction[];
  extra?: PortalAdaptiveAction | null;
}) {
  const { primary, menu } = splitPropertyPhoneHeaderActions(actions, extra);
  return (
    <div className="flex shrink-0 items-center gap-1.5" data-attr="property-header-phone-actions">
      {primary ? <div className="shrink-0">{primary.node}</div> : null}
      {menu.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PortalIconAction
              ring
              icon={MoreHorizontal}
              label="More actions"
              data-attr="property-header-more"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="record-action-menu">
            {menu.map((action) => (
              <div key={action.id}>{action.menuItem}</div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
