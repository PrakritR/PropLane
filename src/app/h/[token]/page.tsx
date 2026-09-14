import Link from "next/link";
import { notFound } from "next/navigation";
import { AxisLogoLink } from "@/components/brand/axis-logo";
import { PublicLightThemeLock } from "@/components/providers/public-light-theme-lock";
import { buildHousePublicPage, houseAddressLine, housePublicPageIsEmpty } from "@/lib/house-printables/model";
import { loadHouseOwnerSmsPhone, loadHouseRecord } from "@/lib/house-printables/load.server";
import { resolveHousePublicToken } from "@/lib/house-printables/public-link.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";

/**
 * The page a scanned door card or rules poster opens.
 *
 * Anyone can scan it, so it renders ONLY {@link buildHousePublicPage}: the house
 * rules, the trash days, and a way to reach the manager. Nothing that opens a
 * door or a network exists on this page — not because the template hides it,
 * but because the model it renders from never reads those sections.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">{title}</h2>
      {children}
    </section>
  );
}

export default async function HousePublicPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const db = createSupabaseServiceRoleClient();
  const link = await resolveHousePublicToken(db, token);
  if (!link) notFound();
  const house = await loadHouseRecord(db, link.propertyId);
  if (!house || house.ownerUserId !== link.managerUserId) notFound();
  const smsPhone = await loadHouseOwnerSmsPhone(db, house.ownerUserId);
  const page = buildHousePublicPage(house.submission, { smsPhone, updatedAt: house.updatedAt });
  const updated = page.updatedAt
    ? new Date(page.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-4 pb-10 pt-6 text-foreground" data-attr="house-public-page">
      <PublicLightThemeLock />
      <header className="mb-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">House info</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{page.name}</h1>
        {houseAddressLine(page) ? <p className="mt-1 text-sm text-muted">{houseAddressLine(page)}</p> : null}
      </header>

      <div className="space-y-3">
        {page.smsPhone ? (
          <a
            href={`sms:${page.smsPhone}`}
            className="flex min-h-[48px] items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground"
            data-attr="house-public-text-manager"
          >
            Text the manager · {formatSmsPhoneLabel(page.smsPhone) ?? page.smsPhone}
          </a>
        ) : null}

        {page.quietHours ? (
          <Section title="Quiet hours">
            <p className="text-lg font-semibold tabular-nums">{page.quietHours}</p>
          </Section>
        ) : null}

        {page.rules.length > 0 ? (
          <Section title="House rules">
            <dl className="divide-y divide-border">
              {page.rules.map((line) => (
                <div key={line.label} className="py-2.5">
                  <dt className="text-xs font-semibold text-muted">{line.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-line text-sm">{line.value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : page.rulesText ? (
          <Section title="House rules">
            <p className="whitespace-pre-line text-sm">{page.rulesText}</p>
          </Section>
        ) : null}

        {page.trash.length > 0 ? (
          <Section title="Trash & recycling">
            <dl className="divide-y divide-border">
              {page.trash.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3 py-2.5">
                  <dt className="text-xs font-semibold text-muted">{line.label}</dt>
                  <dd className="text-right text-sm">{line.value}</dd>
                </div>
              ))}
            </dl>
          </Section>
        ) : null}

        {housePublicPageIsEmpty(page) ? (
          <Section title="House rules">
            <p className="text-sm text-muted">The manager has not posted house rules yet.</p>
          </Section>
        ) : null}

        <Link
          href="/resident/services"
          className="flex min-h-[48px] items-center justify-center rounded-full border border-border bg-card px-5 text-sm font-semibold"
          data-attr="house-public-report-issue"
        >
          Report an issue
        </Link>
        <p className="text-center text-xs text-muted">Residents sign in to request a repair or ask a question.</p>
      </div>

      <footer className="mt-auto flex items-center justify-center gap-2 pt-10 text-xs text-muted">
        <AxisLogoLink size="compact" />
        {updated ? <span>· updated {updated}</span> : null}
      </footer>
    </div>
  );
}
