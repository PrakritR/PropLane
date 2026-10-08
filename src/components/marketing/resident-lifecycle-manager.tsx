"use client";

/**
 * The one manager screen the demo composes itself rather than through `DemoPanel`: the
 * live Communication page, tied to the phone beside the window (the same messages, the
 * same typing indicator). It is drawn from the REAL Communication pieces, fed fixture
 * rows: the page shell with its title-row Filter and round New message, the work number /
 * work email boxes, the Active | Archived header and search, the flat conversation rows
 * with their real ⋯ menu, the thread header with its icon actions, the timeline, the
 * PropLane draft bar and the composer with its Prepare reply / Schedule / channel tools
 * (`pro-unified-inbox.tsx`, `portal-inbox-ui.tsx`, `inbox-composer-tools.tsx`). Nothing
 * here fetches or saves. Every other manager tab renders through `DemoPanel`; the sidebar
 * and top bar live in `resident-lifecycle-workspace.tsx`.
 *
 * The contact-details column the real page draws from 1280px is left out: it needs the
 * main column the real window has, and the demo's is narrower.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Filter, Info, Mail, MailOpen, MessageSquarePlus, Phone, User } from "lucide-react";
import { AiDraftReplyCard, INBOX_THREAD_ICON_BTN, InboxConversationRow, InboxListHeader, InboxListSegmentTabs, InboxComposer, InboxThreadView, InboxTwoPane, type InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";
import { InboxComposerAiMenu, InboxComposerChannelMenu, InboxComposerScheduleMenu } from "@/components/portal/inbox-composer-tools";
import { PortalInboxContactCard } from "@/components/portal/portal-inbox-contact-card";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { DEMO_PAGE_CLASS } from "@/components/marketing/site/product-mock/shared";
import { COMM_CONVERSATIONS } from "@/components/marketing/site/product-mock/fixtures";
import { ResidentLifecycleDialog } from "./resident-lifecycle-dialog";
import { COMMUNICATION_THREADS, type SampleMessage } from "./resident-lifecycle-script";

export type { SampleMessage };

type CommunicationProps = {
  messages: SampleMessage[];
  /** The other party is typing the next message (the phone shows the same). */
  typing?: boolean;
  /** A reply PropLane drafted for the manager to approve (writes wait for the manager's confirm). */
  draft?: string | null;
  /** The manager approved the draft: it is sent and lands on the prospect's phone. */
  onApprove?: () => void;
  onReply(text: string): boolean;
};

const PROSPECT = COMMUNICATION_THREADS[0];
const PROSPECT_ID = "comm-prospect";

type Row = {
  id: string;
  name: string;
  subtitle: string;
  segment: "active" | "archived";
  time: string;
  unread?: boolean;
};

/** The conversations the list draws: the story's prospect first, then the other fixtures. */
const OTHER_ROWS: Row[] = [
  { id: "comm-mina", name: "Mina Chen", subtitle: "Prospect · Maple Duplex", segment: "active", time: "9:12 AM" },
  ...COMM_CONVERSATIONS.map<Row>((c) => ({ id: c.id, name: c.name, subtitle: c.subtitle, segment: c.segment, time: c.time, unread: c.unread })),
];

const MINA_SEED: SampleMessage[] = [
  { from: "resident", text: "Could I tour Maple Duplex on Friday?" },
  { from: "manager", text: "Friday at 11:00 AM is available." },
];

const SUBTITLE: Record<string, string> = { [PROSPECT_ID]: "Prospect · 61 Willow Court" };

function bubbles(thread: { name: string; items: SampleMessage[]; channel: "sms" | "email" }): InboxBubbleMessage[] {
  return thread.items.map((m, i) => ({
    id: `${thread.name}-${i}`,
    author: m.from === "manager" ? "Manager" : thread.name,
    body: m.text,
    at: "9:14 AM",
    direction: m.from === "manager" ? "outbound" : "inbound",
    channel: thread.channel,
  }));
}

/** Filter and the round New message sit on the page's title row, as the real list publishes them. */
function TitleActions({ onFilter, onNew }: { onFilter: () => void; onNew: () => void }) {
  const node = (
    <div className="flex shrink-0 items-center gap-1 [&_button]:shrink-0" data-attr="communication-list-actions">
      <PortalIconAction icon={Filter} label="Filter" onClick={onFilter} />
      <PortalPrimaryIconAction icon={MessageSquarePlus} label="New message" onClick={onNew} />
    </div>
  );
  usePublishTitleActions(node, true);
  return null;
}

