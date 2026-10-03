"use client";

import { useEffect, useMemo, useState } from "react";
import { Link2 } from "lucide-react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { CopyIconAction, PortalIconAction } from "@/components/portal/portal-icon-action";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { fetchManagerChannelBookings, fetchRoomExportCalendarUrl } from "@/lib/channel-calendar/client";
import { channelCalendarUnits } from "@/lib/channel-calendar/property-units";

type Site = "airbnb" | "booking_com" | "vrbo" | "other";

const SITE_OPTIONS = [
  { value: "airbnb", label: "Airbnb" },
  { value: "booking_com", label: "Booking.com" },
  { value: "vrbo", label: "VRBO" },
  { value: "other", label: "Other" },
];

const SITE_STEPS: Record<Site, string[]> = {
  airbnb: ["Copy a link above.", "In Airbnb, open the listing's Calendar and its availability settings.", "Choose Import calendar.", "Paste the link and save."],
  booking_com: ["Copy a link above.", "In the Booking.com extranet, open Calendar and then Sync calendars.", "Choose Import calendar.", "Paste the link and save."],
  vrbo: ["Copy a link above.", "In VRBO, open the listing's Calendar.", "Choose Import calendar.", "Paste the link and save."],
  other: ["Copy a link above.", "Open the site's calendar sync or iCal import.", "Paste the link and save."],
};

type Props = {
  open: boolean;
  onClose: () => void;
  propertyOptions: readonly { id: string; label: string }[];
  showToast: (message: string) => void;
};

/**
 * This workspace's PropLane calendar export links (iCal), one per house and room, with Copy
 * and the short steps for pasting one into another site. Links come from the existing export
 * feed; a room that has none yet can mint one, the same call the Connect popup makes.
 */
export function ExportBookingCalendarDialog({ open, onClose, propertyOptions, showToast }: Props) {
  const [site, setSite] = useState<Site>("airbnb");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const idsKey = propertyOptions.map((p) => p.id).join("\n");
  const rows = useMemo(() => propertyOptions.flatMap((p) => channelCalendarUnits(p.id, p.label).map((unit) => ({
    key: `${p.id}:${unit.id}`, propertyId: p.id, roomId: unit.id, unitLabel: unit.label,
    label: unit.id === p.id ? p.label : `${p.label} · ${unit.label}`,
  }))), [propertyOptions]);
  useEffect(() => {
    if (!open || !idsKey) return;
    let stopped = false;
    setError("");
    fetchManagerChannelBookings(idsKey.split("\n")).then((properties) => {
      if (stopped) return;
      const found: Record<string, string> = {};
      for (const property of properties) for (const room of property.rooms) if (room.exportUrl) found[`${property.propertyId}:${room.roomId}`] ??= room.exportUrl;
      setUrls((old) => ({ ...found, ...old }));
    }).catch(() => { if (!stopped) setError("Could not load calendar links."); });
    return () => { stopped = true; };
  }, [open, idsKey]);
  const create = async (row: (typeof rows)[number]) => {
    setBusyKey(row.key); setError("");
    try {
      const url = await fetchRoomExportCalendarUrl({ propertyId: row.propertyId, roomId: row.roomId, roomLabel: row.unitLabel });
      setUrls((old) => ({ ...old, [row.key]: url }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create the link."); }
    finally { setBusyKey(""); }
  };
  const copy = async (url: string) => { await navigator.clipboard.writeText(url); showToast("Link copied"); };
  return (
    <PortalDialog open={open} onClose={onClose} title="Export booking calendar" primaryAction={null} dataAttr="export-booking-calendar-dialog">
      <div className="space-y-5">
        {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        {rows.length === 0 ? <p>No houses in this workspace yet.</p> : <ul className="space-y-4">{rows.map((row) => {
          const url = urls[row.key] ?? "";
          return <li key={row.key} className="space-y-1.5" data-attr="export-booking-calendar-row">
            <span className="block text-[12.5px] font-bold text-foreground">{row.label}</span>
            <div className="flex items-center gap-2">
              <Input readOnly aria-label={`${row.label} export link`} value={url} placeholder="No link yet" />
              {url ? <CopyIconAction label={`Copy ${row.label} link`} onCopy={() => copy(url)} /> : <PortalIconAction label={`Create export link for ${row.label}`} icon={Link2} disabled={busyKey === row.key} onClick={() => void create(row)} />}
            </div>
          </li>;
        })}</ul>}
        <FieldSingleSelect label="Paste into" value={site} options={SITE_OPTIONS} onChange={(next) => setSite(next as Site)} dataAttr="export-booking-calendar-site" />
        <ol className="space-y-2" data-attr="export-booking-calendar-steps">{SITE_STEPS[site].map((step, index) => <li key={step} className="flex gap-3 text-sm"><span className="font-bold text-primary">{index + 1}</span><span>{step}</span></li>)}</ol>
      </div>
    </PortalDialog>
  );
}
