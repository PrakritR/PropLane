"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PortalInvitePath = "link" | "message" | "code";

const TABS: { id: PortalInvitePath; label: string; attr: string }[] = [
  { id: "link", label: "Link", attr: "invite-path-link" },
  { id: "message", label: "Message", attr: "invite-path-message" },
  { id: "code", label: "PropLane code", attr: "invite-path-code" },
];

/**
 * Invite methods — link, message, PropLane code. Email is a Send via channel
 * on the next page (New message), never a tab here.
 */
export function PortalInvitePaths({
  value,
  onChange,
  disabled = false,
}: {
  value: PortalInvitePath;
  onChange: (next: PortalInvitePath) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="grid grid-cols-3 gap-1 rounded-xl bg-accent/50 p-1"
      role="tablist"
      aria-label="Invite method"
      data-attr="portal-invite-paths"
    >
      {TABS.map((tab) => {
        const selected = value === tab.id;
        return (
          <Button
            key={tab.id}
            type="button"
            variant="ghost"
            role="tab"
            aria-selected={selected}
            aria-label={
              tab.id === "link"
                ? "Invite via link"
                : tab.id === "message"
                  ? "Invite via message"
                  : "Invite via PropLane code"
            }
            className={cn("rounded-lg px-2 text-[13px]", selected && "bg-card text-primary shadow-sm")}
            disabled={disabled}
            data-attr={tab.attr}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </Button>
        );
      })}
    </div>
  );
}
