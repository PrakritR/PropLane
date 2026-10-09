"use client";

/**
 * A record page for the home demo: what the real portal opens when a list row is clicked.
 *
 * In the real portal almost every row navigates to a full record page (`PortalRecordDetailPage` +
 * `PortalRecordSectionChrome`): a header with a back chevron, the record's name and one line under it,
 * the record's icon actions at the right (one filled, a red delete last), a rail of sections on the
 * left (`recordSections(role, kind)` in `src/lib/portals/record-sections.ts`: the record's own sections,
 * then Communication / Documents / Activity), and the section's body, drawn from `RecordFactCard` /
 * `RecordFactRow` fact cards. The pages themselves fetch their record, so the demo cannot mount them;
 * this draws the SAME header, rail and cards from the same exported pieces, and the panel fills the
 * sections with fixture facts. Section names come from the registry, never typed here.
 *
 * The panel swaps its list for this and back: `onBack` is the back chevron. Nothing saves.
 */

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { PortalDetailHeader } from "@/components/portal/portal-list-detail-shell";
import { PortalTitleActionsProvider } from "@/components/portal/portal-title-actions-slot";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { portalLabeledPrimarySpec } from "@/components/portal/portal-icon-action-spec";
import { RecordTabBand } from "@/components/portal/record-list-band";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { InboxComposer, InboxThreadView, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { SERVICE_PARTY_LABEL } from "@/lib/service-communication-scope";
import type { RecordSections } from "@/lib/portals/record-sections";
import type { LucideIcon } from "lucide-react";

export { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";

export type DemoRecordAction = {
  id: string;
  label: string;
  icon: LucideIcon;
  tone?: "default" | "primary" | "danger";
  onClick?: () => void;
  /** `data-demo-target` for the hero's cursor (`sheet-primary` on the control the story clicks). */
  demoTarget?: string;
  /** The ONE labeled primary of a service header (the next step): the word on a filled button, last in the row. */
  labeled?: boolean;
  /** Held in the ⋯ instead of the row (an add-on's Decline request). */
  inMenu?: boolean;
};

/** A registry's header icons, ready to draw: the first is the filled primary unless `primaryId` says otherwise. */
export function recordActionsFromSections(sections: RecordSections, onAction?: (id: string) => void, primaryId?: string): DemoRecordAction[] {
  return sections.headerActions.map((action, index) => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    tone: primaryId ? (action.id === primaryId ? "primary" : action.tone) : index === 0 && action.tone !== "danger" ? "primary" : action.tone,
    onClick: () => onAction?.(action.id),
  }));
}

