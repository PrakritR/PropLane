"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ResidentLifecycleDialog } from "./resident-lifecycle-dialog";
import { AxisLogoMark } from "@/components/brand/axis-logo";
import {
  Bell,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  CreditCard,
  FileText,
  Home,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Search,
  Send,
  Sparkles,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

export type Chapter = "message" | "tour" | "application" | "lease" | "home";
export type SampleMessage = { from: "manager" | "resident"; text: string; stage: Chapter };
type RecordItem = {
  title: string;
  place: string;
  fact: string;
  figure: string;
};
type Section =
  | "Dashboard"
  | "Properties"
  | "Tours"
  | "Applications"
  | "Leases"
  | "Residents"
  | "Payments"
  | "Services"
  | "Calendar"
  | "Communication";
type ManagerProps = {
  chapter: Chapter;
  tourAccepted: boolean;
  applicationApproved: boolean;
  leaseStep: 0 | 1 | 2 | 3;
  serviceRecord: { title: string; details: string } | null;
  messages: SampleMessage[];
  guideTarget?: string;
  guideInstruction?: string;
  suggestedReply: boolean;
  onSuggest(): void;
  onReply(text: string): void;
  onApprove(): void;
  onSendLease(): void;
  onManagerSign(): void;
  onChapter(chapter: Chapter): void;
  onExplore(): void;
};
const nav: {
  label: string;
  entries: { label: Section; icon: LucideIcon }[];
}[] = [
  {
    label: "Workspace",
    entries: [
      { label: "Dashboard", icon: Home },
      { label: "Properties", icon: Building2 },
    ],
  },
  {
    label: "Leasing",
    entries: [
      { label: "Tours", icon: CalendarDays },
      { label: "Applications", icon: ClipboardList },
      { label: "Leases", icon: FileText },
    ],
  },
  {
    label: "Tenancy",
    entries: [
      { label: "Residents", icon: Users },
      { label: "Payments", icon: CreditCard },
      { label: "Services", icon: Wrench },
    ],
  },
  {
    label: "Operations",
    entries: [
      { label: "Calendar", icon: CalendarDays },
      { label: "Communication", icon: MessageSquare },
    ],
  },
];
const primary: Record<Chapter, Section> = {
  message: "Communication",
  tour: "Tours",
  application: "Applications",
  lease: "Leases",
  home: "Residents",
};
const fixtures: Record<Section, RecordItem[]> = {
  Dashboard: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "Resident journey",
      figure: "View",
    },
    {
      title: "Upcoming tours",
      place: "61 Willow Court",
      fact: "Thursday, 5:30 PM",
      figure: "1 tour",
    },
    {
      title: "October rent",
      place: "Room 3",
      fact: "Due Oct 1",
      figure: "$1,080",
    },
  ],
  Properties: [
    {
      title: "61 Willow Court",
      place: "Oakland, CA",
      fact: "3 rooms · 2 bathrooms",
      figure: "$3,240 / mo",
    },
    {
      title: "14 Cedar Lane",
      place: "Berkeley, CA",
      fact: "2 rooms · 1 bathroom",
      figure: "$2,460 / mo",
    },
    {
      title: "8 Pacific Row",
      place: "Alameda, CA",
      fact: "4 rooms · 2 bathrooms",
      figure: "$4,680 / mo",
    },
  ],
  Tours: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "Thursday, 5:30 PM Pacific",
      figure: "Tour",
    },
    {
      title: "Mina Chen",
      place: "14 Cedar Lane",
      fact: "Friday, 11:00 AM Pacific",
      figure: "Tour",
    },
  ],
  Applications: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "Received today, 11:42 AM",
      figure: "$1,080 / mo",
    },
    {
      title: "Mina Chen",
      place: "14 Cedar Lane",
      fact: "Received yesterday",
      figure: "$1,230 / mo",
    },
  ],
  Leases: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "Oct 1 – Sep 30",
      figure: "$1,080 / mo",
    },
    {
      title: "Sam Patel",
      place: "8 Pacific Row · Room 2",
      fact: "Sep 1 – Aug 31",
      figure: "$1,170 / mo",
    },
  ],
  Residents: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "Lease Oct 1 – Sep 30",
      figure: "$1,080 / mo",
    },
    {
      title: "Sam Patel",
      place: "8 Pacific Row · Room 2",
      fact: "Lease Sep 1 – Aug 31",
      figure: "$1,170 / mo",
    },
  ],
  Payments: [
    {
      title: "October rent",
      place: "Jordan Rivera · Room 3",
      fact: "Due Oct 1",
      figure: "$1,080",
    },
    {
      title: "September rent",
      place: "Sam Patel · Room 2",
      fact: "Recorded Sep 1",
      figure: "$1,170",
    },
  ],
  Services: [
    {
      title: "Window latch",
      place: "Sam Patel · 8 Pacific Row",
      fact: "Resident request · In review",
      figure: "Sep 23",
    },
    {
      title: "Hallway light",
      place: "61 Willow Court",
      fact: "Maintenance · Open",
      figure: "Sep 24",
    },
    {
      title: "Heating check",
      place: "8 Pacific Row",
      fact: "Maintenance · Scheduled",
      figure: "Sep 26",
    },
  ],
  Calendar: [
    {
      title: "Jordan Rivera tour",
      place: "61 Willow Court · Room 3",
      fact: "Thursday, 5:30 PM",
      figure: "Tour",
    },
    {
      title: "Heating check",
      place: "8 Pacific Row",
      fact: "Friday, 9:00 AM",
      figure: "Service",
    },
  ],
  Communication: [
    {
      title: "Jordan Rivera",
      place: "61 Willow Court · Room 3",
      fact: "SMS · Room availability",
      figure: "10:12 AM",
    },
    {
      title: "Mina Chen",
      place: "14 Cedar Lane",
      fact: "Email · Tour question",
      figure: "Yesterday",
    },
  ],
};
const tabs: Partial<Record<Section, string[]>> = {
  Communication: ["Active", "Archived"],
  Tours: ["Pending", "Upcoming", "Past"],
  Applications: ["Pending", "Approved", "Rejected"],
  Leases: [
    "Manager review",
    "Resident signature pending",
    "Manager signature pending",
    "Signed",
  ],
  Payments: ["Pending", "Paid"],
  Services: ["Requests", "Maintenance", "Vendors"],
};
const sampleForms: Partial<
  Record<Section, { body: string; fields: { label: string; value: string }[] }>
