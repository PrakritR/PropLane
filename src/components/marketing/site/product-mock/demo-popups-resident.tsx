"use client";

/**
 * The resident portal's pop-ups and record pages for the home demo, drawn from the REAL pieces with fixture props.
 *
 * Captain 2026-10-08: "a lot of the pop ups in home page are not accurate to real portal". The resident real pages
 * open (a) small centred `Modal`s ("Report a problem", "Choose a home to tour", "Apply to a property", "Withdraw
 * application", "Pay charges", "Add to documents", "New message", "Customize dashboard") and (b) record pages with a
 * section rail and header icons (`recordSections("resident", kind)`): lease, service, application, payment, document,
 * inspection, plus the Tour page and the one-question-per-screen form flow. The pages themselves fetch their record
 * and mount the assistant, so the demo cannot mount them; this file composes the same exported pieces the real pages
 * compose (`Modal`, `ServiceIntakeFormFields`, `PropertySearchPicker`, `ManagerCommunicationComposeModal`,
 * `DashboardCustomizeModal`, `HouseInfoReadSections`, `MoveInFormQuestionField`, the record-overview kit,
 * `DemoRecordPage`) and writes the few private ones (the pay modal's method picker, the sign dialog, the form flow's
 * frame) from the real copy.
 *
 * Every real `Modal` here draws inside the demo window (`DemoModalScope`: the host element becomes the modals'
 * portal container and their `position: fixed` containing block). Nothing fetches or saves: the primary closes and the
 * panel toasts "(sample)". Loaded on demand (`demo-popups-lazy-resident.tsx`).
 */

import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Download,
  Flag,
  Pencil,
  PenLine,
  RefreshCw,
  Send,
  Undo2,
  Upload,
  ArrowLeft,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { MODAL_FIELD_LABEL_CLASS, MODAL_LARGE_PANEL_CLASS } from "@/components/ui/modal-styles";
import { Input } from "@/components/ui/input";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalContainerProvider } from "@/components/ui/portal-container-context";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { DashboardCustomizeModal } from "@/components/portal/dashboard-customize-modal";
import { ManagerCommunicationComposeModal } from "@/components/portal/pro-communication-compose-modal";
import { PopupRecordPreview } from "@/components/portal/popup-live-preview";
import { PropertySearchPicker } from "@/components/marketing/property-search-picker";
import {
  AmenitiesSection,
  HousematesTabContent,
  InfoTabContent,
  InstructionsTabContent,
  MoveInChecklistRow,
} from "@/components/portal/resident-move-in-view";
import { ResidentLeaseBareDocumentPreview, RESIDENT_LEASE_LIST_LABEL } from "@/components/portal/resident-lease-document-preview";
import { ResidentLeaseReportIssueModal } from "@/components/portal/resident-lease-report-issue-modal";
import {
  ServiceIntakeFormFields,
  ServiceIntakePhotoPicker,
  createEmptyServiceIntakeFormState,
  type ServiceIntakeFormState,
} from "@/components/portal/service-intake-form-fields";
import {
  RecordFactCard,
  RecordFactRow,
  RecordNeedsYou,
  RecordRowsCard,
  RecordStatTiles,
  StatTile,
  type RecordNeedsYouItem,
  type RecordRowItem,
  type RecordStatTone,
} from "@/components/portal/portal-record-overview-kit";
import { MoveInFormQuestionField } from "@/components/move-in-forms/move-in-form-question";
import { CheckDraw, MoveInProgressBar } from "@/components/move-in-forms/move-in-motion";
import {
  answerFormatProblem,
  fieldStringToAnswer,
  isMoveInQuestionAnswered,
  requiredMessage,
  visibleMoveInQuestions,
  type MoveInAnswerMap,
} from "@/components/portal/move-in-forms/move-in-form-model";
import { MANAGER_DASHBOARD_SECTIONS } from "@/lib/dashboard-preferences";
import { RESIDENT_DASHBOARD_SECTIONS } from "@/lib/resident-dashboard-preferences";
import { DEFAULT_HOUSEMATE_SHARING, HOUSEMATE_SHARING_LABELS, type HousemateSharing } from "@/lib/resident-housemate-sharing";
import { LEASE_ESIGN_CONSENT_TEXT } from "@/lib/lease-execution-evidence";
import { recordSections, type RecordSectionContext, type RecordSections } from "@/lib/portals/record-sections";
import { buildServiceIntakeOptions } from "@/lib/service-intake";
import { mergeResidentServiceCatalogOffers } from "@/lib/manager-listing-submission";
import { residentPaymentMethodLabel, residentProcessingFeeDisplayLabel, RESIDENT_CARD_PAYMENT_DISPLAY_LABEL } from "@/lib/payment-policy";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_WRAP_CARD,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import { DemoPopupHostContext } from "@/components/marketing/site/product-mock/demo-popup-host";
import {
  DemoRecordPage,
  DemoRecordThread,
  recordActionsFromSections,
  type DemoRecordAction,
} from "@/components/marketing/site/product-mock/demo-record";
import { RESIDENT_HOME, RESIDENT_SELF, type ResidentFormFixture } from "@/components/marketing/site/product-mock/fixtures";
import {
  DEMO_HOME_OPTIONS,
  DEMO_MOVE_IN_RESOLVED,
  DEMO_SERVICE_DETAIL,
  DEMO_TOUR_UPDATES,
  PROPERTY_MANAGER,
  RESIDENT_CONTACT,
  RESIDENT_FORM_QUESTIONS,
  DEMO_COMPOSE_CONTACTS,
  DEMO_RECEIPT,
} from "@/components/marketing/site/product-mock/fixtures-popups-resident";
import { ResidentScheduleTourModal as TourModal } from "@/components/marketing/site/product-mock/demo-popups-resident-tour";

/* ───────────────────────────── the scope every Modal draws in ───────────────────────────── */

/**
 * Where the real `Modal`s draw. The demo window provides a host element (`DemoPopupHostContext`); this layer lives in
 * it, fills the window, and is the portal container for Radix and the containing block for the modal's
 * `position: fixed` stack (a transform makes it one), so a modal covers the demo window and never the page behind.
 * `AppUiProvider` is the toast host the real modals call (`useAppUi`).
 */
export function DemoModalScope({ children }: { children: ReactNode }) {
  const host = useContext(DemoPopupHostContext);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const node = (
    <div
      ref={setLayer}
      data-demo-popup=""
      data-demo-modal-scope=""
      className="pointer-events-auto absolute inset-0 z-[40] overflow-hidden"
      style={{ transform: "translateZ(0)", containerType: "size" }}
    >
      {/* The real panels size themselves to the browser (`100dvh`); inside the demo window they size to the window. */}
      <style>{`@layer utilities { [data-demo-modal-scope] [data-slot="modal-radix-dialog"] { max-height: calc(100cqh - 24px) !important; } }`}</style>
      {layer ? (
        <PortalContainerProvider container={layer}>
          <AppUiProvider>{children}</AppUiProvider>
        </PortalContainerProvider>
      ) : null}
    </div>
  );
  return host ? createPortal(node, host) : node;
}