export function DemoRecordPage({
  title,
  subtitle,
  avatarName,
  backLabel,
  onBack,
  actions,
  sections,
  recordId,
  activeId,
  onActive,
  ariaLabel,
  children,
}: {
  title: string;
  subtitle?: string;
  avatarName?: string;
  /** The back chevron's name ("Back to tours"). */
  backLabel: string;
  onBack: () => void;
  actions: DemoRecordAction[];
  /** `recordSections(role, kind, ctx)`: the rail and the header's default icons. */
  sections: RecordSections;
  recordId: string;
  activeId: string;
  onActive: (id: string) => void;
  /** The rail's accessible name ("Tour sections"). */
  ariaLabel: string;
  /** The active section's body. */
  children: ReactNode;
}) {
  // The registry's hrefs are real routes; in the demo a rail row only switches section.
  const inert = useMemo<RecordSections>(
    () => ({
      ...sections,
      groups: sections.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item, href: () => "#" })) })),
    }),
    [sections],
  );
  const labelToId = useMemo(() => new Map(sections.groups.flatMap((g) => g.items.map((i) => [i.label, i.id] as const))), [sections]);
  const menuItemFor = (action: DemoRecordAction) => (
    <DropdownMenuItem className={action.tone === "danger" ? "text-red-600" : undefined} data-attr={`record-header-action-${action.id}`} onSelect={() => action.onClick?.()}>
      {action.label}
    </DropdownMenuItem>
  );
  const specs = actions
    .filter((action) => !action.inMenu)
    .map((action) =>
      action.labeled
        ? portalLabeledPrimarySpec({
            id: action.id,
            label: action.label,
            dataAttr: `record-header-action-${action.id}`,
            demoTarget: action.demoTarget,
            onClick: () => action.onClick?.(),
          })
        : {
            id: action.id,
            tone: action.tone,
            node: (
              <PortalIconAction
                ring
                ringPrimary={action.tone === "primary"}
                tone={action.tone}
                icon={action.icon}
                label={action.label}
                data-attr={`record-header-action-${action.id}`}
                data-demo-target={action.demoTarget}
                onClick={() => action.onClick?.()}
              />
            ),
            menuItem: menuItemFor(action),
          },
    );
  const menuActions = actions.filter((action) => action.inMenu);
  if (menuActions.length > 0) {
    const items = <>{menuActions.map((action) => <Fragment key={action.id}>{menuItemFor(action)}</Fragment>)}</>;
    const more = {
      id: "more",
      node: (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <PortalIconAction ring icon={MoreHorizontal} label="More" data-attr="record-header-action-more" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="record-action-menu">
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
      menuItem: items,
    };
    // The ⋯ sits before the labeled primary, which stays last.
    const primaryAt = specs.findIndex((spec) => "tone" in spec && spec.tone === "primary" && actions.find((a) => a.id === spec.id)?.labeled);
    if (primaryAt >= 0) specs.splice(primaryAt, 0, more);
    else specs.push(more);
  }
  return (
    <PortalTitleActionsProvider>
      <div
        className="flex min-h-0 flex-col"
        data-attr="demo-record-page"
        onClickCapture={(event) => {
          const anchor = (event.target as Element | null)?.closest?.("nav a");
          if (!anchor) return;
          event.preventDefault();
          const id = labelToId.get(anchor.textContent?.trim() ?? "");
          if (id) onActive(id);
        }}
      >
        <div className="shrink-0">
          <PortalDetailHeader
            title={title}
            subtitle={subtitle}
            avatarName={avatarName}
            onBack={onBack}
            backLabel={backLabel}
            hideBackText
            bare
            iconTitleActions
            dataAttrBack="record-detail-back"
            actions={
              <div className="flex min-w-0 flex-1" data-attr="record-header-icons">
                <PortalAdaptiveActionRow actions={specs} align="end" gapPx={6} />
              </div>
            }
          />
        </div>
        <PortalRecordSectionChrome
          sections={inert}
          recordId={recordId}
          activeId={activeId}
          title={title}
          subtitle={subtitle}
          backHref="#"
          backLabel="Back"
          ariaLabel={ariaLabel}
        >
          {children}
        </PortalRecordSectionChrome>
      </div>
    </PortalTitleActionsProvider>
  );
}

/**
 * A record's Communication section: the conversation with the record's contact, in the real thread view
 * with its composer. Sending only appends locally.
 */
export function DemoRecordThread({
  name,
  subtitle,
  messages,
  selfName,
  onSent,
}: {
  name: string;
  subtitle?: string;
  messages: { id: string; author: string; body: string; at: string; direction: "inbound" | "outbound" }[];
  selfName: string;
  onSent?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<typeof messages>([]);
  return (
    <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card" data-attr="demo-record-communication">
      <InboxThreadView
        title={name}
        subtitle={subtitle}
        avatarName={name}
        messages={[...messages, ...sent]}
        composer={
          <InboxComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => {
              if (!draft.trim()) return;
              setSent((m) => [...m, { id: `local-${m.length + 1}`, author: selfName, body: draft, at: "Just now", direction: "outbound" }]);
              setDraft("");
              onSent?.();
            }}
            placeholder="Write a message…"
            dataAttr="demo-record-composer"
          />
        }
      />
    </div>
  );
}

