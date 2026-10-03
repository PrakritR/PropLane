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
          {!enabled ? <PortalRowFact icon={Clock}>Off</PortalRowFact> : null}
        </>
      }
      onOpen={onOpen}
      dataAttr={dataAttr}
      actions={
        <RowActionsMenu label={`Actions for ${def.name}`} items={[
          { id: "edit", label: "Edit", onSelect: onOpen },
          onDownload ? { id: "download", label: "Download", onSelect: onDownload } : null,
          onShare ? { id: "share", label: "Share", onSelect: onShare } : null,
          { id: "toggle", label: enabled ? "Turn off" : "Turn on", onSelect: onToggle },
        ]} />
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