> = {
  Properties: {
    body: "New property draft for Willow Court LLC.",
    fields: [
      { label: "Street address", value: "24 Cypress Way" },
      { label: "City", value: "Oakland" },
    ],
  },
  Tours: {
    body: "Offer a specific tour time to a prospect.",
    fields: [
      { label: "Prospect", value: "Jordan Rivera" },
      { label: "Time", value: "Thursday, 5:30 PM Pacific" },
    ],
  },
  Applications: {
    body: "Start a new application for a home.",
    fields: [
      { label: "Applicant", value: "Mina Chen" },
      { label: "Home", value: "14 Cedar Lane" },
    ],
  },
  Leases: {
    body: "Prepare a lease for manager review.",
    fields: [
      { label: "Resident", value: "Jordan Rivera" },
      { label: "Monthly rent", value: "$1,080" },
    ],
  },
  Residents: {
    body: "Add a resident to a home.",
    fields: [
      { label: "Resident", value: "Jordan Rivera" },
      { label: "Home", value: "61 Willow Court · Room 3" },
    ],
  },
  Payments: {
    body: "Record a payment against an open charge.",
    fields: [
      { label: "Charge", value: "October rent" },
      { label: "Amount", value: "$1,080" },
    ],
  },
  Services: {
    body: "Describe a service request for a home.",
    fields: [
      { label: "Home", value: "61 Willow Court · Room 3" },
      { label: "Issue", value: "Kitchen faucet" },
    ],
  },
  Calendar: {
    body: "Schedule a workspace event.",
    fields: [
      { label: "Event", value: "Jordan Rivera tour" },
      { label: "Time", value: "Thursday, 5:30 PM Pacific" },
    ],
  },
  Communication: {
    body: "Compose a new conversation.",
    fields: [
      { label: "To", value: "Jordan Rivera" },
      { label: "Channel", value: "SMS" },
      { label: "Message", value: "Hello Jordan," },
    ],
  },
};
const iconAction = (
  label: string,
  icon: React.ReactNode,
  onClick: () => void,
) => (
  <button
    type="button"
    className="rlp-icon-button"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    {icon}
  </button>
);

