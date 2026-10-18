/**
 * The REAL record header (`PortalDetailHeader`) with the REAL adaptive action row, in a browser
 * where widths actually measure. jsdom reports every width as 0, so the fold decision — the whole
 * point of the Oct 16 fix — can only be SEEN here: five icons inline on a desktop header, and the
 * ⋯ appearing when the header genuinely runs out of room.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { Copy, Eye, Pencil, Share2, Trash2 } from "lucide-react";
import { PortalDetailHeader } from "../../../src/components/portal/portal-list-detail-shell";
import { PortalAdaptiveActionRow, type PortalAdaptiveAction } from "../../../src/components/portal/portal-adaptive-action-row";
import { PortalIconAction } from "../../../src/components/portal/portal-icon-action";
import { DropdownMenuItem } from "../../../src/components/ui/dropdown-menu";
import {
  PortalTitleActionsProvider,
  usePublishTitleActions,
} from "../../../src/components/portal/portal-title-actions-slot";

const ACTIONS: { icon: typeof Pencil; label: string }[] = [
  { icon: Pencil, label: "Edit" },
  { icon: Share2, label: "Share" },
  { icon: Copy, label: "Copy link" },
  { icon: Eye, label: "Preview" },
  { icon: Trash2, label: "Delete" },
];

function actions(count: number): PortalAdaptiveAction[] {
  return ACTIONS.slice(0, count).map(({ icon, label }, index) => ({
    id: `a${index}`,
    tone: label === "Delete" ? ("danger" as const) : undefined,
    node: <PortalIconAction ring icon={icon} label={label} />,
    menuItem: <DropdownMenuItem>{label}</DropdownMenuItem>,
  }));
}

function Publisher({ count }: { count: number }) {
  usePublishTitleActions(<PortalAdaptiveActionRow actions={actions(count)} align="end" gapPx={6} />, true);
  return null;
}

function Fixture() {
  const params = new URLSearchParams(location.search);
  const count = Number(params.get("actions") ?? "5");
  const title = params.get("title") ?? "Room 3 · 4709A 8th Ave NE";
  return (
    <PortalTitleActionsProvider>
      <div className="mx-auto max-w-[1100px] px-4 py-6">
        <div className="rounded-xl border border-border bg-background">
          <PortalDetailHeader
            title={title}
            subtitle="Lease · Active · Maya Zuneh"
            avatarName="Maya Zuneh"
            onBack={() => {}}
            backLabel="Back"
            iconTitleActions
            titleSingleLine
          />
        </div>
        <Publisher count={count} />
      </div>
    </PortalTitleActionsProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
