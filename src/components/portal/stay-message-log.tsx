"use client";

/** The booking's Messages rows (design-1112 §7): each automated check-in / check-out message, when, and per channel what happened. */
import { useEffect, useState } from "react";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";

type LogRow = {
  id: string;
  kind: "check_in" | "check_out" | "check_in_correction";
  status: "scheduled" | "sent" | "partial" | "failed" | "held" | "cancelled";
  hold_reason: string | null;
  due_at: string;
  sent_at: string | null;
  channels: Record<string, { status?: string; reason?: string } | number | undefined> | null;
};

const KIND: Record<LogRow["kind"], string> = { check_in: "Check-in message", check_out: "Check-out message", check_in_correction: "Check-in update" };
const STATUS: Record<LogRow["status"], string> = { scheduled: "Scheduled", sent: "Sent", partial: "Partly sent", failed: "Failed", held: "Held", cancelled: "Cancelled" };
const HOLD: Record<string, string> = {
  room_code_missing: "no room door code",
  foreign_code: "carried a code that is not the guest's",
  no_contact: "no contact details",
  source_off: "switched off for this source",
  cancelled: "booking cancelled",
};
const CHANNEL = { sms: "Text", email: "Email", inbox: "In app" } as const;

function whenLabel(iso: string | null): string {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "";
}

export function StayMessageLog({ stayKey }: { stayKey: string }) {
  const [rows, setRows] = useState<LogRow[]>([]);
  useEffect(() => {
    if (!/^block:/.test(stayKey)) return;
    let live = true;
    void fetch(`/api/portal/stay-messages?stayKey=${encodeURIComponent(stayKey)}`, { cache: "no-store", credentials: "include" })
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((body: { rows?: LogRow[] }) => live && setRows(Array.isArray(body.rows) ? body.rows : []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [stayKey]);
  if (rows.length === 0) return null;
  return (
    <RecordFactCard title="Messages" dataAttr="booking-stay-messages">
      {rows.map((row) => {
        const channels = (Object.keys(CHANNEL) as Array<keyof typeof CHANNEL>)
          .map((name) => {
            const outcome = row.channels?.[name];
            if (!outcome || typeof outcome !== "object" || !outcome.status) return "";
            return `${CHANNEL[name]} ${outcome.status}${outcome.status === "failed" && outcome.reason ? ` (${outcome.reason})` : ""}`;
          })
          .filter(Boolean)
          .join(" · ");
        const detail = row.status === "held" ? `Held: ${HOLD[row.hold_reason ?? ""] ?? "held"}` : [STATUS[row.status], whenLabel(row.sent_at ?? row.due_at), channels].filter(Boolean).join(" · ");
        return <RecordFactRow key={row.id} label={KIND[row.kind]} value={detail} />;
      })}
    </RecordFactCard>
  );
}
