"use client";

/**
 * The two manager-side pieces of Akhil's guided sample that are not a plain
 * portal screen: the live Communication thread (tied to Jordan's phone) and the
 * action strip under a record screen (approve, send the lease, countersign).
 * Every other manager tab renders its real panel through `DemoPanel`; the
 * sidebar and top bar live in `resident-lifecycle-workspace.tsx`.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronRight, MessageSquare, MoreHorizontal, Paperclip, Plus, Search, Send, Sparkles, X } from "lucide-react";
import { ResidentLifecycleDialog } from "./resident-lifecycle-dialog";
import { SUGGESTED_REPLY, type Chapter, type SampleMessage } from "./resident-lifecycle-script";

export type { Chapter, SampleMessage };

const LEASE_STATUS = [
  "Manager review",
  "Resident signature pending",
  "Manager signature pending",
  "Signed",
] as const;

const iconAction = (label: string, icon: React.ReactNode, onClick: () => void) => (
  <button type="button" className="rlp-icon-button" aria-label={label} title={label} onClick={onClick}>
    {icon}
  </button>
);

type CommunicationProps = {
  messages: SampleMessage[];
  chapter: Chapter;
  suggestedReply: boolean;
  /** Pre-filled composer text, for a thread that mounts while the reply is prepared but not sent. */
  initialDraft: string;
  guideTarget?: string;
  guideInstruction?: string;
  busy: boolean;
  onSuggest(): boolean;
  onReply(text: string): boolean;
};