type Toast = (text: string) => void;

/* ───────────────────────────── dashboards: Customize ───────────────────────────── */

export function DemoCustomizeDashboard({
  role,
  leaseSigned = true,
  visibility,
  onToggle,
  onReset,
  onClose,
}: {
  role: "manager" | "resident";
  /** The resident dashboard drops "House details" from the list until the lease is signed. */
  leaseSigned?: boolean;
  visibility: Record<string, boolean>;
  onToggle: (id: string, visible: boolean) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const sections: readonly { id: string; label: string; description: string }[] =
    role === "manager"
      ? MANAGER_DASHBOARD_SECTIONS
      : leaseSigned
        ? RESIDENT_DASHBOARD_SECTIONS
        : RESIDENT_DASHBOARD_SECTIONS.filter((section) => section.id !== "houseDetails");
  return (
    <DemoModalScope>
      <DashboardCustomizeModal open onClose={onClose} sections={sections} visibility={visibility} onToggle={onToggle} onReset={onReset} />
    </DemoModalScope>
  );
}

/* ───────────────────────────── a record page, drawn from the registry ───────────────────────────── */

type ShellProps = {
  kind: "lease" | "application" | "payment" | "service" | "inspection";
  ctx?: RecordSectionContext;
  title: string;
  subtitle?: string;
  avatarName?: string;
  backLabel: string;
  onBack: () => void;
  recordId: string;
  ariaLabel: string;
  initialSection?: string;
  /** An extra rail row inside the kind's own group (the service's Vendor once one is assigned). */
  extraItem?: { id: string; label: string };
  /** The section's header icons; the registry's set is the default. */
  headerActions?: (sectionId: string, registry: DemoRecordAction[]) => DemoRecordAction[];
  onAction: (actionId: string, sectionId: string) => void;
  primaryId?: string;
  renderSection: (sectionId: string, goTo: (id: string) => void) => ReactNode;
  onToast: Toast;
  /** The record's Communication thread seed. */
  threadMessages?: { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" }[];
};

function ResidentRecordShell(props: ShellProps) {
  const [active, setActive] = useState(props.initialSection ?? "overview");
  const base = useMemo(() => recordSections("resident", props.kind, props.ctx ?? {}), [props.kind, props.ctx]);
  const sections = useMemo<RecordSections>(() => {
    const extra = props.extraItem;
    if (!extra) return base;
    return {
      ...base,
      groups: base.groups.map((group, index) =>
        index === 0 ? { ...group, items: [...group.items, { id: extra.id, label: extra.label, href: () => "#" }] } : group,
      ),
    };
  }, [base, props.extraItem]);
  const registry = recordActionsFromSections(
    recordSections("resident", props.kind, props.ctx ?? {}, active),
    (id) => props.onAction(id, active),
    props.primaryId,
  );
  const actions = props.headerActions ? props.headerActions(active, registry) : registry;

  return (
    <DemoRecordPage
      title={props.title}
      subtitle={props.subtitle}
      avatarName={props.avatarName}
      backLabel={props.backLabel}
      onBack={props.onBack}
      actions={actions}
      sections={sections}
      recordId={props.recordId}
      activeId={active}
      onActive={setActive}
      ariaLabel={props.ariaLabel}
    >
      {active === "communication" ? (
        <DemoRecordThread
          name={PROPERTY_MANAGER.name}
          subtitle="Property manager"
          messages={props.threadMessages ?? []}
          selfName={RESIDENT_SELF}
          onSent={() => props.onToast("Sent (sample)")}
        />
      ) : (
        props.renderSection(active, setActive)
      )}
    </DemoRecordPage>
  );
}

type OverviewCardSpec =
  | { kind?: "facts"; id: string; title: string; action?: { label: string; onClick: () => void }; rows: Array<{ label: string; value: ReactNode; tone?: "ok" | "bad" }> }
  | { kind: "rows"; id: string; title: string; rows: RecordRowItem[]; emptyLabel?: string };

/** The shared Overview shell (`OverviewSection` in `record-section-renderers.tsx`): tiles, Needs you, then the cards. */
function Overview({
  tiles,
  needs,
  cards,
}: {
  tiles?: Array<{ id: string; label: string; value: string; detail?: string; tone?: RecordStatTone }>;
  needs?: RecordNeedsYouItem[];
  cards: OverviewCardSpec[];
}) {
  return (
    <div className="space-y-3">
      {tiles && tiles.length > 0 ? (
        <RecordStatTiles>
          {tiles.map((tile) => (
            <StatTile key={tile.id} label={tile.label} value={tile.value} detail={tile.detail} tone={tile.tone} dataAttr={`record-overview-tile-${tile.id}`} />
          ))}
        </RecordStatTiles>
      ) : null}
      {needs && needs.length > 0 ? <RecordNeedsYou items={needs} /> : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cards.map((card) =>
          card.kind === "rows" ? (
            <RecordRowsCard key={card.id} title={card.title} rows={card.rows} emptyLabel={card.emptyLabel} dataAttr={`record-overview-card-${card.id}`} />
          ) : (
            <RecordFactCard
              key={card.id}
              title={card.title}
              dataAttr={`record-overview-card-${card.id}`}
              headerActions={
                card.action ? (
                  <button type="button" onClick={card.action.onClick} className="inline-flex items-center gap-1 text-[13px] font-[550] text-primary hover:underline">
                    {card.action.label}
                    <ArrowRight className="size-3.5" aria-hidden />
                  </button>
                ) : undefined
              }
            >
              {card.rows.map((row, index) => (
                <RecordFactRow key={index} label={row.label} value={row.value} tone={row.tone} />
              ))}
            </RecordFactCard>
          ),
        )}
      </div>
    </div>
  );
}

function SectionPad({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-4 sm:px-4">{children}</div>;
}

/** A record page with no section rail (the Tour page, the receipt): the same back chevron, name and line. */
function DemoPlainPage({
  title,
  subtitle,
  backLabel,
  onBack,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  backLabel: string;
  onBack: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PortalTitleActionsProvider>
      <div className="flex min-h-0 flex-col" data-attr="demo-record-page">
        <div className="shrink-0">
          <PortalDetailHeader
            title={title}
            subtitle={subtitle}
            onBack={onBack}
            backLabel={backLabel}
            hideBackText
            bare
            iconTitleActions
            inlineActions
            dataAttrBack="record-detail-back"
            actions={actions}
          />
        </div>
        <div className="min-w-0 px-1 pb-8">{children}</div>
      </div>
    </PortalTitleActionsProvider>
  );
}

/* ───────────────────────────── My home ───────────────────────────── */

export type HomeChecklist = Array<{ label: string; done: boolean }>;

const ChecklistHref: Record<string, string> = {
  "Lease signed": "/resident/lease",
  "Move-in charges paid": "/resident/payments",
  "Move-in inspection photographed": "/resident/move-in/inspections",
};

function DetailField({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-muted">{label}</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/** "Your placement": the assigned room, property and move-in date, then the move-in checklist rows. */
export function ResidentPlacementBody({ checklist }: { checklist: HomeChecklist }) {
  return (
    <div className="min-w-0">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <DetailField label="Assigned room" value={RESIDENT_HOME.room} />
        <DetailField label="Property" value={RESIDENT_HOME.property} sub={RESIDENT_HOME.address} />
        <DetailField label="Move-in date" value={RESIDENT_HOME.moveIn} />
      </div>
      <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-card" data-attr="move-in-checklist">
        {checklist.map((item) => (
          <MoveInChecklistRow key={item.label} label={item.label} status={item.done} href={ChecklistHref[item.label] ?? "#"} />
        ))}
      </div>
    </div>
  );
}

/** "Move-in details": house info, arrival instructions and amenities, the three the real tab stacks. */
export function ResidentMoveInDetailsBody() {
  return (
    <div className="space-y-6">
      <InfoTabContent resolved={DEMO_MOVE_IN_RESOLVED} />
      <InstructionsTabContent resolved={DEMO_MOVE_IN_RESOLVED} />
      <AmenitiesSection resolved={DEMO_MOVE_IN_RESOLVED} />
    </div>
  );
}

const SHARING_KEYS = Object.keys(HOUSEMATE_SHARING_LABELS) as Array<keyof HousemateSharing>;

/** "Roommates": `ResidentHousemateSharing` (What housemates can see) and `HousematesTabContent`. */
export function ResidentRoommatesBody() {
  const [preferences, setPreferences] = useState<HousemateSharing>({ ...DEFAULT_HOUSEMATE_SHARING, shareName: true, shareRoom: true });
  return (
    <>
      <section className="p-4 sm:p-6" data-attr="housemate-sharing-settings">
        <h2 className="text-base font-semibold">What housemates can see</h2>
        <div className={`${PORTAL_DATA_TABLE_WRAP_CARD} mt-4`}>
          <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground sm:px-5">Share with my housemates</h3>
          <table className={PORTAL_DATA_TABLE}>
            <thead>
              <tr className={PORTAL_TABLE_HEAD_ROW}>
                <th className={`${MANAGER_TABLE_TH} text-left`}>Detail</th>
                <th className={`${MANAGER_TABLE_TH} w-24 text-right`}>Share</th>
              </tr>
            </thead>
            <tbody>
              {SHARING_KEYS.map((key) => (
                <tr key={key} className={PORTAL_TABLE_TR}>
                  <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>{HOUSEMATE_SHARING_LABELS[key]}</td>
                  <td className={`${PORTAL_TABLE_TD} text-right`}>
                    <label className="inline-flex items-center justify-end">
                      <span className="sr-only">{HOUSEMATE_SHARING_LABELS[key]}</span>
                      <input
                        type="checkbox"
                        checked={preferences[key]}
                        onChange={(event) => setPreferences((current) => ({ ...current, [key]: event.target.checked }))}
                        data-attr={`housemate-sharing-${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}`}
                        className="h-4 w-4 accent-primary"
                      />
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <HousematesTabContent housemates={DEMO_MOVE_IN_RESOLVED.housemates} />
    </>
  );
}

/** The + on My home › Inspections: a new move-in inspection's record (Overview · Photos · Report). */
export function ResidentInspectionRecord({ onBack, onToast }: { onBack: () => void; onToast: Toast }) {
  return (
    <ResidentRecordShell
      kind="inspection"
      ctx={{ basePath: "/resident" }}
      title="Move-in inspection"
      subtitle={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
      backLabel="Back to inspections"
      onBack={onBack}
      recordId="inspection-new"
      ariaLabel="Inspection sections"
      onToast={onToast}
      onAction={(id) => onToast(`${id === "add-photos" ? "Add photos" : "Download"} (sample)`)}
      renderSection={(id) =>
        id === "photos" ? (
          <SectionPad>
            <PortalListEmptyCard title="No photos yet" workspaceAware={false} dataAttr="resident-inspection-photos-empty" />
          </SectionPad>
        ) : id === "report" ? (
          <SectionPad>
            <PortalListEmptyCard title="No report yet" workspaceAware={false} dataAttr="resident-inspection-report-empty" />
          </SectionPad>
        ) : (
          <Overview
            tiles={[
              { id: "type", label: "Type", value: "Move-in" },
              { id: "status", label: "Status", value: "Upcoming" },
            ]}
            cards={[
              {
                id: "home",
                title: "Home",
                rows: [
                  { label: "Property", value: RESIDENT_HOME.property },
                  { label: "Room", value: RESIDENT_HOME.room },
                ],
              },
            ]}
          />
        )
      }
    />
  );
}

/* ───────────────────────────── Lease ───────────────────────────── */

const LEASE_HTML = `<!doctype html><html><body style="font-family: Georgia, serif; color: #111827; padding: 28px; line-height: 1.55">
<h2 style="margin:0 0 4px">Residential lease agreement</h2>
<p style="margin:0 0 18px; color:#6b7280">${RESIDENT_HOME.property} · ${RESIDENT_HOME.room} · ${RESIDENT_HOME.address}</p>
<p><b>Parties.</b> Seattle Homes (manager) and Jordan Rivera (resident).</p>
<p><b>Term.</b> 12 months beginning ${RESIDENT_HOME.moveIn}.</p>
<p><b>Rent.</b> ${RESIDENT_HOME.rent} per month, due on the 1st of each month.</p>
<p><b>House rules.</b> The house rules your manager shared are part of this agreement.</p>
</body></html>`;

export type DemoLease = { id: string; bucket: "pending" | "signed"; label: string; managerSigned: boolean };

export function ResidentLeaseRecord({
  lease,
  initialSection,
  backLabel = "All leases",
  onBack,
  onToast,
}: {
  lease: DemoLease;
  initialSection?: string;
  backLabel?: string;
  onBack: () => void;
  onToast: Toast;
}) {
  const signed = lease.bucket === "signed";
  const [signing, setSigning] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [youSigned, setYouSigned] = useState(signed);
  const managerSigned = lease.managerSigned;

  const iconAction = (id: string, label: string, icon: LucideIcon, tone?: DemoRecordAction["tone"], onClick?: () => void): DemoRecordAction => ({
    id,
    label,
    icon,
    tone,
    onClick,
  });

  const headerActions = (sectionId: string, registry: DemoRecordAction[]): DemoRecordAction[] => {
    if (sectionId !== "lease-document") return registry;
    if (!signed) {
      return [
        iconAction("download", "Download", Download, undefined, () => onToast("Download (sample)")),
        iconAction("upload", "Upload", Upload, undefined, () => onToast("Upload (sample)")),
        iconAction("report", "Report issue", Flag, undefined, () => setReporting(true)),
        iconAction("send", "Send to manager", Send, undefined, () => onToast("Lease sent to manager (sample)")),
        iconAction("sign", "Sign lease", PenLine, "primary", () => setSigning(true)),
      ];
    }
    return [
      iconAction("renew", "Renew", RefreshCw, undefined, () => setRenewing(true)),
      iconAction("download", "Download", Download, undefined, () => onToast("Download (sample)")),
    ];
  };

  return (
    <>
      <ResidentRecordShell
        kind="lease"
        ctx={{ basePath: "/resident", bucket: lease.bucket }}
        title={RESIDENT_LEASE_LIST_LABEL}
        subtitle={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`}
        backLabel={backLabel}
        onBack={onBack}
        recordId={lease.id}
        ariaLabel="Lease sections"
        initialSection={initialSection}
        headerActions={headerActions}
        onToast={onToast}
        onAction={(id) => {
          if (id === "sign") setSigning(true);
          else onToast("Download (sample)");
        }}
        renderSection={(id, goTo) =>
          id === "lease-document" ? (
            <div className="px-3 pb-6 pt-2 text-left sm:px-4">
              <ResidentLeaseBareDocumentPreview leaseHtml={LEASE_HTML} title={RESIDENT_LEASE_LIST_LABEL} />
            </div>
          ) : id === "payments" ? (
            <SectionPad>
              <PortalListEmptyCard title="No payments linked yet" workspaceAware={false} dataAttr="resident-lease-payments-empty" />
            </SectionPad>
          ) : (
            <Overview
              tiles={[
                { id: "rent", label: "Rent", value: RESIDENT_HOME.rent, detail: "per month" },
                { id: "term", label: "Term", value: "12 months", detail: "Ends Sep 30, 2026" },
                {
                  id: "your-signature",
                  label: "Your signature",
                  value: youSigned ? "Signed" : "Pending",
                  tone: youSigned ? "default" : "danger",
                  detail: managerSigned ? "Manager signed" : undefined,
                },
                { id: "move-in", label: "Move-in", value: RESIDENT_HOME.moveIn },
              ]}
              needs={
                youSigned
                  ? []
                  : [{ id: "sign", title: "Sign your lease", detail: managerSigned ? "Manager signed" : "Awaiting your signature", onClick: () => setSigning(true) }]
              }
              cards={[
                {
                  id: "terms",
                  title: "Terms",
                  action: { label: "Lease document", onClick: () => goTo("lease-document") },
                  rows: [
                    { label: "Property", value: `${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}` },
                    { label: "Rent", value: RESIDENT_HOME.rent },
                  ],
                },
                {
                  id: "signatures",
                  title: "Signatures",
                  action: { label: "Lease document", onClick: () => goTo("lease-document") },
                  rows: [
                    { label: "Manager", value: managerSigned ? "Signed" : "Not signed", tone: managerSigned ? "ok" : "bad" },
                    { label: "You", value: youSigned ? "Signed" : "Pending", tone: youSigned ? "ok" : "bad" },
                  ],
                },
                { kind: "rows", id: "payments", title: "Payments", rows: [], emptyLabel: "No payments linked yet" },
              ]}
            />
          )
        }
      />
      {signing ? (
        <DemoModalScope>
          <SignLeaseModal
            onClose={() => setSigning(false)}
            onSigned={() => {
              setSigning(false);
              setYouSigned(true);
              onToast("Lease signed (sample)");
            }}
          />
        </DemoModalScope>
      ) : null}
      {reporting ? (
        <DemoModalScope>
          <ResidentLeaseReportIssueModal
            open
            onClose={() => setReporting(false)}
            onSubmit={() => {
              setReporting(false);
              onToast("Sent to your manager (sample)");
              return true;
            }}
          />
        </DemoModalScope>
      ) : null}
      {renewing ? (
        <DemoModalScope>
          <RenewLeaseModal
            onClose={() => setRenewing(false)}
            onRenewed={() => {
              setRenewing(false);
              onToast("Renewal requested (sample)");
            }}
          />
        </DemoModalScope>
      ) : null}
    </>
  );
}

/** `LeaseSigningModal`: type your name, the signing time, the e-sign consent, "Sign lease". */
function SignLeaseModal({ onClose, onSigned }: { onClose: () => void; onSigned: () => void }) {
  const [name, setName] = useState(RESIDENT_CONTACT.name);
  const [agreed, setAgreed] = useState(false);
  const now = useMemo(() => new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }), []);
  return (
    <Modal
      open
      presentation="dialog"
      title="Sign lease agreement"
      description={`${RESIDENT_HOME.room} · ${RESIDENT_CONTACT.name}`}
      onClose={onClose}
      panelClassName={MODAL_LARGE_PANEL_CLASS}
      footer={
        <ModalFooter>
          <Button type="button" className="rounded-full" data-attr="lease-sign-confirm" disabled={name.trim().length < 2 || !agreed} onClick={onSigned}>
            Sign lease
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-muted">Your full legal name</label>
          <p className="mt-0.5 text-xs text-muted">Type exactly as it should appear on the signed document.</p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-attr="lease-sign-name"
            className="mt-2 w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20"
          />
          {name.trim().length >= 2 ? (
            <p className="mt-2 text-center text-xl text-foreground" style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontStyle: "italic" }}>
              {name}
            </p>
          ) : null}
        </div>
        <div className="rounded-xl border border-border bg-accent/30 px-4 py-3 text-xs text-muted">
          <p className="font-semibold text-muted">Signing date & time</p>
          <p className="mt-0.5">{now}</p>
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm text-muted shadow-sm">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            data-attr="lease-sign-agree"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-primary"
          />
          <span>{LEASE_ESIGN_CONSENT_TEXT}</span>
        </label>
      </div>
    </Modal>
  );
}

/** `LeaseAmendMoveOutModal` with the renewal flow: term, start, rent. */
function RenewLeaseModal({ onClose, onRenewed }: { onClose: () => void; onRenewed: () => void }) {
  const [term, setTerm] = useState("12 months");
  const [starts, setStarts] = useState("2026-10-01");
  const [rent, setRent] = useState("1080");
  return (
    <Modal
      open
      presentation="dialog"
      title="Renew or extend lease"
      onClose={onClose}
      panelClassName="max-w-lg"
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" onClick={onRenewed}>
            Renew lease
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <FieldSingleSelect
          label="Renewal term"
          value={term}
          onChange={setTerm}
          options={["6 months", "12 months", "24 months"].map((value) => ({ value, label: value }))}
        />
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Renewal starts</span>
          <Input type="date" className="portal-modal-date-input mt-1.5" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </label>
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Rent</span>
          <Input inputMode="decimal" className="mt-1.5" value={rent} onChange={(e) => setRent(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── Forms: the one-question-per-screen flow ───────────────────────────── */

function FlowHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to forms"
        data-attr="resident-move-in-form-close"
        className="-ml-2 grid size-11 place-items-center rounded-full text-foreground transition-colors duration-(--motion-fast) hover:bg-accent"
      >
        <ArrowLeft className="size-5" aria-hidden />
      </button>
      <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h2>
    </div>
  );
}

/**
 * `ResidentMoveInFormFlow`: progress, the current question (the real `MoveInFormQuestionField`), Back / Next, the last
 * step "Submit", "Saved as you go". A completed form opens read-only with a Download button. Nothing is stored.
 */
export function ResidentFormFlow({
  form,
  onBack,
  onSubmitted,
  onToast,
}: {
  form: ResidentFormFixture;
  onBack: () => void;
  onSubmitted: () => void;
  onToast: Toast;
}) {
  const spec = RESIDENT_FORM_QUESTIONS[form.id] ?? RESIDENT_FORM_QUESTIONS["form-movein"]!;
  const questions = spec.questions;
  const readOnly = form.bucket === "completed";
  const [answers, setAnswers] = useState<MoveInAnswerMap>(() => {
    if (!readOnly || !spec.answers) return {};
    const out: MoveInAnswerMap = {};
    for (const question of questions) {
      const raw = spec.answers[question.key];
      if (!raw) continue;
      out[question.key] =
        question.type === "signature"
          ? { key: question.key, signature: { storagePath: "preview:signature", signedName: raw, signedAt: new Date().toISOString() } }
          : (fieldStringToAnswer(question, raw) ?? { key: question.key, value: raw });
    }
    return out;
  });
  const [index, setIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const visible = useMemo(() => visibleMoveInQuestions(questions, answers), [questions, answers]);
  const current = visible[Math.min(index, visible.length - 1)];
  const isLast = index >= visible.length - 1;

  const setAnswer = (key: string, answer: MoveInAnswerMap[string] | null) => {
    setAnswers((prev) => {
      const next = { ...prev };
      if (answer) next[key] = answer;
      else delete next[key];
      return next;
    });
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const check = (): boolean => {
    if (!current) return true;
    if (current.required && !isMoveInQuestionAnswered(current, answers[current.key])) {
      setErrors((prev) => ({ ...prev, [current.key]: requiredMessage(current) }));
      return false;
    }
    const problem = answerFormatProblem(current, answers[current.key]);
    if (problem) {
      setErrors((prev) => ({ ...prev, [current.key]: problem }));
      return false;
    }
    return true;
  };

  if (done) {
    return (
      <div className="grid place-items-center py-16" data-attr="resident-move-in-form-done" role="status">
        <div className="grid place-items-center gap-3 text-center">
          <span className="grid size-16 place-items-center rounded-full bg-primary text-white shadow-md">
            <CheckDraw className="size-8" />
          </span>
          <p className="text-base font-semibold text-foreground">Submitted</p>
        </div>
      </div>
    );
  }

  if (readOnly) {
    return (
      <div data-attr="resident-move-in-form-readonly">
        <FlowHeader title={form.title} onBack={onBack} />
        <div className="space-y-5 rounded-2xl border border-border bg-card p-4">
          {visible.map((question) => (
            <MoveInFormQuestionField key={question.key} question={question} answer={answers[question.key]} onChange={() => {}} readOnly />
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="outline" className="rounded-full" onClick={() => onToast("Download (sample)")} data-attr="resident-move-in-form-download">
            <Download className="size-4" aria-hidden />
            Download
          </Button>
        </div>
      </div>
    );
  }

  const total = Math.max(visible.length, 1);
  const primaryLabel = isLast ? "Submit" : "Next";

  return (
    <div data-attr="resident-move-in-form-flow">
      <FlowHeader title={form.title} onBack={onBack} />
      <div className="mx-auto w-full max-w-xl space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{current?.section ?? "Questions"}</span>
            <span>{`${index + 1} of ${total}`}</span>
          </div>
          <MoveInProgressBar ratio={(index + 1) / total} label="Form progress" />
        </div>
        <div key={current?.key ?? "none"} className="space-y-4 rounded-2xl border border-border bg-card p-4">
          {current ? (
            <MoveInFormQuestionField
              question={current}
              answer={answers[current.key]}
              onChange={(answer) => setAnswer(current.key, answer)}
              error={errors[current.key]}
              signerName={RESIDENT_CONTACT.name}
            />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 rounded-full px-5"
            disabled={index === 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            data-attr="resident-move-in-form-back"
          >
            Back
          </Button>
          <Button
            type="button"
            variant="primary"
            className="min-h-11 flex-1 rounded-full sm:flex-none sm:px-8"
            onClick={() => {
              if (!check()) return;
              if (!isLast) {
                setIndex((i) => i + 1);
                return;
              }
              setDone(true);
              window.setTimeout(onSubmitted, 900);
            }}
            data-attr="resident-move-in-form-next"
          >
            {primaryLabel}
          </Button>
        </div>
        <p className="text-center text-xs text-muted" aria-live="polite">
          Saved as you go
        </p>
      </div>
    </div>
  );
}

/* ───────────────────────────── Services ───────────────────────────── */

/** `ResidentAddServiceModal`: "Report a problem", the real intake fields, footer "Send". */
export function ResidentAddServiceModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const catalogOffers = useMemo(() => mergeResidentServiceCatalogOffers([]), []);
  const intakeOptions = useMemo(() => buildServiceIntakeOptions(catalogOffers), [catalogOffers]);
  const [form, setForm] = useState<ServiceIntakeFormState>(() => {
    const repair = intakeOptions.find((option) => option.kind === "repair");
    return {
      ...createEmptyServiceIntakeFormState(intakeOptions),
      ...(repair ? { optionKey: repair.key, categoryLabel: repair.categoryLabel ?? "General" } : {}),
      description: DEMO_SERVICE_DETAIL.description,
    };
  });
  return (
    <DemoModalScope>
      <Modal
        open
        presentation="dialog"
        title="Report a problem"
        onClose={onClose}
        panelClassName="max-w-lg"
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" data-attr="resident-service-intake-submit" onClick={onSent}>
              Send
            </Button>
          </ModalFooter>
        }
      >
        <div className="mt-4">
          <ServiceIntakeFormFields
            catalogOffers={catalogOffers}
            form={form}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            compactRepairReport
            photoSlot={<ServiceIntakePhotoPicker onPick={() => undefined} photoCount={0} />}
          />
        </div>
      </Modal>
    </DemoModalScope>
  );
}

/** The confirmation every destructive resident gesture shares (`ConfirmDeleteModal`). */
export function ResidentConfirmModal({
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <DemoModalScope>
      <ConfirmDeleteModal open title={title} description={description} confirmLabel={confirmLabel} onClose={onClose} onConfirm={onConfirm} />
    </DemoModalScope>
  );
}

export type DemoService = { id: string; title: string; property: string; state: "open" | "scheduled" | "done" | "declined"; detail: string };

const SERVICE_LABEL = "text-xs font-medium uppercase tracking-wide text-muted";

export function ResidentServiceRecord({
  service,
  onBack,
  onToast,
  onDeleted,
}: {
  service: DemoService;
  onBack: () => void;
  onToast: Toast;
  onDeleted: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const assigned = service.state === "scheduled" || service.state === "done";
  return (
    <>
      <ResidentRecordShell
        kind="service"
        ctx={{ basePath: "/resident" }}
        title={service.title}
        subtitle={service.detail}
        backLabel="Back to services"
        onBack={onBack}
        recordId={service.id}
        ariaLabel="Service sections"
        extraItem={assigned ? { id: "vendor", label: "Vendor" } : undefined}
        onToast={onToast}
        onAction={(id) => {
          if (id === "cancel") setCancelling(true);
          else onToast(id === "edit" ? "Edit service (sample)" : "Message manager (sample)");
        }}
        renderSection={(id) =>
          id === "updates" ? (
            <SectionPad>
              <PortalListEmptyCard title="No updates yet" workspaceAware={false} dataAttr="resident-service-updates-empty" />
            </SectionPad>
          ) : id === "photos" ? (
            <SectionPad>
              <PortalListEmptyCard title="No photos yet" workspaceAware={false} dataAttr="resident-service-photos-empty" />
            </SectionPad>
          ) : id === "vendor" ? (
            <SectionPad>
              <p className={SERVICE_LABEL}>Vendor</p>
              <p className="mt-1 text-sm font-medium text-foreground">{DEMO_SERVICE_DETAIL.vendor}</p>
              <p className={`mt-3 ${SERVICE_LABEL}`}>Assigned</p>
              <p className="mt-1 text-sm text-foreground">{DEMO_SERVICE_DETAIL.vendorAssigned}</p>
            </SectionPad>
          ) : (
            <SectionPad>
              <div data-attr="resident-service-overview">
                <p className={SERVICE_LABEL}>Priority</p>
                <p className="mt-1 text-sm font-medium text-foreground">{DEMO_SERVICE_DETAIL.priority}</p>
                <p className={`mt-3 ${SERVICE_LABEL}`}>Preferred arrival</p>
                <p className="mt-1 text-sm font-medium text-foreground">{DEMO_SERVICE_DETAIL.preferredArrival}</p>
                <p className={`mt-3 ${SERVICE_LABEL}`}>Entry</p>
                <p className="mt-1 text-sm font-medium text-foreground">{DEMO_SERVICE_DETAIL.entry}</p>
                <p className={`mt-3 ${SERVICE_LABEL}`}>Details</p>
                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">{DEMO_SERVICE_DETAIL.description}</p>
                {service.state === "scheduled" ? (
                  <>
                    <p className={`mt-3 ${SERVICE_LABEL}`}>Visit</p>
                    <p className="mt-1 text-sm font-medium text-foreground">{service.detail}</p>
                  </>
                ) : null}
              </div>
            </SectionPad>
          )
        }
      />
      {cancelling ? (
        <ResidentConfirmModal
          title="Cancel service"
          description={`Cancel "${service.title}"?`}
          confirmLabel="Cancel service"
          onClose={() => setCancelling(false)}
          onConfirm={() => {
            setCancelling(false);
            onDeleted();
          }}
        />
      ) : null}
    </>
  );
}

/* ───────────────────────────── Tour ───────────────────────────── */

export function ResidentScheduleTour(props: { onClose: () => void; onScheduled: () => void; initialPropertyId?: string | null }) {
  return (
    <DemoModalScope>
      <TourModal {...props} />
    </DemoModalScope>
  );
}

export type DemoTour = { id: string; property: string; place: string; when: string; bucket: "scheduled" | "approved" | "past" };

const TOUR_TABS = [
  { id: "details", label: "Tour details" },
  { id: "updates", label: "Updates" },
] as const;

function TourField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}

/** The Tour page: no rail, local tabs "Tour details" and "Updates", Reschedule · Message host · Cancel tour. */
export function ResidentTourRecord({
  tour,
  onBack,
  onToast,
  onReschedule,
  onCancelled,
}: {
  tour: DemoTour;
  onBack: () => void;
  onToast: Toast;
  onReschedule: () => void;
  onCancelled: () => void;
}) {
  const [tab, setTab] = useState<(typeof TOUR_TABS)[number]["id"]>("details");
  const [cancelling, setCancelling] = useState(false);
  const over = tour.bucket === "past";
  const confirmed = tour.bucket === "approved";
  return (
    <>
      <DemoPlainPage title={tour.property} subtitle={tour.when} backLabel="Back to tours" onBack={onBack}>
        <div className="space-y-5 px-1 pb-8">
          {confirmed ? (
            <div className="rounded-2xl border px-4 py-4 text-sm portal-banner-success">
              <p className="font-semibold text-foreground">Tour confirmed</p>
              <p className="mt-1.5 text-muted">
                {`Your tour at ${tour.property} is confirmed for `}
                <span className="font-medium text-foreground">{tour.when}</span>
                {". Check Communication for any last-minute updates from your property manager."}
              </p>
            </div>
          ) : null}
          <PortalListControlStack
            destinationRow={
              <LocalDestinationNav
                items={TOUR_TABS.map((item) => ({ id: item.id, label: item.label }))}
                activeId={tab}
                onChange={(id) => setTab(id as (typeof TOUR_TABS)[number]["id"])}
                ariaLabel="Tour detail sections"
              />
            }
          />
          {tab === "details" ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-border bg-accent/25 px-4 py-4 text-sm">
                <p className="font-semibold text-foreground">{tour.when}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TourField label="Property" value={tour.property} />
                <TourField label="Room" value={tour.place.split(" · ")[0] ?? tour.place} />
                <TourField label="Format" value="In person" />
                <TourField label="Host" value={tour.place.split(" · ")[1] ?? "Host Manager"} />
                <TourField label="Name" value={RESIDENT_CONTACT.name} />
                <TourField label="Email" value={RESIDENT_CONTACT.email} />
                <TourField label="Phone" value={RESIDENT_CONTACT.phone} />
              </div>
              <PortalSectionActionRow variant="header">
                {!over ? (
                  <Button type="button" variant="primary" className="rounded-full" data-attr="resident-tour-reschedule" onClick={onReschedule}>
                    Reschedule
                  </Button>
                ) : null}
                <Button type="button" variant="outline" className="rounded-full" data-attr="resident-tour-message-manager" onClick={() => onToast("Message host (sample)")}>
                  Message host
                </Button>
                {!over ? (
                  <Button type="button" variant="outline" className="rounded-full portal-danger-outline text-rose-800" data-attr="resident-tour-cancel" onClick={() => setCancelling(true)}>
                    Cancel tour
                  </Button>
                ) : null}
              </PortalSectionActionRow>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-border bg-card px-4 py-4 text-sm shadow-[var(--shadow-sm)]">
                <p className="font-semibold text-foreground">What happens next</p>
                <ul className="mt-3 list-disc space-y-2 pl-5 text-muted">
                  {DEMO_TOUR_UPDATES.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </DemoPlainPage>
      {cancelling ? (
        <ResidentConfirmModal
          title="Cancel tour"
          description={`Cancel your tour at ${tour.property}?`}
          confirmLabel="Cancel tour"
          onClose={() => setCancelling(false)}
          onConfirm={() => {
            setCancelling(false);
            onCancelled();
          }}
        />
      ) : null}
    </>
  );
}

/* ───────────────────────────── Applications ───────────────────────────── */

/** `propertyPickerModal`: "Apply to a property", footer "Browse homes" + "Start application". */
export function ResidentApplyModal({ onClose, onBrowse, onStart }: { onClose: () => void; onBrowse: () => void; onStart: (propertyId: string) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <DemoModalScope>
      <Modal
        open
        presentation="dialog"
        title="Apply to a property"
        onClose={onClose}
        panelClassName="max-w-lg"
        footer={
          <div className="flex flex-col gap-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="outline" className="rounded-full px-4 text-[13px]" data-attr="resident-applications-browse-homes" onClick={onBrowse}>
                Browse homes
              </Button>
              <Button type="button" variant="primary" className="rounded-full" data-attr="resident-applications-start" disabled={!picked} onClick={() => picked && onStart(picked)}>
                Start application
              </Button>
            </div>
          </div>
        }
      >
        <PropertySearchPicker
          options={DEMO_HOME_OPTIONS}
          value={picked}
          onChange={setPicked}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No properties are available to apply for right now."
          ariaLabel="Search properties to apply for"
        />
      </Modal>
    </DemoModalScope>
  );
}

/** `withdrawModal`: the real copy, "Keep application" and "Withdraw application". */
export function ResidentWithdrawModal({ property, onClose, onWithdrawn }: { property: string; onClose: () => void; onWithdrawn: () => void }) {
  return (
    <DemoModalScope>
      <Modal open presentation="dialog" title="Withdraw application" onClose={onClose} panelClassName="max-w-md">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {`Withdrawing removes this application from your list. Your property manager keeps the record for ${property} and its history. Withdrawal is final for this application: applying to the same home again starts a brand-new application.`}
          </p>
          <div className="flex justify-start gap-2">
            <Button type="button" variant="outline" className="rounded-full" onClick={onClose}>
              Keep application
            </Button>
            <Button type="button" variant="danger" className="rounded-full" data-attr="resident-application-withdraw-confirm" onClick={onWithdrawn}>
              Withdraw application
            </Button>
          </div>
        </div>
      </Modal>
    </DemoModalScope>
  );
}

export type DemoApplication = { id: string; property: string; unit: string; submitted: string; stage: string; bucket: "incomplete" | "pending" | "approved" | "rejected" };

/** The application page: Overview · Application form · Communication, with Continue / Edit and Withdraw in the header. */
export function ResidentApplicationRecord({
  application,
  title,
  backLabel = "Back to applications",
  onBack,
  onToast,
  onWithdrawn,
}: {
  application: DemoApplication;
  /** The documents page opens the same record as "Rental application". */
  title?: string;
  backLabel?: string;
  onBack: () => void;
  onToast: Toast;
  onWithdrawn: () => void;
}) {
  const [withdrawing, setWithdrawing] = useState(false);
  const inProgress = application.bucket === "incomplete";
  const pending = application.bucket === "pending";
  const status = application.bucket === "approved" ? "Approved" : application.bucket === "rejected" ? "Declined" : "Pending";
  const headerActions = (): DemoRecordAction[] => [
    ...(inProgress
      ? [{ id: "continue", label: "Continue application", icon: ArrowRight, tone: "primary" as const, onClick: () => onToast("Continue application (sample)") }]
      : pending
        ? [{ id: "edit", label: "Edit application", icon: Pencil, tone: "primary" as const, onClick: () => onToast("Edit application (sample)") }]
        : []),
    ...(inProgress || pending ? [{ id: "withdraw", label: "Withdraw", icon: Undo2, tone: "danger" as const, onClick: () => setWithdrawing(true) }] : []),
  ];
  return (
    <>
      <ResidentRecordShell
        kind="application"
        ctx={{ basePath: "/resident", bucket: application.bucket }}
        title={title ?? application.property}
        subtitle={RESIDENT_CONTACT.email}
        backLabel={backLabel}
        onBack={onBack}
        recordId={application.id}
        ariaLabel="Application sections"
        headerActions={headerActions}
        onToast={onToast}
        onAction={() => undefined}
        renderSection={(id, goTo) =>
          id === "application-form" ? (
            <SectionPad>
              <div className="space-y-3" data-attr="resident-application-form-readonly">
                <RecordFactCard title="About you">
                  <RecordFactRow label="Name" value={RESIDENT_CONTACT.name} />
                  <RecordFactRow label="Email" value={RESIDENT_CONTACT.email} />
                  <RecordFactRow label="Phone" value={RESIDENT_CONTACT.phone} />
                </RecordFactCard>
                <RecordFactCard title="Housing">
                  <RecordFactRow label="Home" value={application.property} />
                  <RecordFactRow label="Room" value={application.unit} />
                  <RecordFactRow label="Move-in" value={RESIDENT_HOME.moveIn} />
                  <RecordFactRow label="Lease term" value="12 months" />
                </RecordFactCard>
              </div>
            </SectionPad>
          ) : (
            <Overview
              tiles={[
                { id: "status", label: "Status", value: status, tone: application.bucket === "rejected" ? "danger" : "default" },
                { id: "home", label: "Home", value: application.property },
              ]}
              needs={[]}
              cards={[
                {
                  id: "application-form",
                  title: "Application form",
                  action: { label: "Read what you sent", onClick: () => goTo("application-form") },
                  rows: [
                    { label: "Applicant", value: RESIDENT_CONTACT.name },
                    { label: "Email", value: RESIDENT_CONTACT.email },
                    { label: "Application fee", value: "Paid" },
                  ],
                },
              ]}
            />
          )
        }
      />
      {withdrawing ? (
        <ResidentWithdrawModal
          property={application.property}
          onClose={() => setWithdrawing(false)}
          onWithdrawn={() => {
            setWithdrawing(false);
            onWithdrawn();
          }}
        />
      ) : null}
    </>
  );
}

/* ───────────────────────────── Payments ───────────────────────────── */

export type DemoCharge = { id: string; chargeTitle: string; property: string; due: string; amount: string; bucket: "pending" | "overdue" | "paid" };

/** `Pay charges`: the amount due, the method picker (Bank (ACH) · Card · Apple Pay) and "Continue with <method>". */
export function ResidentPayModal({
  charges,
  onClose,
  onContinue,
}: {
  charges: Array<{ title: string; amount: string }>;
  onClose: () => void;
  onContinue: (methodLabel: string) => void;
}) {
  const [method, setMethod] = useState<"ach" | "card">("ach");
  const cents = charges.reduce((sum, charge) => sum + Math.round(Number(charge.amount.replace(/[$,]/g, "")) * 100), 0);
  const total = `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const options: Array<{ id: "ach" | "card"; title: string }> = [
    { id: "ach", title: "Bank (ACH)" },
    { id: "card", title: RESIDENT_CARD_PAYMENT_DISPLAY_LABEL },
  ];
  return (
    <DemoModalScope>
      <Modal
        open
        presentation="dialog"
        title="Pay charges"
        onClose={onClose}
        contextPanel={<PopupRecordPreview rows={[{ label: "Selected charges", value: charges.length }]} />}
        previewLabel="Payment preview"
        preview={
          <PopupRecordPreview
            rows={[...charges.map((charge, i) => ({ label: `${i + 1}. ${charge.title}`, value: charge.amount })), { label: "Amount due", value: total }]}
          />
        }
        scrollableContent
        panelClassName="max-w-lg"
      >
        <div className="flex min-h-[min(50vh,20rem)] flex-col gap-4">
          <div className="space-y-1 text-center">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Amount due</p>
            <p className="text-3xl font-bold tabular-nums tracking-tight text-foreground">{total}</p>
            <p className="text-xs text-muted">Processing fee: None</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {options.map((option) => {
              const selected = method === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  data-attr={`resident-payments-method-${option.id}`}
                  onClick={() => setMethod(option.id)}
                  className={`flex min-h-[64px] flex-col justify-center rounded-xl border px-3 py-3 text-left transition active:scale-[0.99] ${
                    selected ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "border-border bg-card hover:border-primary/30"
                  }`}
                >
                  <p className="text-sm font-semibold text-foreground">{option.title}</p>
                  {option.id === "card" ? <p className="mt-0.5 text-[11px] font-medium text-primary">Apple Pay · Google Pay</p> : null}
                  <p className="mt-1 text-xs text-muted">{residentProcessingFeeDisplayLabel(option.id)}</p>
                </button>
              );
            })}
          </div>
          <Button type="button" variant="primary" data-attr="resident-payments-continue" onClick={() => onContinue(residentPaymentMethodLabel(method))}>
            {`Continue with ${residentPaymentMethodLabel(method)}`}
          </Button>
        </div>
      </Modal>
    </DemoModalScope>
  );
}

export function ResidentPaymentRecord({
  payment,
  onBack,
  onToast,
  onPay,
}: {
  payment: DemoCharge;
  onBack: () => void;
  onToast: Toast;
  onPay: () => void;
}) {
  const unpaid = payment.bucket !== "paid";
  const status = payment.bucket === "paid" ? "Paid" : payment.bucket === "overdue" ? "Overdue" : "Pending";
  const headerActions = (sectionId: string, registry: DemoRecordAction[]): DemoRecordAction[] =>
    sectionId === "communication"
      ? registry
      : unpaid
        ? registry.map((action) => (action.id === "pay" ? { ...action, label: `Pay ${payment.amount}`, onClick: onPay } : action))
        : [];
  return (
    <ResidentRecordShell
      kind="payment"
      ctx={{ basePath: "/resident", bucket: payment.bucket }}
      title={payment.chargeTitle}
      subtitle={`${payment.property} · ${payment.due}`}
      backLabel="Back to payments"
      onBack={onBack}
      recordId={payment.id}
      ariaLabel="Payment sections"
      headerActions={headerActions}
      onToast={onToast}
      onAction={(id) => id === "pay" && onPay()}
      renderSection={() => (
        <Overview
          tiles={[
            { id: "amount", label: "Amount", value: payment.amount },
            { id: "due", label: "Due", value: payment.due, tone: payment.bucket === "overdue" ? "danger" : "default" },
            { id: "status", label: "Status", value: status },
            { id: "balance", label: "Balance", value: unpaid ? payment.amount : "$0.00" },
          ]}
          needs={unpaid ? [{ id: "pay", title: "Pay this charge", detail: "Card or bank — fee shown before you confirm", onClick: onPay }] : []}
          cards={[
            {
              id: "charge",
              title: "Charge",
              rows: [
                { label: "Type", value: payment.chargeTitle },
                { label: "Property", value: payment.property },
              ],
            },
            { id: "manager", title: "Manager", rows: [{ label: "Name", value: PROPERTY_MANAGER.name }] },
          ]}
        />
      )}
    />
  );
}

/* ───────────────────────────── Documents ───────────────────────────── */

/** `ResidentAddDocumentModal`: "Add to documents", Choose file · Take photo, "Name (optional)", footer "Save". */
export function ResidentAddDocumentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  return (
    <DemoModalScope>
      <Modal
        open
        presentation="dialog"
        title="Add to documents"
        onClose={onClose}
        footer={
          <ModalFooter>
            <Button type="button" variant="primary" className="rounded-full" onClick={onSaved} disabled={!file}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted">
            Upload a photo, PDF, or file you want to keep with your housing records. It appears in the Other documents tab.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="relative inline-flex">
              <input
                type="file"
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Choose file"
                onChange={(e) => setFile(e.target.files?.[0]?.name ?? null)}
              />
              <span className="inline-flex h-10 items-center rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground">
                {file ? "Choose a different file" : "Choose file"}
              </span>
            </label>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => setFile("photo.jpg")}>
              Take photo
            </Button>
            {file ? <p className="min-w-0 truncate text-sm text-muted">{file}</p> : null}
          </div>
          <label className="block">
            <span className={MODAL_FIELD_LABEL_CLASS}>Name (optional)</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Renter's insurance policy"
              className="mt-1.5 h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary/25"
            />
          </label>
        </div>
      </Modal>
    </DemoModalScope>
  );
}

/** A rent receipt's page: no rail, the amount and when it was paid, Download in the header. */
export function ResidentReceiptRecord({ onBack, onToast }: { onBack: () => void; onToast: Toast }) {
  return (
    <DemoPlainPage
      title="Rent receipt"
      subtitle={`${DEMO_RECEIPT.title} · ${DEMO_RECEIPT.date}`}
      backLabel="Back to documents"
      onBack={onBack}
      actions={
        <Button type="button" variant="outline" className="rounded-full" data-attr="resident-receipt-download" onClick={() => onToast("Download receipt (sample)")}>
          <Download className="size-4" aria-hidden />
          Download receipt
        </Button>
      }
    >
      <div className="px-3 sm:px-4">
        <RecordFactCard title="Receipt">
          <RecordFactRow label="Charge" value={DEMO_RECEIPT.title} />
          <RecordFactRow label="Property" value={`${RESIDENT_HOME.property} · ${RESIDENT_HOME.room}`} />
          <RecordFactRow label="Amount paid" value={DEMO_RECEIPT.amount} />
          <RecordFactRow label="Paid on" value={DEMO_RECEIPT.date} />
          <RecordFactRow label="Method" value={DEMO_RECEIPT.method} />
          <RecordFactRow label="Reference" value={DEMO_RECEIPT.reference} />
        </RecordFactCard>
      </div>
    </DemoPlainPage>
  );
}

/* ───────────────────────────── Communication ───────────────────────────── */

const COMPOSE_DRAFT = {
  subject: "Question about move-in",
  body: "Hi, could you confirm what time the keys are ready on move-in day?",
  recipientEmail: PROPERTY_MANAGER.email,
  managerUserId: "demo",
};

/**
 * The real resident compose: the shared `ManagerCommunicationComposeModal` (portal="resident") with the manager picked. The draft
 * arrives a tick after the modal mounts: the modal picks its recipient in an effect that its own "drop unknown
 * keys" effect would undo if both ran in the first commit.
 */
export function ResidentComposeModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [draft, setDraft] = useState<typeof COMPOSE_DRAFT | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setDraft(COMPOSE_DRAFT), 0);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <DemoModalScope>
      <ManagerCommunicationComposeModal
        open
        portal="resident"
        onClose={onClose}
        onSend={() => {
          onSent();
        }}
        senderName={RESIDENT_CONTACT.name}
        senderEmail={RESIDENT_CONTACT.email}
        liveContacts={DEMO_COMPOSE_CONTACTS}
        residentDraft={draft}
      />
    </DemoModalScope>
  );
}
