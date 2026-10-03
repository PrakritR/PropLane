import type { DemoApplicantRow, DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import type { RecordSectionActivityEvent } from "@/components/portal/record-section-renderers";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { formatResidentShortDate } from "@/lib/manager-resident-lifecycle";
import { applicationStartedLabel } from "@/lib/rental-application/in-progress-application";

function applicationDetailIso(app: DemoApplicantRow): string | null {
  const label = applicationStartedLabel(app).replace(/^(started|submitted|updated)\s+/i, "").trim();
  const match = label.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function applicationLooksSubmitted(app: DemoApplicantRow): boolean {
  return applicationStartedLabel(app).toLowerCase().startsWith("submitted");
}

function parseTime(value: string | undefined | null): number {
  if (!value?.trim()) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function stamp(iso: string, label: string, id: string): RecordSectionActivityEvent {
  const formatted = formatResidentShortDate(iso) || iso;
  return { id, label, timestamp: formatted };
}

export function buildManagerResidentActivityEvents(input: {
  applicationRow: DemoApplicantRow | null;
  leaseRows: LeasePipelineRow[];
  ledgerRows: DemoManagerPaymentLedgerRow[];
  importEvents?: RecordSectionActivityEvent[];
}): RecordSectionActivityEvent[] {
  const events: RecordSectionActivityEvent[] = [];

  if (input.importEvents?.length) {
    events.push(...input.importEvents);
  }

  const app = input.applicationRow;
  if (app) {
    const detailIso = applicationDetailIso(app);
    if (applicationLooksSubmitted(app) && detailIso) {
      events.push(stamp(detailIso, "Application submitted", `app-submitted-${app.id}`));
    }
    if (app.bucket === "approved" && detailIso) {
      events.push(stamp(detailIso, "Application approved", `app-approved-${app.id}`));
    }
    if (app.bucket === "rejected" && detailIso) {
      events.push(stamp(detailIso, "Application declined", `app-declined-${app.id}`));
    }
  }

  for (const lease of input.leaseRows) {
    if (lease.sentToResidentAt) {
      events.push(stamp(lease.sentToResidentAt, "Lease sent for signature", `lease-sent-${lease.id}`));
    }
    if (lease.fullySignedAt) {
      events.push(stamp(lease.fullySignedAt, "Lease fully signed", `lease-signed-${lease.id}`));
    }
  }

  for (const row of input.ledgerRows) {
    if (row.bucket === "paid") {
      const when = row.createdAt || row.dueDate;
      if (when) {
        events.push(stamp(when, `Payment received · ${row.chargeTitle}`, `paid-${row.id}`));
      }
    } else if (row.bucket === "overdue" && row.dueDate) {
      events.push(stamp(row.dueDate, `Overdue · ${row.chargeTitle}`, `overdue-${row.id}`));
    }
  }

  return events
    .filter((e) => e.label && e.timestamp)
    .sort((a, b) => parseTime(b.timestamp) - parseTime(a.timestamp));
}
