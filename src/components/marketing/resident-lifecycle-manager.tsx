"use client";

/**
 * The one manager screen the demo draws itself rather than through `DemoPanel`: the
 * live Communication thread, tied to the phone beside the window (the same messages,
 * the same typing indicator). Every other manager tab renders its real panel through
 * `DemoPanel`; the sidebar and top bar live in `resident-lifecycle-workspace.tsx`.
 */

import { useEffect, useState, type FormEvent } from "react";
import { Check, MoreHorizontal, Paperclip, Pencil, Plus, Search, Send, Sparkles, X } from "lucide-react";
import { ResidentLifecycleDialog } from "./resident-lifecycle-dialog";
import { COMMUNICATION_THREADS, type SampleMessage } from "./resident-lifecycle-script";

export type { SampleMessage };

const iconAction = (label: string, icon: React.ReactNode, onClick: () => void, primary = false) => (
  <button type="button" className={primary ? "rlp-icon-button rlp-icon-primary" : "rlp-icon-button"} aria-label={label} title={label} onClick={onClick}>
    {icon}
  </button>
);

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

export function ManagerCommunication({ messages, typing = false, draft: proposed = null, onApprove, onReply }: CommunicationProps) {
  const [tab, setTab] = useState("Active");
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState<string>(PROSPECT);
  const [draft, setDraft] = useState("");
  const [minaMessages, setMinaMessages] = useState<SampleMessage[]>([
    { from: "resident", text: "Could I tour Maple Duplex on Friday?" },
    { from: "manager", text: "Friday at 11:00 AM is available." },
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
    if (!draft.trim()) return;
    if (thread === PROSPECT) {
      if (onReply(draft.trim())) setDraft("");
    } else {
      setMinaMessages((current) => [...current, { from: "manager", text: draft.trim() }]);
      setDraft("");
    }
  };
  const showJordan = `${PROSPECT} 61 Willow Court Room 3`.toLowerCase().includes(query.toLowerCase());
  const showMina = "Mina Chen Maple Duplex Tour question".toLowerCase().includes(query.toLowerCase());
  const matches = Number(showJordan) + Number(showMina);

  return (
    <>
      <div className="rlp-page-header">
        <h2>Communication</h2>
        <div className="rlp-header-actions">
          {iconAction("Search communication", <Search aria-hidden />, () => setSearchOpen((current) => !current))}
          {iconAction("New message", <Plus aria-hidden />, () =>
            open("New message", "Compose a new conversation.", [
              { label: "To", value: PROSPECT },
              { label: "Channel", value: "SMS" },
              { label: "Message", value: `Hello ${PROSPECT},` },
            ]),
            true,
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
            {label} <small>{label === "Active" ? COMMUNICATION_THREADS.length : 0}</small>
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
        <span>{tab === "Active" ? COMMUNICATION_THREADS.length : 0} records</span>
      </div>
      {searchOpen ? (
        <div className="rlp-search-suggestions">
          <strong>Find a record</strong>
          {COMMUNICATION_THREADS.map((name) => (
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
                <button type="button" className={thread === PROSPECT ? "rlp-contact-active" : ""} onClick={() => setThread(PROSPECT)}>
                  <span>JO</span>
                  <strong>{PROSPECT}</strong>
                  <small>61 Willow Court · Room 3</small>
                </button>
                <button type="button" className="rlp-contact-more" aria-label={`More actions for ${PROSPECT}`} onClick={() => {}}>
                  <MoreHorizontal aria-hidden />
                </button>
              </div>
            ) : null}
            {showMina ? (
              <div className="rlp-contact-entry">
                <button type="button" className={thread === "Mina Chen" ? "rlp-contact-active" : ""} onClick={() => setThread("Mina Chen")}>
                  <span>MC</span>
                  <strong>Mina Chen</strong>
                  <small>Maple Duplex · Tour question</small>
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
              <span>{thread === PROSPECT ? "JO" : "MC"}</span>
              <div>
                <strong>{thread}</strong>
                <small>{thread === PROSPECT ? "Prospect · 61 Willow Court" : "Prospect · Maple Duplex"}</small>
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
              {(thread === PROSPECT ? messages : minaMessages).map((message, index) => (
                <div key={`${message.text}-${index}`} className={`rlp-bubble rlp-bubble-${message.from}`}>
                  {message.text}
                </div>
              ))}
              {typing && thread === PROSPECT ? (
                <div className="rlp-bubble rlp-bubble-resident rlp-typing" role="status" aria-label="Typing">
                  <i />
                  <i />
                  <i />
                </div>
              ) : null}
            </div>
            {proposed && thread === PROSPECT ? (
              <div className="rlp-draft" role="group" aria-label="Reply drafted by PropLane">
                <div className="rlp-draft-head">
                  <Sparkles aria-hidden />
                  <strong>PropLane drafted a reply</strong>
                </div>
                <p>{proposed}</p>
                <div className="rlp-draft-actions">
                  <button type="button" className="rlp-draft-approve" data-demo-target="comm-approve" onClick={() => onApprove?.()}>
                    <Check aria-hidden /> Approve &amp; send
                  </button>
                  <button type="button" onClick={() => setDraft(proposed)}>
                    <Pencil aria-hidden /> Edit
                  </button>
                </div>
              </div>
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
                disabled={!draft.trim()}
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
