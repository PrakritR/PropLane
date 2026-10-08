"use client";

import type { ReactNode } from "react";
import {
  Check,
  Clock,
  FileText,
  Link2,
  Megaphone,
  QrCode,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import type { PropertyPromotionBuiltinDef } from "@/lib/property-promotion-builtin";

const ICONS: Record<PropertyPromotionBuiltinDef["kind"], LucideIcon> = {
  flyer: Megaphone,
  text: FileText,
  print: QrCode,
};

export function PropertyPromotionBuiltinRow({
  def,
  enabled,
  facts,
  onOpen,
  onToggle,
  onDownload,
  onShare,
  dataAttr,
}: {
  def: PropertyPromotionBuiltinDef;
  enabled: boolean;
  facts: ReactNode;
  onOpen: () => void;
  onToggle: () => void;
  onDownload?: () => void;
  onShare?: () => void;
  dataAttr: string;
}) {
  const Icon = ICONS[def.kind];
  return (
    <PortalPropertyRecordRow
      title={def.name}
      leading={<PortalRowIconTile icon={Icon} />}
      leadingShape="square"
      facts={
        <>
          <PortalRowFact icon={Check}>Default</PortalRowFact>
          {facts}
        </>
      }
      onOpen={onOpen}
      dataAttr={dataAttr}
      // The on/off switch sits at the row's end, before the menu; Download and Share live in the menu.
      actions={
        <>
          <PortalSettingsToggle
            checked={enabled}
            onChange={() => onToggle()}
            label={`${def.name} on or off`}
            dataAttr={`${dataAttr}-switch`}
          />
          <RowActionsMenu label={`Actions for ${def.name}`} items={[
            { id: "edit", label: def.kind === "print" ? "Open to print" : "Edit", onSelect: onOpen },
            onDownload && def.kind !== "print" ? { id: "download", label: "Download", onSelect: onDownload } : null,
            onShare && def.kind !== "print" ? { id: "share", label: "Share", onSelect: onShare } : null,
          ]} />
        </>
      }
    />
  );
}

export function PropertyPromotionBuiltinFacts({
  kind,
  detail,
}: {
  kind: PropertyPromotionBuiltinDef["kind"];
  detail: string;
}) {
  const icon = kind === "print" ? QrCode : kind === "text" ? Sparkles : Megaphone;
  return (
    <>
      <PortalRowFact icon={icon}>{detail}</PortalRowFact>
      {kind === "print" ? <PortalRowFact icon={Link2}>Public · no codes</PortalRowFact> : null}
      {kind !== "print" ? <PortalRowFact icon={Clock}>From the listing</PortalRowFact> : null}
    </>
  );
}