export function ManagerCommunication({ messages, typing = false, draft: proposed = null, onApprove, onReply }: CommunicationProps) {
  const [segment, setSegment] = useState<"active" | "archived">("active");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(PROSPECT_ID);
  const [composer, setComposer] = useState("");
  const [local, setLocal] = useState<Record<string, SampleMessage[]>>({ "comm-mina": MINA_SEED });
  const [overlay, setOverlay] = useState<{ title: string; content: string; fields?: { label: string; value: string }[] } | null>(null);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [viaEmail, setViaEmail] = useState(false);
  const [viaSms, setViaSms] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const adopted = useRef<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const prospect: Row = { id: PROSPECT_ID, name: PROSPECT, subtitle: SUBTITLE[PROSPECT_ID]!, segment: "active", time: "9:14 AM", unread: false };
    return [prospect, ...OTHER_ROWS];
  }, [messages]);
  const counts = useMemo(() => ({ active: rows.filter((r) => r.segment === "active").length, archived: rows.filter((r) => r.segment === "archived").length }), [rows]);
  const needle = query.trim().toLowerCase();
  const visible = rows.filter((r) => r.segment === segment && (!needle || `${r.name} ${r.subtitle}`.toLowerCase().includes(needle)));
  const selected = rows.find((r) => r.id === selectedId) ?? visible[0] ?? rows[0]!;

  const threadItems = (id: string): SampleMessage[] => {
    if (id === PROSPECT_ID) return messages;
    if (id === "comm-mina") return local["comm-mina"] ?? MINA_SEED;
    const fixture = COMM_CONVERSATIONS.find((c) => c.id === id);
    const base: SampleMessage[] = (fixture?.messages ?? []).map((m) => ({ from: m.direction === "outbound" ? "manager" : "resident", text: m.body }));
    return [...base, ...(local[id] ?? [])];
  };
  const previewOf = (id: string) => {
    const items = threadItems(id);
    const last = items[items.length - 1];
    return last ? { prefix: last.from === "manager" ? "You: " : "", text: last.text } : { prefix: "", text: "No messages yet." };
  };

  // PropLane's draft arrives in the reply field, as the real surface adopts it (once per draft), ready for the manager to send.
  useEffect(() => {
    if (proposed && adopted.current !== proposed) {
      adopted.current = proposed;
      setComposer(proposed);
      setSelectedId(PROSPECT_ID);
    }
    if (!proposed) adopted.current = null;
  }, [proposed]);

  // The cursor's click lands on the composer's own Send button.
  useEffect(() => {
    const send = rootRef.current?.querySelector<HTMLButtonElement>(".portal-inbox-composer button[type='submit']");
    if (!send) return;
    if (proposed && selectedId === PROSPECT_ID) send.setAttribute("data-demo-target", "comm-approve");
    else send.removeAttribute("data-demo-target");
  });

  const open = useCallback((title: string, content: string, fields?: { label: string; value: string }[]) => setOverlay({ title, content, fields }), []);

  const send = () => {
    const text = composer.trim();
    if (!text) return;
    if (selected.id === PROSPECT_ID) {
      if (proposed && text === proposed) {
        setComposer("");
        onApprove?.();
        return;
      }
      if (onReply(text)) setComposer("");
      return;
    }
    setLocal((current) => ({ ...current, [selected.id]: [...(current[selected.id] ?? []), { from: "manager", text }] }));
    setComposer("");
  };

  const channel: "sms" | "email" = selected.id === "comm-ethan" || selected.subtitle.includes("Resident") ? "email" : "sms";
  const thread = bubbles({ name: selected.name, items: threadItems(selected.id), channel });
  const showDraftBar = Boolean(proposed) && selected.id === PROSPECT_ID;

  const list = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0" data-attr="communication-list-header-card">
        <div className="grid shrink-0 grid-cols-2 gap-2 px-3.5 pb-1 pt-3" data-attr="manager-work-identity">
          <PortalInboxContactCard padded={false} frame="box" leading={<Phone className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />} dataAttr="manager-work-number-card" value="(206) 555-0142" label="Your work number" actions={[]} />
          <PortalInboxContactCard padded={false} frame="box" leading={<Mail className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.9} aria-hidden />} dataAttr="manager-work-email-card" value="seattle-homes@proplane.ai" label="Your work email" actions={[]} />
        </div>
        <InboxListHeader
          tabs={<InboxListSegmentTabs commBase="/portal/communication" value={segment} onChange={setSegment} counts={counts} interceptNavigation layout="inline" />}
          search={{ value: query, onChange: setQuery, placeholder: "Search communication", ariaLabel: "Search contacts or messages", dataAttr: "unified-inbox-search" }}
          count={visible.length}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3" data-communication-inbox-list>
        {visible.map((row) => {
          const p = previewOf(row.id);
          return (
            <InboxConversationRow
              key={row.id}
              listVariant="manager"
              appearance="flat"
              name={row.name}
              preview={p.text}
              previewPrefix={p.prefix}
              time={row.time}
              unread={row.unread}
              selected={selected.id === row.id}
              onOpen={() => setSelectedId(row.id)}
              trailing={
                <RecordActionContext.Provider
                  value={{
                    scope: `${segment}:${row.id}`,
                    clear: () => undefined,
                    actions: (
                      <>
                        <Button variant="outline" onClick={() => setSegment(segment === "active" ? "archived" : "active")}>
                          {segment === "active" ? "Archive" : "Restore"}
                        </Button>
                        <Button variant="outline" data-record-action-id="edit" onClick={() => open(`${row.name} · contact`, "Contact details, linked home and recent messages.")}>
                          Edit
                        </Button>
                      </>
                    ),
                  }}
                >
                  <RecordActionMenu label={row.name} activate={() => undefined} />
                </RecordActionContext.Provider>
              }
            />
          );
        })}
        {visible.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[13px] text-muted">{segment === "archived" ? "No archived conversations" : "No matching conversations"}</p>
        ) : null}
      </div>
    </div>
  );

  const threadPane = (
    <InboxThreadView
      title={selected.name}
      subtitle={selected.subtitle}
      avatarName={selected.name}
      messages={thread}
      threadKey={selected.id}
      emptyLabel="No messages yet. Send the first message below."
      headerActions={
        <>
          <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="View record" title="View record" onClick={() => open(`${selected.name} · contact`, "Prospect details, linked home, recent messages and tour history.")}>
            <User className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Contact information" title="Contact information" onClick={() => open(`${selected.name} · contact`, "Contact details.", [{ label: "Name", value: selected.name }, { label: "Channel", value: channel === "sms" ? "SMS" : "Email" }])}>
            <Info className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Mark unread" title="Mark unread" onClick={() => undefined}>
            <MailOpen className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" className={INBOX_THREAD_ICON_BTN} aria-label="Archive conversation" title="Archive" onClick={() => setSegment("archived")}>
            <Archive className="h-4 w-4" aria-hidden />
          </button>
        </>
      }
      afterMessages={
        typing && selected.id === PROSPECT_ID ? (
          <div className="mt-3 flex w-full gap-2.5" role="status" aria-label="Typing">
            <span className="size-8 shrink-0" aria-hidden />
            <span className="rlp-typing !p-0 text-muted">
              <i />
              <i />
              <i />
            </span>
          </div>
        ) : null
      }
      composer={
        <>
          {showDraftBar ? (
            <AiDraftReplyCard
              draft={proposed ?? undefined}
              adopted={composer === proposed}
              onAdopt={(text) => setComposer(text)}
              onApprove={send}
              onDiscard={() => setComposer("")}
              hideGenerateButton
            />
          ) : null}
          <InboxComposer
            value={composer}
            onChange={setComposer}
            onSubmit={send}
            placeholder="Write a reply…"
            dataAttr="resident-direct-chat-compose"
            trailingControls={
              <>
                <InboxComposerAiMenu onDraft={() => undefined} onAsk={() => undefined} />
                <InboxComposerScheduleMenu scheduleLater={scheduleLater} onScheduleLaterChange={setScheduleLater} sendAt={sendAt} onSendAtChange={setSendAt} />
                <InboxComposerChannelMenu viaEmail={viaEmail} viaSms={viaSms} onViaEmailChange={setViaEmail} onViaSmsChange={setViaSms} emailAvailable smsAvailable />
              </>
            }
          />
        </>
      }
    />
  );

  return (
    <div className="rlp-panel-frame rlp-comm-frame" data-demo-panel="manager:communication" ref={rootRef}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col px-4 pt-4 lg:px-8 lg:pt-8">
        <ManagerPortalPageShell title="Communication" viewportFillBody stickyPageChrome={false}>
          <TitleActions
            onFilter={() => open("Filter", "Filter conversations.", [{ label: "Status", value: "Active" }, { label: "Sort", value: "Most recent" }])}
            onNew={() => open("New message", "Compose a new conversation.", [{ label: "To", value: PROSPECT }, { label: "Channel", value: "SMS" }, { label: "Message", value: `Hello ${PROSPECT},` }])}
          />
          <div className="rlp-comm-body flex min-h-0 min-w-0 flex-1 flex-col">
            <InboxTwoPane panes="flat" heightMode="viewport" fillParent threadOpen className="min-h-0 flex-1" list={list} thread={threadPane} />
          </div>
        </ManagerPortalPageShell>
      </div>
      {overlay ? (
        <ResidentLifecycleDialog title={overlay.title} body={overlay.content} fields={overlay.fields} onClose={() => setOverlay(null)} backLabel="Back to Communication" />
      ) : null}
    </div>
  );
}
