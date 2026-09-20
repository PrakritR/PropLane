"use client";

import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";

export type PortalInvitePath = "link" | "message" | "code";

const OPTIONS: { value: PortalInvitePath; label: string }[] = [
  { value: "link", label: "Link" },
  { value: "message", label: "Message" },
  { value: "code", label: "PropLane code" },
];

/**
 * Invite by — Link / Message / PropLane code on a workspace Review step.
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
    <div data-attr="portal-invite-paths">
      <FieldSingleSelect
        label="Invite by"
        labelClassName={MODAL_FIELD_LABEL_CLASS}
        value={value}
        onChange={(next) => {
          if (next === "link" || next === "message" || next === "code") onChange(next);
        }}
        options={OPTIONS}
        disabled={disabled}
        dataAttr="invite-path"
      />
    </div>
  );
}