export function ManagerCommunication({
  messages,
  chapter,
  suggestedReply,
  initialDraft,
  guideTarget,
  guideInstruction,
  busy,
  onSuggest,
  onReply,
}: CommunicationProps) {
  const [tab, setTab] = useState("Active");
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState("Jordan Rivera");
  const [draft, setDraft] = useState(initialDraft);
  const [minaMessages, setMinaMessages] = useState<SampleMessage[]>([
    { from: "resident", text: "Could I tour 14 Cedar Lane on Friday?", stage: "message" },
    { from: "manager", text: "Friday at 11:00 AM is available.", stage: "message" },
  ]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [overlay, setOverlay] = useState<{ title: string; content: string; fields?: { label: string; value: string }[] } | null>(null);
  const [overlayTrigger, setOverlayTrigger] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [channel, setChannel] = useState("SMS");

  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);

  const open = (title: string, content: string, fields?: { label: string; value: string }[]) => {
    const active = document.activeElement;
    const menuTrigger = active?.closest(".rlp-context-menu")
      ? active.closest(".rlp-conversation")?.querySelector<HTMLButtonElement>("[aria-label='Conversation actions']")
      : null;
    setOverlayTrigger(menuTrigger ?? (active instanceof HTMLButtonElement ? active : null));
    setMenu(null);
    setOverlay({ title, content, fields });
  };
  const closeOverlay = () => {
    setOverlay(null);
    window.requestAnimationFrame(() => overlayTrigger?.focus());
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !draft.trim()) return;
    if (thread === "Jordan Rivera") {
      if (onReply(draft.trim())) setDraft("");
    } else {
      setMinaMessages((current) => [...current, { from: "manager", text: draft.trim(), stage: chapter }]);
      setDraft("");
    }
  };
  const showJordan = "Jordan Rivera 61 Willow Court Room 3".toLowerCase().includes(query.toLowerCase());
  const showMina = "Mina Chen 14 Cedar Lane Tour question".toLowerCase().includes(query.toLowerCase());
  const matches = Number(showJordan) + Number(showMina);

  return (
    <>
      <div className="rlp-page-header">
        <div>
          <span className="rlp-context-label">Manager workspace</span>
          <h2>Communication</h2>
        </div>
        <div className="rlp-header-actions">
          {iconAction("Search communication", <Search aria-hidden />, () => setSearchOpen((current) => !current))}
          {iconAction("New message", <Plus aria-hidden />, () =>
            open("New message", "Compose a new conversation.", [
              { label: "To", value: "Jordan Rivera" },
              { label: "Channel", value: "SMS" },
              { label: "Message", value: "Hello Jordan," },
            ]),
          )}
        </div>
      </div>
      <div className="rlp-section-tabs" role="tablist" aria-label="Communication views">
        {["Active", "Archived"].map((label) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === label}
            key={label}
            className={tab === label ? "rlp-tab-active" : ""}
            onClick={() => setTab(label)}
          >
            {label} <small>{label === "Active" ? 2 : 0}</small>
          </button>
        ))}
      </div>
      <div className="rlp-list-command">
        <Search aria-hidden />
        <input
          id="rlp-manager-search"
          aria-label="Search communication"
          placeholder="Search communication"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label="Clear search">
            <X aria-hidden />
          </button>
        ) : null}
        <span>{tab === "Active" ? 2 : 0} records</span>
      </div>
      {searchOpen ? (
        <div className="rlp-search-suggestions">
          <strong>Find a record</strong>
          {["Jordan Rivera", "Mina Chen"].map((name) => (
            <button
              type="button"
              key={name}
              onClick={() => {
                setQuery(name);
                setSearchOpen(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "Active" ? (
        <div className="rlp-live-communication">
          <div className="rlp-contacts">
            {showJordan ? (
              <div className="rlp-contact-entry">
                <button type="button" className={thread === "Jordan Rivera" ? "rlp-contact-active" : ""} onClick={() => setThread("Jordan Rivera")}>
                  <span>JR</span>
                  <strong>Jordan Rivera</strong>
                  <small>61 Willow Court · Room 3</small>
                </button>
                <button type="button" className="rlp-contact-more" aria-label="More actions for Jordan Rivera" onClick={() => {}}>
                  <MoreHorizontal aria-hidden />
                </button>
              </div>
            ) : null}
            {showMina ? (
              <div className="rlp-contact-entry">
                <button type="button" className={thread === "Mina Chen" ? "rlp-contact-active" : ""} onClick={() => setThread("Mina Chen")}>
                  <span>MC</span>
                  <strong>Mina Chen</strong>
                  <small>14 Cedar Lane · Tour question</small>
                </button>
                <button type="button" className="rlp-contact-more" aria-label="More actions for Mina Chen" onClick={() => {}}>
                  <MoreHorizontal aria-hidden />
                </button>
              </div>
            ) : null}
            {query && matches === 0 ? <div className="rlp-contact-empty">No matching conversations</div> : null}
          </div>
          <div className="rlp-conversation">
            <div className="rlp-person-bar">
              <span>{thread === "Jordan Rivera" ? "JR" : "MC"}</span>
              <div>
                <strong>{thread}</strong>
                <small>{thread === "Jordan Rivera" ? "Prospect · 61 Willow Court" : "Prospect · 14 Cedar Lane"}</small>
              </div>
              {iconAction("Conversation actions", <MoreHorizontal aria-hidden />, () =>
                setMenu(menu === "conversation" ? null : "conversation"),
              )}
            </div>
            {menu === "conversation" ? (
              <div className="rlp-context-menu">
                <button
                  type="button"
                  onClick={() => open(`${thread} · contact`, "Prospect details, linked home, recent messages and tour history.")}
                >
                  View contact
                </button>
                <button type="button" onClick={() => setMenu(null)}>
                  Conversation details
                </button>
              </div>
            ) : null}
            <div className="rlp-messages">
              {(thread === "Jordan Rivera" ? messages : minaMessages).map((message, index) => (
                <div key={`${message.text}-${index}`} className={`rlp-bubble rlp-bubble-${message.from}`}>
                  {message.text}
                </div>
              ))}
            </div>
            {thread === "Jordan Rivera" && !suggestedReply ? (
              <button
                type="button"
                className="rlp-suggest-reply"
                data-guide-target="suggest"
                data-guide-active={guideTarget === "suggest" ? "true" : undefined}
                data-guide-label={guideTarget === "suggest" ? guideInstruction : undefined}
                disabled={busy}
                onClick={() => {
                  if (onSuggest()) setDraft(SUGGESTED_REPLY);
                }}
              >
                <Sparkles aria-hidden /> Prepare reply
              </button>
            ) : null}
            <form className="rlp-compose" onSubmit={send}>
              {iconAction("Attach file", <Paperclip aria-hidden />, () => {})}
              <label className="rlp-channel-select">
                <span className="sr-only">Channel</span>
                <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option>SMS</option>
                  <option>Email</option>
                </select>
              </label>
              <input aria-label="Write a reply" placeholder="Write a reply…" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button
                type="submit"
                aria-label="Send sample reply"
                title="Send sample reply"
                data-guide-target="send"
                data-guide-active={guideTarget === "send" ? "true" : undefined}
                data-guide-label={guideTarget === "send" ? guideInstruction : undefined}
                disabled={busy || !draft.trim()}
              >
                <Send aria-hidden />
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="rlp-no-match">
          <strong>No archived conversations</strong>
          <button type="button" onClick={() => setTab("Active")}>
            View active
          </button>
        </div>
      )}
      {overlay ? (
        <ResidentLifecycleDialog
          title={overlay.title}
          body={overlay.content}
          fields={overlay.fields}
          onClose={closeOverlay}
          backLabel="Back to Communication"
        />
      ) : null}
    </>
  );
}

type StripProps = {
  tab: string;
  tourAccepted: boolean;
  applicationApproved: boolean;
  leaseStep: 0 | 1 | 2 | 3;
  serviceRecord: { title: string; details: string } | null;
  vendorOffered: boolean;
  guideTarget?: string;
  guideInstruction?: string;
  busy: boolean;
  onApprove(): boolean;
  onSendLease(): boolean;
  onManagerSign(): boolean;
  onChapter(chapter: Chapter): void;
  onOpenTab(tab: string): void;
};

/** Akhil's action strip under a record screen; the highlighted button is the guided step. */
export function ManagerActionStrip({
  tab,
  tourAccepted,
  applicationApproved,
  leaseStep,
  serviceRecord,
  vendorOffered,
  guideTarget,
  guideInstruction,
  busy,
  onApprove,
  onSendLease,
  onManagerSign,
  onChapter,
  onOpenTab,
}: StripProps) {
  const guide = (target: string) => ({
    "data-guide-target": target,
    "data-guide-active": guideTarget === target ? "true" : undefined,
    "data-guide-label": guideTarget === target ? guideInstruction : undefined,
  });
  if (tab === "tours") {
    return (
      <div className="rlp-action-strip">
        <div>
          <small>Jordan Rivera · Thursday, 5:30 PM Pacific</small>
          <strong>{tourAccepted ? "Tour confirmed" : "Offered time awaiting Jordan's YES"}</strong>
        </div>
      </div>
    );
  }
  if (tab === "applications") {
    return (
      <div className="rlp-action-strip">
        <div>
          <small>Jordan Rivera · Room 3</small>
          <strong>{applicationApproved ? "Approved by Avery Morgan" : "Ready for manager review"}</strong>
        </div>
        {!applicationApproved ? (
          <button type="button" {...guide("approve")} disabled={busy} onClick={() => onApprove()}>
            Approve application <Check aria-hidden />
          </button>
        ) : (
          <button type="button" onClick={() => onChapter("lease")}>
            Open lease chapter <ChevronRight aria-hidden />
          </button>
        )}
      </div>
    );
  }
  if (tab === "leases") {
    return (
      <div className="rlp-action-strip">
        <div>
          <small>Jordan Rivera · Room 3</small>
          <strong>{LEASE_STATUS[leaseStep]}</strong>
        </div>
        {leaseStep === 0 ? (
          <button type="button" {...guide("send-lease")} disabled={busy} onClick={() => onSendLease()}>
            Send to resident <Send aria-hidden />
          </button>
        ) : leaseStep === 1 ? (
          <span className="rlp-awaiting-signature">Awaiting Jordan’s signature</span>
        ) : leaseStep === 2 ? (
          <button type="button" {...guide("manager-sign")} disabled={busy} onClick={() => onManagerSign()}>
            Countersign sample lease <Check aria-hidden />
          </button>
        ) : (
          <button type="button" onClick={() => onChapter("home")}>
            Open resident home <ChevronRight aria-hidden />
          </button>
        )}
      </div>
    );
  }
  if (tab === "residents") {
    return (
      <div className="rlp-action-strip">
        <div>
          <small>Jordan Rivera · 61 Willow Court</small>
          <strong>Room 3 · October rent $1,080</strong>
        </div>
        <button type="button" onClick={() => onOpenTab("communication")}>
          Message Jordan <MessageSquare aria-hidden />
        </button>
      </div>
    );
  }
  if (tab === "services" && serviceRecord) {
    return (
      <div className="rlp-action-strip">
        <div>
          <small>Jordan Rivera · Room 3 · Resident request</small>
          <strong>
            {serviceRecord.title}
            {vendorOffered ? " · Offered to Northwind Plumbing" : " · New in the queue"}
          </strong>
        </div>
      </div>
    );
  }
  return null;
}
