import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { resolveAgentContext } from "@/lib/tools/context";
import { resolveResidentAgentContext } from "@/lib/tools/resident-context";
import { inspectionDetail, type InspectionActor } from "@/lib/inspections/server";
import {
  buildInspectionPrintSections,
  inspectionRoomLabel,
  InspectionError,
  type InspectionPrintObservation,
} from "@/lib/inspections/model";
import { PrintButton } from "./print-button";

/**
 * The resident/manager inspection export (C137) — a real print-styled report, not a download
 * gate. Follows the house-printables pattern (`/print/[kind]/[id]`): rendered behind the
 * viewer's own session and printed from the browser, `@media print` does the layout work. Photo
 * bytes are never proxied through this route — `inspectionDetail()` already mints signed
 * `inspection-evidence` URLs (`signPhotos`, 15-minute expiry) and every `<img>` below points
 * straight at Supabase storage, the same signed bytes the editor's own photo grid already uses.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const PORTALS = ["resident", "manager"] as const;
type Portal = (typeof PORTALS)[number];

async function actorFor(portal: string | undefined): Promise<InspectionActor | null> {
  if (portal === "manager") {
    const context = await resolveAgentContext();
    return context ? { role: "manager", context } : null;
  }
  if (portal === "resident") {
    const context = await resolveResidentAgentContext();
    return context ? { role: "resident", context } : null;
  }
  return null;
}

function ConditionBadge({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <span className="inline-block rounded-full border border-black/15 px-2 py-0.5 text-[11px] font-semibold text-black/70">
      {label}
    </span>
  );
}

function ObservationBlock({ observation }: { observation: InspectionPrintObservation }) {
  const hasContent = observation.conditionLabel || observation.notes || observation.photos.length > 0;
  return (
    <div className="break-inside-avoid py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-black/55">{observation.heading}</p>
        <ConditionBadge label={observation.conditionLabel} />
        {!hasContent ? <span className="text-[12px] text-black/45">Not recorded</span> : null}
      </div>
      {observation.notes ? <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{observation.notes}</p> : null}
      {observation.photos.length > 0 ? (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {observation.photos.map((photo) => (
            <figure key={photo.id} className="break-inside-avoid">
              {/* Signed evidence URL — the browser fetches these bytes directly from storage. */}
              {photo.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.url} alt="" className="h-28 w-full rounded-lg object-cover" />
              ) : (
                <div className="flex h-28 w-full items-center justify-center rounded-lg border border-dashed border-black/15 text-[11px] text-black/45">
                  Photo unavailable
                </div>
              )}
              <figcaption className="mt-1 text-[10px] text-black/50">{photo.uploadedAt.slice(0, 10)}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default async function InspectionPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: rawId } = await params;
  const parsedId = z.string().uuid().safeParse(rawId);
  if (!parsedId.success) notFound();
  const id = parsedId.data;

  const query = await searchParams;
  const portalParam = typeof query.portal === "string" ? query.portal : undefined;
  const portal: Portal = portalParam === "manager" ? "manager" : "resident";

  const actor = await actorFor(portal);
  if (!actor) redirect(`/auth/sign-in?next=${encodeURIComponent(`/print/inspection/${id}?portal=${portal}`)}`);

  let detail;
  try {
    detail = await inspectionDetail(actor, id);
  } catch (error) {
    if (error instanceof InspectionError && error.status === 404) notFound();
    throw error;
  }

  const { report, baseline } = detail;
  const sections = buildInspectionPrintSections(report, baseline);
  const roomLabel = inspectionRoomLabel(report.room_label) || "Property";
  const kindLabel = report.kind === "move-in" ? "Move-in" : "Move-out";
  const title = `${kindLabel} inspection · ${report.resident_name}`;

  return (
    <div className="print-root min-h-screen bg-[#eef0f4] px-4 py-6 print:bg-white print:p-0">
      <title>{title}</title>
      <div className="print-toolbar mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[#0b1120]/70">{title}</p>
        <PrintButton />
      </div>
      <article className="print-sheet print-sheet-letter mx-auto bg-white text-[#0b1120]" data-attr="print-inspection-report">
        <header>
          <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">PropLane · {kindLabel} inspection</p>
          <h1 className="mt-1 text-[30px] font-bold leading-tight tracking-tight">{report.resident_name}</h1>
          <p className="mt-1 text-[15px] text-black/70">{report.property_label} · {roomLabel}</p>
          <p className="mt-3 text-[12px] text-black/55">
            Inspection date {report.inspection_date} · Revision {report.revision} · Report {report.id}
          </p>
          {baseline ? (
            <p className="mt-1 text-[12px] text-black/55">Move-in baseline: {baseline.inspection_date} ({baseline.id})</p>
          ) : report.kind === "move-out" ? (
            <p className="mt-1 text-[12px] text-black/55">No move-in baseline attached. This report alone does not establish when damage occurred.</p>
          ) : null}
          <p className="mt-3 text-[12px] leading-relaxed text-black/60">
            Photos and notes document condition. Each photo records the party who added it and when. Deposit
            decisions and charges are handled separately. Sections with no photos were not recorded.
          </p>
        </header>

        <div className="mt-6 divide-y divide-black/10">
          {sections.map((section) => (
            <section key={section.id} className="break-inside-avoid py-4">
              <h2 className="text-[15px] font-bold tracking-tight">{section.title}</h2>
              <div className="divide-y divide-black/5">
                {section.observations.map((observation) => (
                  <ObservationBlock key={observation.heading} observation={observation} />
                ))}
              </div>
            </section>
          ))}
        </div>

        {report.document.history.length > 0 ? (
          <footer className="mt-6 border-t border-black/10 pt-4">
            <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">Record history</h2>
            <ul className="mt-2 space-y-1 text-[11px] text-black/60">
              {report.document.history.map((event, index) => (
                <li key={index}>{event.at} · {event.role} · {event.action} · {event.userId}</li>
              ))}
            </ul>
          </footer>
        ) : null}
      </article>
      <style>{`
        .print-sheet { border-radius: 18px; box-shadow: 0 12px 34px rgba(8,9,11,.08); }
        .print-sheet-letter { width: 8.5in; min-height: 11in; padding: 0.7in; max-width: 100%; }
        @media print {
          @page { margin: 0; }
          html, body { background: #fff !important; }
          .print-root { padding: 0 !important; }
          .print-sheet { border-radius: 0; box-shadow: none; }
          .print-sheet-letter { width: 8.5in; min-height: 11in; padding: 0.7in; }
        }
      `}</style>
    </div>
  );
}
