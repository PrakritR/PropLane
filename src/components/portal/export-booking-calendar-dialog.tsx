"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2 } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { fetchManagerChannelBookings, fetchRoomExportCalendarUrl } from "@/lib/channel-calendar/client";
import type { ChannelCalendarProvider } from "@/lib/channel-calendar/types";
import { channelCalendarUnits } from "@/lib/channel-calendar/property-units";

type Site = "airbnb" | "booking_com" | "vrbo" | "other";

const SITE_OPTIONS = [
  { value: "airbnb", label: "Airbnb" },
  { value: "booking_com", label: "Booking.com" },
  { value: "vrbo", label: "VRBO" },
  { value: "other", label: "Other" },
];

const SITE_STEPS: Record<Site, string[]> = {
  airbnb: ["Copy a link below.", "In Airbnb, open the listing's Calendar and its availability settings.", "Choose Import calendar.", "Paste the link and save."],
  booking_com: ["Copy a link below.", "In the Booking.com extranet, open Calendar and then Sync calendars.", "Choose Import calendar.", "Paste the link and save."],
  vrbo: ["Copy a link below.", "In VRBO, open the listing's Calendar.", "Choose Import calendar.", "Paste the link and save."],
  other: ["Copy a link below.", "Open the site's calendar sync or iCal import.", "Paste the link and save."],
};

type Props = {
  open: boolean;
  onClose: () => void;
  propertyOptions: readonly { id: string; label: string }[];
  showToast: (message: string) => void;
};

/**
 * This workspace's PropLane calendar export links (iCal), one per house and room, with Copy
 * and the short steps for pasting one into another site. "Paste into" picks the destination:
 * a link is minted per (room, channel), and its feed leaves that channel's own bookings out so
 * they do not echo back. VRBO / Other have no channel of their own, so their link (the room's
 * existing token plus `?channels=all`) carries every channel's bookings.
 */
export function ExportBookingCalendarDialog({ open, onClose, propertyOptions, showToast }: Props) {
  const [site, setSite] = useState<Site>("airbnb");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const idsKey = propertyOptions.map((p) => p.id).join("\n");
  const groups = useMemo(() => propertyOptions.map((p) => ({
    id: p.id, label: p.label,
    rows: channelCalendarUnits(p.id, p.label).map((unit) => ({
      key: `${p.id}:${unit.id}`, propertyId: p.id, roomId: unit.id, unitLabel: unit.label, name: unit.name, label: `${p.label} · ${unit.name}`,
    })),
  })).filter((g) => g.rows.length > 0), [propertyOptions]);
  useEffect(() => {
    if (!open || !idsKey) return;
    let stopped = false;
    setError("");
    fetchManagerChannelBookings(idsKey.split("\n")).then((properties) => {
      if (stopped) return;
      const found: Record<string, string> = {};
      for (const property of properties) for (const room of property.rooms) if (room.exportUrl) {
        found[`${property.propertyId}:${room.roomId}:${room.provider}`] ??= room.exportUrl;
        // Any existing link also serves a generic site once it asks for every channel.
        found[`${property.propertyId}:${room.roomId}:other`] ??= `${room.exportUrl}?channels=all`;
      }
      setUrls((old) => ({ ...found, ...old }));
    }).catch(() => { if (!stopped) setError("Could not load calendar links."); });
    return () => { stopped = true; };
  }, [open, idsKey]);
  const destination: ChannelCalendarProvider | "other" = site === "airbnb" || site === "booking_com" ? site : "other";
  const create = async (row: (typeof groups)[number]["rows"][number]) => {
    setBusyKey(row.key); setError("");
    try {
      const url = await fetchRoomExportCalendarUrl({ propertyId: row.propertyId, roomId: row.roomId, roomLabel: row.unitLabel, provider: destination });
      setUrls((old) => ({ ...old, [`${row.key}:${destination}`]: url }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the link."); }
    finally { setBusyKey(""); }
  };
  const copy = async (url: string) => { await navigator.clipboard.writeText(url); showToast("Link copied"); };
  return (
    <PortalDialog open={open} onClose={onClose} title="Export booking calendar" primaryAction={null} contextPanel={null} preview={null} dataAttr="export-booking-calendar-dialog">
      <div className="space-y-5">
        <FieldSingleSelect label="Paste into" value={site} options={SITE_OPTIONS} onChange={(next) => setSite(next as Site)} dataAttr="export-booking-calendar-site" />
        <ol className="space-y-2" data-attr="export-booking-calendar-steps">{SITE_STEPS[site].map((step, index) => <li key={step} className="flex gap-3 text-sm"><span className="font-bold text-primary">{index + 1}</span><span>{step}</span></li>)}</ol>
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {groups.length === 0 ? <p>No houses in this workspace yet.</p> : groups.map((group) => <section key={group.id} className="space-y-1" data-attr="export-booking-calendar-house">
          <h3 className="text-[12.5px] font-bold text-foreground">{group.label}</h3>
          <ul className="divide-y divide-border/70">{group.rows.map((row) => {
            const url = urls[`${row.key}:${destination}`] ?? "";
            return <li key={row.key} className="flex min-h-12 items-center justify-between gap-3 py-1.5" data-attr="export-booking-calendar-row">
              <span className="shrink-0 text-sm">{row.name}</span>
              {url ? <div className="flex min-w-0 items-center gap-2">
                <Input readOnly aria-label={`${row.label} export link`} value={url} className="min-w-0 truncate font-mono text-xs" />
                <CopyIconAction label={`Copy ${row.label} link`} onCopy={() => copy(url)} />
              </div> : <PortalIconAction label={`Create link for ${row.label}`} icon={Link2} disabled={busyKey === row.key} onClick={() => void create(row)} />}
            </li>;
          })}</ul>
        </section>)}
      </div>
    </PortalDialog>
  );
}