export function ResidentLifecycleManager({
  chapter,
  tourAccepted,
  applicationApproved,
  leaseStep,
  serviceRecord,
  messages,
  guideTarget,
  guideInstruction,
  suggestedReply,
  onSuggest,
  onReply,
  onApprove,
  onSendLease,
  onManagerSign,
  onChapter,
  onExplore,
}: ManagerProps) {
  const [section, setSection] = useState<Section>(primary[chapter]);
  const [tab, setTab] = useState("");
  const [query, setQuery] = useState("");
  const [thread, setThread] = useState("Jordan Rivera");
  const [draft, setDraft] = useState("");
  const [minaMessages, setMinaMessages] = useState<SampleMessage[]>([
    { from: "resident", text: "Could I tour 14 Cedar Lane on Friday?", stage: "message" },
    { from: "manager", text: "Friday at 11:00 AM is available.", stage: "message" },
  ]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [overlay, setOverlay] = useState<{
    title: string;
    content: string;
    fields?: { label: string; value: string }[];
  } | null>(null);
  const [overlayTrigger, setOverlayTrigger] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [channel, setChannel] = useState("SMS");
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  const open = (
    title: string,
    content: string,
    fields?: { label: string; value: string }[],
  ) => {
    const active = document.activeElement;
    const menuTrigger = active?.closest(".rlp-context-menu")
      ? active.closest(".rlp-record-row")?.querySelector<HTMLButtonElement>(".rlp-row-more") ??
        active.closest(".rlp-conversation")?.querySelector<HTMLButtonElement>("[aria-label='Conversation actions']")
      : null;
    setOverlayTrigger(menuTrigger ?? (active instanceof HTMLButtonElement ? active : null));
    setMenu(null);
    setOverlay({ title, content, fields });
  };
  const closeOverlay = () => {
    setOverlay(null);
    window.requestAnimationFrame(() => overlayTrigger?.focus());
  };
  const choose = (next: Section) => {
    onExplore();
    setSection(next);
    setTab("");
    setQuery("");
    setSearchOpen(false);
    setMenu(null);
    setOverlay(null);
  };
  const sectionTabs = tabs[section] ?? [];
  const activeTab =
    tab ||
    (section === "Tours"
      ? tourAccepted
        ? "Upcoming"
        : "Pending"
      : section === "Applications"
        ? applicationApproved
          ? "Approved"
          : "Pending"
        : section === "Leases"
          ? [
              "Manager review",
              "Resident signature pending",
              "Manager signature pending",
              "Signed",
            ][leaseStep]!
          : sectionTabs[0]);
  const sectionRows = [
    ...(section === "Dashboard"
      ? fixtures.Dashboard.map((row) =>
          row.title === "Upcoming tours" && !tourAccepted
            ? {
                ...row,
                title: "Offered tours",
                fact: "Awaiting Jordan’s YES",
                figure: "1 offer",
              }
            : row,
        )
      : fixtures[section]),
    ...(section === "Services" && serviceRecord
      ? [
          {
            title: serviceRecord.title,
            place: "Jordan Rivera · Room 3",
            fact: `Resident request · ${serviceRecord.details}`,
            figure: "Today",
          },
        ]
      : []),
  ];
  const tabRows = sectionRows.filter((item, index) => {
    if (section === "Tours")
      return activeTab === "Past"
        ? false
        : activeTab === "Pending"
          ? (index === 0 && !tourAccepted) || index === 1
          : index === 0 && tourAccepted;
    if (section === "Applications")
      return activeTab === "Rejected"
        ? false
        : activeTab === "Approved"
          ? index === 0 && applicationApproved
          : (index === 0 && !applicationApproved) || index === 1;
    if (section === "Leases")
      return index === 0
        ? activeTab ===
            [
              "Manager review",
              "Resident signature pending",
              "Manager signature pending",
              "Signed",
            ][leaseStep]
        : activeTab === "Signed";
    if (section === "Payments")
      return activeTab === "Paid" ? index === 1 : index === 0;
    if (section === "Services")
      return activeTab === "Vendors"
        ? false
        : activeTab === "Requests"
          ? item.fact.startsWith("Resident request")
          : !item.fact.startsWith("Resident request");
    if (section === "Communication") return activeTab !== "Archived";
    return true;
  });
  const visibleRows = tabRows.filter((row) =>
    `${row.title} ${row.place} ${row.fact}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim()) {
      if (thread === "Jordan Rivera") onReply(draft.trim());
      else
        setMinaMessages((current) => [
          ...current,
          { from: "manager", text: draft.trim(), stage: chapter },
        ]);
      setDraft("");
    }
  };
  const addLabel: Partial<Record<Section, string>> = {
    Properties: "Add property",
    Tours: "Add tour",
    Applications: "Add application",
    Leases: "Create lease",
    Residents: "Add resident",
    Payments: "Record payment",
    Services: "Request service",
    Calendar: "Create event",
    Communication: "New message",
  };
  return (
    <section
      id="resident-lifecycle-workspace"
      className="rlp-workspace"
      aria-label="Illustrative PropLane manager workspace"
    >
      <aside className="rlp-sidebar" aria-label="Manager navigation">
        <div className="rlp-brand">
          <AxisLogoMark size="compact" />
          <div>
            <strong>PropLane</strong>
            <span>
              <i /> Property
            </span>
          </div>
        </div>
        <button
          type="button"
          className="rlp-workspace-name"
          onClick={() => {}}
        >
          Willow Court LLC <ChevronDown aria-hidden />
        </button>
        <nav className="rlp-nav">
          {nav.map((group) => (
            <div key={group.label} className="rlp-nav-group">
              <p>{group.label}</p>
              {group.entries.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.label}
                    className="rlp-nav-item"
                    aria-label={item.label}
                    aria-current={section === item.label ? "page" : undefined}
                    onClick={() => choose(item.label)}
                  >
                    <Icon aria-hidden />
                    <span>{item.label}</span>
                    {item.label === "Applications" && !applicationApproved ? (
                      <b>{fixtures.Applications.length}</b>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <button
          type="button"
          className="rlp-profile"
          onClick={() => {}}
        >
          <span>AM</span>
          <strong>Avery Morgan</strong>
          <ChevronDown aria-hidden />
        </button>
      </aside>
      <div className="rlp-main">
        <header className="rlp-topbar">
          <button
            type="button"
            className="rlp-assistant"
            onClick={() => {}}
          >
            <Sparkles aria-hidden /> Ask PropLane <kbd>⌘K</kbd>
          </button>
          {iconAction("Notifications", <Bell aria-hidden />, () => {})}
          {iconAction("Profile", <span className="rlp-avatar">AM</span>, () => {})}
        </header>
        <div id="rlp-workspace-panel" className="rlp-canvas">
          <div className="rlp-page-header">
            <div>
              <span className="rlp-context-label">Manager workspace</span>
              <h2>{section}</h2>
            </div>
            <div className="rlp-header-actions">
              {iconAction(
                `Search ${section.toLowerCase()}`,
                <Search aria-hidden />,
                () => setSearchOpen((current) => !current),
              )}
              {addLabel[section]
                ? iconAction(addLabel[section], <Plus aria-hidden />, () =>
                    open(
                      addLabel[section]!,
                      sampleForms[section]!.body,
                      sampleForms[section]!.fields,
                    ),
                  )
                : null}
            </div>
          </div>
          {sectionTabs.length > 0 ? (
            <div
              className="rlp-section-tabs"
              role="tablist"
              aria-label={`${section} views`}
            >
              {sectionTabs.map((label) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === label}
                  key={label}
                  className={activeTab === label ? "rlp-tab-active" : ""}
                  onClick={() => setTab(label)}
                >
                  {label}{" "}
                  <small>
                    {section === "Communication"
                      ? label === "Active"
                        ? sectionRows.length
                        : 0
                      : section === "Tours" ||
                          section === "Applications" ||
                          section === "Leases" ||
                          section === "Payments" ||
                          section === "Services"
                        ? sectionRows.filter((row, idx) => {
                            if (section === "Tours")
                              return label === "Past"
                                ? false
                                : label === "Pending"
                                  ? (idx === 0 && !tourAccepted) || idx === 1
                                  : idx === 0 && tourAccepted;
                            if (section === "Applications")
                              return label === "Rejected"
                                ? false
                                : label === "Approved"
                                  ? idx === 0 && applicationApproved
                                  : (idx === 0 && !applicationApproved) ||
                                    idx === 1;
                            if (section === "Leases")
                              return idx === 0
                                ? label ===
                                    [
                                      "Manager review",
                                      "Resident signature pending",
                                      "Manager signature pending",
                                      "Signed",
                                    ][leaseStep]
                                : label === "Signed";
                            if (section === "Payments")
                              return label === "Paid" ? idx === 1 : idx === 0;
                            return label === "Vendors"
                              ? false
                              : label === "Requests"
                                ? row.fact.startsWith("Resident request")
                                : !row.fact.startsWith("Resident request");
                          }).length
                        : ""}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="rlp-list-command">
            <Search aria-hidden />
            <input
              id="rlp-manager-search"
              aria-label={`Search ${section.toLowerCase()}`}
              placeholder={`Search ${section.toLowerCase()}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
              >
                <X aria-hidden />
              </button>
            ) : null}
            <span>{tabRows.length} records</span>
          </div>
          {searchOpen ? (
            <div className="rlp-search-suggestions">
              <strong>Find a record</strong>
              {sectionRows.slice(0, 3).map((row) => (
                <button
                  type="button"
                  key={row.title}
                  onClick={() => {
                    setQuery(row.title);
                    setSearchOpen(false);
                  }}
                >
                  {row.title}
                </button>
              ))}
            </div>
          ) : null}
          {section === "Communication" && activeTab === "Active" ? (
            <div className="rlp-live-communication">
              <div className="rlp-contacts">
                {"Jordan Rivera 61 Willow Court Room 3"
                  .toLowerCase()
                  .includes(query.toLowerCase()) ? (
                  <div className="rlp-contact-entry">
                    <button
                      type="button"
                      className={
                        thread === "Jordan Rivera" ? "rlp-contact-active" : ""
                      }
                      onClick={() => setThread("Jordan Rivera")}
                    >
                      <span>JR</span>
                      <strong>Jordan Rivera</strong>
                      <small>61 Willow Court · Room 3</small>
                    </button>
                    <button
                      type="button"
                      className="rlp-contact-more"
                      aria-label="More actions for Jordan Rivera"
                      onClick={() => {}}
                    >
                      <MoreHorizontal aria-hidden />
                    </button>
                  </div>
                ) : null}
                {"Mina Chen 14 Cedar Lane Tour question"
                  .toLowerCase()
                  .includes(query.toLowerCase()) ? (
                  <div className="rlp-contact-entry">
                    <button
                      type="button"
                      className={
                        thread === "Mina Chen" ? "rlp-contact-active" : ""
                      }
                      onClick={() => setThread("Mina Chen")}
                    >
                      <span>MC</span>
                      <strong>Mina Chen</strong>
                      <small>14 Cedar Lane · Tour question</small>
                    </button>
                    <button
                      type="button"
                      className="rlp-contact-more"
                      aria-label="More actions for Mina Chen"
                      onClick={() => {}}
                    >
                      <MoreHorizontal aria-hidden />
                    </button>
                  </div>
                ) : null}
                {query && visibleRows.length === 0 ? (
                  <div className="rlp-contact-empty">
                    No matching conversations
                  </div>
                ) : null}
              </div>
              <div className="rlp-conversation">
                <div className="rlp-person-bar">
                  <span>{thread === "Jordan Rivera" ? "JR" : "MC"}</span>
                  <div>
                    <strong>{thread}</strong>
                    <small>
                      {thread === "Jordan Rivera"
                        ? "Prospect · 61 Willow Court"
                        : "Prospect · 14 Cedar Lane"}
                    </small>
                  </div>
                  {iconAction(
                    "Conversation actions",
                    <MoreHorizontal aria-hidden />,
                    () =>
                      setMenu(menu === "conversation" ? null : "conversation"),
                  )}
                </div>
                {menu === "conversation" ? (
                  <div className="rlp-context-menu">
                    <button
                      type="button"
                      onClick={() =>
                        open(
                          `${thread} · contact`,
                          "Prospect details, linked home, recent messages and tour history.",
                        )
                      }
                    >
                      View contact
                    </button>
                    <button
                      type="button"
                      onClick={() => setMenu(null)}
                    >
                      Conversation details
                    </button>
                  </div>
                ) : null}
                <div className="rlp-messages">
                  {thread === "Jordan Rivera"
                    ? messages.map((message, index) => (
                        <div
                          key={`${message.text}-${index}`}
                          className={`rlp-bubble rlp-bubble-${message.from}`}
                        >
                          {message.text}
                        </div>
                      ))
                    : minaMessages.map((message, index) => (
                        <div
                          key={`${message.text}-${index}`}
                          className={`rlp-bubble rlp-bubble-${message.from}`}
                        >
                          {message.text}
                        </div>
                      ))}
                </div>
                {thread === "Jordan Rivera" && !suggestedReply ? (
                  <button type="button" className="rlp-suggest-reply"
                    data-guide-target="suggest"
                    data-guide-active={guideTarget === "suggest" ? "true" : undefined}
                    data-guide-label={guideTarget === "suggest" ? guideInstruction : undefined}
                    onClick={() => {
                      setDraft("Yes, Room 3 is available. Thursday at 5:30 PM Pacific is offered for a tour. Reply YES to confirm that time.");
                      onSuggest();
                    }}>
                    <Sparkles aria-hidden /> Prepare reply
                  </button>
                ) : null}
                <form className="rlp-compose" onSubmit={send}>
                  {iconAction("Attach file", <Paperclip aria-hidden />, () => {})}
                  <label className="rlp-channel-select">
                    <span className="sr-only">Channel</span>
                    <select
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                    >
                      <option>SMS</option>
                      <option>Email</option>
                    </select>
                  </label>
                  <input
                    aria-label="Write a reply"
                    placeholder="Write a reply…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    aria-label="Send sample reply"
                    title="Send sample reply"
                    data-guide-target="send"
                    data-guide-active={guideTarget === "send" ? "true" : undefined}
                    data-guide-label={guideTarget === "send" ? guideInstruction : undefined}
                    disabled={!draft.trim()}
                  >
                    <Send aria-hidden />
                  </button>
                </form>
              </div>
            </div>
          ) : null}
          {section !== "Communication" ? (
            <div className="rlp-record-surface" aria-live="polite">
              {visibleRows.length ? (
                visibleRows.map((row) => (
                  <div
                    className="rlp-record-row"
                    key={`${section}-${row.title}`}
                  >
                    <button
                      type="button"
                      className="rlp-record-open"
                      onClick={() =>
                        open(
                          row.title,
                          `${row.place} · ${row.fact} · ${row.figure}`,
                        )
                      }
                    >
                      <span className="rlp-record-tile">
                        {row.title
                          .split(" ")
                          .map((part) => part[0])
                          .slice(0, 2)
                          .join("")}
                      </span>
                      <span className="rlp-record-copy">
                        <strong>{row.title}</strong>
                        <small>{row.place}</small>
                        <em>{row.fact}</em>
                      </span>
                      <span className="rlp-record-figure">{row.figure}</span>
                      <ChevronRight aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="rlp-row-more"
                      aria-label={`More actions for ${row.title}`}
                      onClick={() =>
                        setMenu(menu === row.title ? null : row.title)
                      }
                    >
                      <MoreHorizontal aria-hidden />
                    </button>
                    {menu === row.title ? (
                      <div className="rlp-context-menu">
                        <button
                          type="button"
                          onClick={() =>
                            open(
                              row.title,
                              `${row.place} · ${row.fact} · ${row.figure}`,
                            )
                          }
                        >
                          View details
                        </button>
                        <button
                          type="button"
                          onClick={() => setMenu(null)}
                        >
                          View activity
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="rlp-no-match">
                  <strong>No matching records</strong>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      if (tabRows.length === 0) setTab("");
                    }}
                  >
                    Clear search or filter
                  </button>
                </div>
              )}
            </div>
          ) : activeTab === "Archived" ? (
            <div className="rlp-no-match">
              <strong>No archived conversations</strong>
              <button type="button" onClick={() => setTab("Active")}>
                View active
              </button>
            </div>
          ) : null}
          {section === "Tours" ? (
            <div className="rlp-action-strip">
              <div>
                <small>Jordan Rivera · Thursday, 5:30 PM Pacific</small>
                <strong>
                  {tourAccepted
                    ? "Tour confirmed"
                    : "Offered time awaiting Jordan's YES"}
                </strong>
              </div>
              <button
                type="button"
                onClick={() => {}}
              >
                View tour offer <ChevronRight aria-hidden />
              </button>
            </div>
          ) : null}
          {section === "Applications" ? (
            <div className="rlp-action-strip">
              <div>
                <small>Jordan Rivera · Room 3</small>
                <strong>
                  {applicationApproved
                    ? "Approved by Avery Morgan"
                    : "Ready for manager review"}
                </strong>
              </div>
              {!applicationApproved ? (
                <button
                  type="button"
                  data-guide-target="approve"
                  data-guide-active={guideTarget === "approve" ? "true" : undefined}
                  data-guide-label={guideTarget === "approve" ? guideInstruction : undefined}
                  onClick={() => {
                    if (chapter !== "application") onChapter("application");
                    onApprove();
                  }}
                >
                  Approve application <Check aria-hidden />
                </button>
              ) : (
                <button type="button" onClick={() => onChapter("lease")}>
                  Open lease chapter <ChevronRight aria-hidden />
                </button>
              )}
            </div>
          ) : null}
          {section === "Leases" ? (
            <div className="rlp-action-strip">
              <div>
                <small>Jordan Rivera · Room 3</small>
                <strong>
                  {
                    [
                      "Manager review",
                      "Resident signature pending",
                      "Manager signature pending",
                      "Signed",
                    ][leaseStep]
                  }
                </strong>
              </div>
              {leaseStep === 0 ? (
                <button
                  type="button"
                  data-guide-target="send-lease"
                  data-guide-active={guideTarget === "send-lease" ? "true" : undefined}
                  data-guide-label={guideTarget === "send-lease" ? guideInstruction : undefined}
                  onClick={() => {
                    if (chapter !== "lease") onChapter("lease");
                    onSendLease();
                  }}
                >
                  Send to resident <Send aria-hidden />
                </button>
              ) : leaseStep === 1 ? (
                <span className="rlp-awaiting-signature">Awaiting Jordan’s signature</span>
              ) : leaseStep === 2 ? (
                <button
                  type="button"
                  data-guide-target="manager-sign"
                  data-guide-active={guideTarget === "manager-sign" ? "true" : undefined}
                  data-guide-label={guideTarget === "manager-sign" ? guideInstruction : undefined}
                  onClick={() => {
                    if (chapter !== "lease") onChapter("lease");
                    onManagerSign();
                  }}
                >
                  Countersign sample lease <Check aria-hidden />
                </button>
              ) : (
                <button type="button" onClick={() => onChapter("home")}>
                  Open resident home <ChevronRight aria-hidden />
                </button>
              )}
            </div>
          ) : null}
          {section === "Residents" ? (
            <div className="rlp-action-strip">
              <div>
                <small>Jordan Rivera · 61 Willow Court</small>
                <strong>Room 3 · October rent $1,080</strong>
              </div>
              <button type="button" onClick={() => choose("Communication")}>
                Message Jordan <MessageSquare aria-hidden />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {overlay ? (
        <ResidentLifecycleDialog
          title={overlay.title}
          body={overlay.content}
          fields={overlay.fields}
          onClose={closeOverlay}
          backLabel={`Back to ${section}`}
        />
      ) : null}
    </section>
  );
}
