"use client";

/**
 * Lead sources (design-1112 §6): per property, one row per platform that produced a lead - how many leads, how many are
 * still on the platform, how many moved to text, how many hold an account. Rows are the shared record row (tile, title,
 * glyph facts, figure); no pills, no descriptive text. Fed by `GET /api/portal/lead-sources`, itself over `sourceReport`.
 */
import { useEffect, useState } from "react";
import { Globe, MessageSquareText, UserRound } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";

export type LeadSourceRow = { source: string; leads: number; onPlatform: number; movedToSms: number; withAccount: number };

const SOURCE_LABEL: Record<string, string> = {
  sms: "Text",
  listing_message: "Listing message",
  in_app: "In app",
  application: "Application",
  tour: "Tour",
  voice: "Call",
  spareroom: "SpareRoom",
  roomies: "Roomies",
  facebook: "Facebook",
  zillow: "Zillow",
  craigslist: "Craigslist",
  roomster: "Roomster",
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  padsplit: "PadSplit",
  other: "Other",
};

export function leadSourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

export function LeadSourceReport({ propertyId, workspaceId }: { propertyId?: string | null; workspaceId?: string | null }) {
  const [rows, setRows] = useState<LeadSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams();
    if (propertyId) query.set("propertyId", propertyId);
    if (workspaceId) query.set("workspaceId", workspaceId);
    void fetch(`/api/portal/lead-sources?${query.toString()}`, { cache: "no-store", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not load lead sources.");
        return (await res.json()) as { rows?: LeadSourceRow[] };
      })
      .then((body) => {
        if (!live) return;
        setRows(Array.isArray(body.rows) ? body.rows : []);
        setError(undefined);
      })
      .catch((cause: unknown) => live && setError(cause instanceof Error ? cause.message : "Could not load lead sources."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [propertyId, workspaceId, attempt]);

  return (
    <PortalRecordListSurface
      dataAttr="lead-source-report"
      loading={loading}
      loadError={error}
      onRetry={() => { setLoading(true); setAttempt((n) => n + 1); }}
      isEmpty={rows.length === 0}
      emptyCard={{ title: "No lead sources yet", section: "communication" }}
    >
      {rows.map((row) => (
        <PortalApplicantRecordRow
          key={row.source}
          name={leadSourceLabel(row.source)}
          tileIcon={Globe}
          dataAttr={`lead-source-row-${row.source}`}
          amount={String(row.leads)}
          amountSubLabel="Leads"
          facts={
            <>
              <PortalRowFact icon={Globe} srLabel="Still on the platform">{row.onPlatform} on platform</PortalRowFact>
              <PortalRowFact icon={MessageSquareText} srLabel="Moved to text">{row.movedToSms} moved to text</PortalRowFact>
              <PortalRowFact icon={UserRound} srLabel="With an account">{row.withAccount} with an account</PortalRowFact>
            </>
          }
        />
      ))}
    </PortalRecordListSurface>
  );
}