export type DemoServiceParty = { id: string; name: string; kind: "resident" | "vendor" };
export type DemoServiceMessage = {
  id: string;
  /** The id of the party whose thread the turn is in. */
  party: string;
  direction: "inbound" | "outbound";
  body: string;
  at: string;
  attachment?: string;
};

/**
 * A service's Communication section as the real `ServiceCommunicationPane` draws it: "Everyone" first (one
 * time-ordered timeline of the resident's and the vendor's turns about this service, each named - "Liam Foster ·
 * Resident", "You · to Pacific Plumbing" - with a "To" picker so a reply goes to exactly one party), then one tab
 * per party. A service with a single party shows just that party's thread. Sending only appends locally.
 */
export function DemoServiceThread({
  parties,
  messages,
  subtitle,
  selfName = "You",
}: {
  parties: readonly DemoServiceParty[];
  messages: readonly DemoServiceMessage[];
  subtitle?: string;
  selfName?: string;
}) {
  const hasEveryone = parties.length > 1;
  const [tab, setTab] = useState(hasEveryone ? "everyone" : (parties[0]?.id ?? ""));
  const [toId, setToId] = useState(parties[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState<DemoServiceMessage[]>([]);
  const everyone = hasEveryone && tab === "everyone";
  const activeParty = parties.find((party) => party.id === tab) ?? null;
  const shown = [...messages, ...sent].filter((message) => everyone || message.party === (activeParty?.id ?? tab));
  const bubbles: InboxBubbleMessage[] = shown.map((message) => {
    const party = parties.find((candidate) => candidate.id === message.party);
    const inbound = message.direction === "inbound";
    return {
      id: message.id,
      author: inbound ? (party?.name ?? "?") : selfName,
      ...(everyone && party ? { authorNote: inbound ? SERVICE_PARTY_LABEL[party.kind] : `to ${party.name}` } : {}),
      body: message.body,
      at: message.at,
      direction: message.direction,
      ...(message.attachment ? { attachments: [{ url: `#${message.attachment}`, name: message.attachment }] } : {}),
    };
  });
  const sendTo = everyone ? (parties.find((party) => party.id === toId) ?? parties[0]) : (activeParty ?? parties[0]);
  return (
    <div className="flex min-h-[420px] flex-1 flex-col" data-attr="demo-service-communication">
      <RecordTabBand
        dataAttr="service-communication"
        ariaLabel="Conversation"
        tabs={[
          ...(hasEveryone ? [{ id: "everyone", label: "Everyone" }] : []),
          ...parties.map((party) => ({ id: party.id, label: party.name })),
        ]}
        activeId={tab}
        onChange={setTab}
      />
      <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card">
        <InboxThreadView
          title={everyone ? "Everyone" : (activeParty?.name ?? "")}
          subtitle={subtitle}
          avatarName={everyone ? "Everyone" : (activeParty?.name ?? "")}
          messages={bubbles}
          composer={
            <InboxComposer
              value={draft}
              onChange={setDraft}
              onSubmit={() => {
                if (!draft.trim() || !sendTo) return;
                setSent((list) => [
                  ...list,
                  { id: `local-${list.length + 1}`, party: sendTo.id, direction: "outbound", body: draft, at: "Just now" },
                ]);
                setDraft("");
              }}
              placeholder={everyone && sendTo ? `Write to ${sendTo.name}…` : "Write a message…"}
              dataAttr="demo-record-composer"
              channelBar={
                everyone ? (
                  <div className="flex items-center gap-2 px-3 pt-2 sm:px-4" data-attr="service-communication-to">
                    <span className="text-sm font-medium text-muted">To</span>
                    <FieldSingleSelect
                      label="To"
                      hideLabel
                      variant="pill"
                      value={sendTo?.id ?? ""}
                      onChange={setToId}
                      options={parties.map((party) => ({ value: party.id, label: `${party.name} · ${SERVICE_PARTY_LABEL[party.kind]}` }))}
                      dataAttr="service-communication-to-select"
                    />
                  </div>
                ) : undefined
              }
            />
          }
        />
      </div>
    </div>
  );
}
