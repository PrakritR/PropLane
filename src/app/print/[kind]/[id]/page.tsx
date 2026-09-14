import { notFound, redirect } from "next/navigation";
import QRCode from "qrcode";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildHouseDoorCard,
  buildHousePublicPage,
  buildHouseWelcomeSheet,
  houseAddressLine,
  type HousePrintableLine,
} from "@/lib/house-printables/model";
import { loadHouseOwnerSmsPhone, loadHouseRecord, managerMayPrintHouse } from "@/lib/house-printables/load.server";
import { buildHousePublicUrl, ensureHousePublicLink } from "@/lib/house-printables/public-link.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { PrintButton } from "./print-button";

/**
 * The three house printables, rendered behind the manager's session and
 * printed from the browser — no PDF library, `@media print` does the work.
 *
 *   /print/door-card/<propertyId>    public · a QR to the house page, no codes
 *   /print/house-rules/<propertyId>  public · the rules poster, same QR
 *   /print/welcome/<propertyId>?room=<roomId>&resident=<name>
 *                                    private · codes and Wi-Fi, a QR to the portal
 *
 * Opening a door card or poster issues the house's public link if it has none,
 * so the QR on paper always points somewhere.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const KINDS = ["door-card", "house-rules", "welcome"] as const;
type Kind = (typeof KINDS)[number];

async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: "svg", margin: 0, color: { dark: "#0b1120", light: "#ffffff00" } });
}

const SHEET = "print-sheet mx-auto bg-white text-[#0b1120]";

function Lines({ lines }: { lines: HousePrintableLine[] }) {
  return (
    <dl className="divide-y divide-black/10">
      {lines.map((line) => (
        <div key={line.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-[11px] font-bold uppercase tracking-[0.1em] text-black/55">{line.label}</dt>
          <dd className="text-right text-[15px] font-semibold">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function HousePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { kind: rawKind, id } = await params;
  if (!(KINDS as readonly string[]).includes(rawKind)) notFound();
  const kind = rawKind as Kind;
  const ctx = await requireManagerRouteUser();
  if (!ctx) redirect(`/auth/sign-in?next=${encodeURIComponent(`/print/${kind}/${id}`)}`);
  const house = await loadHouseRecord(ctx.db, id);
  if (!house || !(await managerMayPrintHouse(ctx.db, ctx.userId, house.ownerUserId))) notFound();
  const origin = resolveEmailLinkBaseUrl();
  const smsPhone = await loadHouseOwnerSmsPhone(ctx.db, house.ownerUserId);
  const smsLabel = smsPhone ? formatSmsPhoneLabel(smsPhone) ?? smsPhone : null;

  let body: React.ReactNode;
  let title: string;

  if (kind === "welcome") {
    const query = await searchParams;
    const roomId = typeof query.room === "string" ? query.room : null;
    const residentName = typeof query.resident === "string" ? query.resident : null;
    const portalUrl = `${origin}/resident`;
    const sheet = buildHouseWelcomeSheet(house.submission, { portalUrl, roomId, residentName, smsPhone });
    const qr = await qrSvg(portalUrl);
    title = `Welcome sheet · ${sheet.name}`;
    body = (
      <article className={`${SHEET} print-sheet-letter`} data-attr="print-welcome-sheet">
        <header className="flex items-start justify-between gap-6">
          <div>
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">Welcome{sheet.residentName ? `, ${sheet.residentName}` : ""}</p>
            <h1 className="mt-1 text-[34px] font-bold leading-tight tracking-tight">
              {sheet.roomLabel ?? sheet.name}
            </h1>
            <p className="mt-1 text-[15px] text-black/70">
              {[sheet.roomLabel ? sheet.name : null, sheet.floorLabel].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-3 text-[15px]">{houseAddressLine(sheet)}</p>
          </div>
          <div className="w-[120px] shrink-0 text-center">
            <div className="print-qr" dangerouslySetInnerHTML={{ __html: qr }} />
            <p className="mt-2 text-[11px] leading-snug text-black/60">Scan to open your resident portal — rent, documents, maintenance.</p>
          </div>
        </header>

        <div className="mt-8 grid grid-cols-2 gap-6">
          <section className="rounded-2xl border border-black/15 p-4">
            <h2 className="mb-1 text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">Getting in</h2>
            {sheet.access.length > 0 ? <Lines lines={sheet.access} /> : <p className="text-[14px] text-black/55">No codes on file.</p>}
          </section>
          <section className="rounded-2xl border border-black/15 p-4">
            <h2 className="mb-1 text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">Wi-Fi</h2>
            {sheet.wifi.length > 0 ? <Lines lines={sheet.wifi} /> : <p className="text-[14px] text-black/55">No Wi-Fi on file.</p>}
          </section>
        </div>

        {sheet.roomInstructions ? (
          <section className="mt-6 rounded-2xl border border-black/15 p-4">
            <h2 className="mb-1 text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">Your room</h2>
            <p className="whitespace-pre-line text-[15px] leading-relaxed">{sheet.roomInstructions}</p>
          </section>
        ) : null}

        <footer className="mt-auto flex items-end justify-between pt-8 text-[13px] text-black/70">
          <p>{smsLabel ? <>Questions? Text <b className="font-semibold text-black">{smsLabel}</b></> : "Questions? Message your manager in the portal."}</p>
          <p className="text-[11px] uppercase tracking-[0.12em] text-black/45">This sheet has your codes — keep it private</p>
        </footer>
      </article>
    );
  } else {
    const link = await ensureHousePublicLink(ctx.db, house.ownerUserId, house.propertyId);
    const url = buildHousePublicUrl(origin, link.token);
    const qr = await qrSvg(url);
    const shortUrl = url.replace(/^https?:\/\//, "");

    if (kind === "door-card") {
      const card = buildHouseDoorCard(house.submission, { url, smsPhone });
      title = `Door card · ${card.name}`;
      body = (
        <article className={`${SHEET} print-sheet-card`} data-attr="print-door-card">
          <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-black/55">Scan for house info & rules</p>
          <h1 className="mt-2 text-[30px] font-bold leading-tight tracking-tight">{card.name}</h1>
          <p className="mt-1 text-[14px] text-black/70">{houseAddressLine(card)}</p>
          <div className="my-6 flex items-center gap-6">
            <div className="print-qr w-[150px] shrink-0" dangerouslySetInnerHTML={{ __html: qr }} />
            <div className="text-[14px] leading-relaxed text-black/75">
              <p>House rules, trash days, and how to reach us.</p>
              <p className="mt-2 break-all font-mono text-[12px] text-black/55">{shortUrl}</p>
            </div>
          </div>
          <footer className="flex items-end justify-between text-[13px] text-black/70">
            <p>{smsLabel ? <>Need help? Text <b className="font-semibold text-black">{smsLabel}</b></> : "Need help? Scan the code."}</p>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-black/45">PropLane</p>
          </footer>
        </article>
      );
    } else {
      const page = buildHousePublicPage(house.submission, { smsPhone, updatedAt: house.updatedAt });
      const updated = page.updatedAt
        ? new Date(page.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
        : null;
      title = `House rules · ${page.name}`;
      body = (
        <article className={`${SHEET} print-sheet-letter`} data-attr="print-house-rules">
          <header className="flex items-start justify-between gap-6">
            <div>
              <h1 className="text-[36px] font-bold leading-tight tracking-tight">House Rules</h1>
              <p className="mt-1 text-[15px] text-black/70">{page.name}{updated ? ` · updated ${updated}` : ""}</p>
            </div>
            <div className="w-[110px] shrink-0 text-center">
              <div className="print-qr" dangerouslySetInnerHTML={{ __html: qr }} />
              <p className="mt-2 text-[10.5px] leading-snug text-black/60">Scan for the current rules, pickup days, and to report an issue.</p>
            </div>
          </header>

          {page.quietHours ? (
            <p className="mt-6 rounded-2xl bg-black/[0.05] px-4 py-3 text-[18px] font-semibold">Quiet hours {page.quietHours}</p>
          ) : null}

          {page.rules.length > 0 ? (
            <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-4">
              {page.rules.map((line) => (
                <section key={line.label} className="break-inside-avoid">
                  <h2 className="text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">{line.label}</h2>
                  <p className="mt-1 whitespace-pre-line text-[15px] leading-relaxed">{line.value}</p>
                </section>
              ))}
            </div>
          ) : page.rulesText ? (
            <p className="mt-6 whitespace-pre-line text-[15px] leading-relaxed">{page.rulesText}</p>
          ) : (
            <p className="mt-6 text-[15px] text-black/55">No house rules have been written yet — add them under House details.</p>
          )}

          {page.trash.length > 0 ? (
            <section className="mt-8 rounded-2xl border border-black/15 p-4">
              <h2 className="mb-1 text-[12px] font-bold uppercase tracking-[0.12em] text-black/55">Trash & recycling</h2>
              <Lines lines={page.trash} />
            </section>
          ) : null}

          <footer className="mt-auto flex items-end justify-between pt-8 text-[13px] text-black/70">
            <p>{smsLabel ? <>Need help? Text <b className="font-semibold text-black">{smsLabel}</b></> : "Need help? Scan the code."}</p>
            <p className="break-all font-mono text-[11px] text-black/50">{shortUrl}</p>
          </footer>
          <p className="mt-2 text-[11px] text-black/45">This poster may be out of date — the page never is.</p>
        </article>
      );
    }
  }

  return (
    <div className="print-root min-h-screen bg-[#eef0f4] px-4 py-6 print:bg-white print:p-0">
      <title>{title}</title>
      <div className="print-toolbar mx-auto mb-4 flex max-w-[8.5in] items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-[#0b1120]/70">{title}</p>
        <PrintButton />
      </div>
      {body}
      <style>{`
        .print-sheet { border-radius: 18px; box-shadow: 0 12px 34px rgba(8,9,11,.08); display: flex; flex-direction: column; }
        .print-sheet-letter { width: 8.5in; min-height: 11in; padding: 0.7in; max-width: 100%; }
        .print-sheet-card { width: 5.5in; min-height: 4.25in; padding: 0.45in; max-width: 100%; }
        .print-qr svg { width: 100%; height: auto; display: block; }
        @media print {
          @page { margin: 0; }
          html, body { background: #fff !important; }
          .print-root { padding: 0 !important; }
          .print-sheet { border-radius: 0; box-shadow: none; }
          .print-sheet-letter { width: 8.5in; height: 11in; padding: 0.7in; }
          .print-sheet-card { width: 5.5in; height: 4.25in; padding: 0.45in; }
        }
      `}</style>
    </div>
  );
}
