"use client";

/**
 * Small pieces every new demo panel shares (`panels-manager-more.tsx`,
 * `panels-resident.tsx`, `panels-vendor.tsx`): the page frame around a list,
 * the real kebab, search filtering, and the two-pane inbox. They compose the
 * same real portal components `panels.tsx` does — `ManagerPortalPageShell`,
 * `PortalListControlStack`, `PortalRecordListSurface`, `LocalDestinationNav`,
 * `InboxTwoPane` — and add no look of their own.
 */

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { PenSquare, Settings } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { InboxComposer, InboxConversationRow, InboxThreadView, InboxTwoPane } from "@/components/portal/portal-inbox-ui";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { CommConversationFixture } from "@/components/marketing/site/product-mock/fixtures";
import { DEMO_PAGE_CLASS, ProductWindow, useFixtureToast } from "@/components/marketing/site/product-mock/shared";

export function matchesSearch(query: string, ...haystack: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.join(" ").toLowerCase().includes(q);
}

/** The ⋯ menu's items. `RowSelectCheckbox` only draws the real "⋯" when its
 * surface got `bulkActions`; labels here are the row's real menu, and each
 * item only fires the toast — nothing persists. */
export function FixtureMenuItems({ toast, items }: { toast: (text: string) => void; items: string[] }) {
  return (
    <>
      {items.map((label) => (
        <DropdownMenuItem key={label} onSelect={() => toast(`${label} (sample)`)}>
          {label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export type FixtureTab = { id: string; label: string; count?: number; alert?: boolean };

/**
 * One portal list page: the window frame, the hidden-title page shell, the
 * command bar (tabs with counts, search, icon actions, round blue +), and the
 * record-list surface with its ⋯ menu.
 */
export function FixtureListScreen({
  path,
  sidebar,
  title,
  tabs,
  activeId,
  onTab,
  tabAriaLabel,
  search,
  onSearch,
  searchPlaceholder,
  actions,
  primary,
  above,
  recordSummary,
  isEmpty,
  emptyTitle,
  emptySection,
  menu,
  onBulkClear,
  surface = true,
  children,
  overlay,
}: {
  path: string;
  sidebar?: ReactNode;
  title: string;
  tabs: FixtureTab[];
  activeId: string;
  onTab: (id: string) => void;
  tabAriaLabel?: string;
  search?: string;
  onSearch?: (value: string) => void;
  searchPlaceholder?: string;
  actions?: ReactNode;
  primary?: { label: string; onClick: () => void };
  /** Cards that sit above the command bar on the real page (a balance, a summary). */
  above?: ReactNode;
  /** The command bar's one summary line (`PortalListControlStack recordSummary`), derived from the rows drawn. */
  recordSummary?: ReactNode;
  isEmpty: boolean;
  emptyTitle: string;
  emptySection?: string;
  /** Items for the real ⋯ (rows become selectable); omit for a list whose rows carry their own menu. */
  menu?: ReactNode;
  /** With `menu`: clears the panel's row selection (a list whose ⋯ acts on the one selected row, like the real Forms list). */
  onBulkClear?: () => void;
  /** False for a page whose body is not a record list (the Calendar grid). */
  surface?: boolean;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <ProductWindow path={path}>
      {sidebar}
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title={title} titleInlineFilter={null} hideTitleOnMobileNav compactFilterRow>
          {above}
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            stickyDestinations={false}
            destinationRow={
              tabs.length > 0 ? (
                <LocalDestinationNav
                  appearance="command"
                  ariaLabel={tabAriaLabel ?? `${title} views`}
                  items={tabs}
                  activeId={activeId}
                  onChange={onTab}
                />
              ) : undefined
            }
            search={onSearch ? { value: search ?? "", onChange: onSearch, placeholder: searchPlaceholder ?? "Search" } : undefined}
            recordSummary={recordSummary}
            actions={actions}
            primary={primary ? <PortalPrimaryIconAction label={primary.label} onClick={primary.onClick} /> : undefined}
          />
          {surface ? (
            <PortalRecordListSurface isEmpty={isEmpty} emptyCard={{ title: emptyTitle, section: emptySection }} bulkActions={menu} onBulkClear={onBulkClear}>
              {children}
            </PortalRecordListSurface>
          ) : (
            children
          )}
        </ManagerPortalPageShell>
      </div>
      {overlay}
    </ProductWindow>
  );
}

/** Counts per bucket, derived from the rows a panel actually draws. */
export function countBy<T>(rows: T[], key: (row: T) => string, ids: string[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
}

/**
 * The Communication two-pane (list left, thread right) — the same shape as
 * `CommunicationPanel` in `panels.tsx`, fed one portal's own conversations.
 * Active · Archived tabs, the Filter / Settings / New message utilities, a
 * thread with the real bubbles and composer; sending only appends locally.
 */
export function FixtureInboxScreen({
  path,
  sidebar,
  conversations,
  selfName,
  searchPlaceholder = "Search messages",
}: {
  path: string;
  sidebar?: ReactNode;
  conversations: CommConversationFixture[];
  selfName: string;
  searchPlaceholder?: string;
}) {
  const [segment, setSegment] = useState<"active" | "archived">("active");
  const [selectedId, setSelectedId] = useState(conversations.find((c) => c.segment === "active")?.id ?? conversations[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<Record<string, { id: string; author: string; body: string; at: string; direction: "outbound" }[]>>({});
  const { show, node: toastNode } = useFixtureToast();
  // The list and thread sit side by side from the desktop breakpoint; below it the
  // real inbox shows the list until a row is opened, then the thread with a back arrow.
  const [wide, setWide] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const counts = useMemo(() => {
    const c = { active: 0, archived: 0 };
    for (const conv of conversations) c[conv.segment] += 1;
    return c;
  }, [conversations]);
  const visible = conversations.filter((c) => c.segment === segment && matchesSearch(query, c.name, c.subtitle, c.preview));
  const selected: CommConversationFixture | undefined = conversations.find((c) => c.id === selectedId) ?? visible[0];
  const messages = selected ? [...selected.messages, ...(sent[selected.id] ?? [])] : [];

  function send() {
    if (!draft.trim() || !selected) return;
    setSent((m) => ({
      ...m,
      [selected.id]: [...(m[selected.id] ?? []), { id: `local-${(m[selected.id]?.length ?? 0) + 1}`, author: selfName, body: draft, at: "Just now", direction: "outbound" }],
    }));
    setDraft("");
    show("Sent");
  }

  return (
    <ProductWindow path={path}>
      {sidebar}
      <div className={DEMO_PAGE_CLASS}>
        <ManagerPortalPageShell title="Communication" viewportFillBody>
          <InboxTwoPane
            threadOpen={wide || opened}
            fillParent
            panes="split"
            list={
              <div className="flex h-full flex-col">
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <LocalDestinationNav
                    appearance="command"
                    ariaLabel="Conversations"
                    items={[
                      { id: "active", label: "Active", count: counts.active },
                      { id: "archived", label: "Archived", count: counts.archived },
                    ]}
                    activeId={segment}
                    onChange={(id) => setSegment(id as "active" | "archived")}
                  />
                  <span className="flex shrink-0 items-center">
                    <PortalIconAction icon={Settings} label="Communication settings" onClick={() => show("Settings")} />
                    <PortalPrimaryIconAction label="New message" icon={PenSquare} onClick={() => show("New message")} />
                  </span>
                </div>
                <div className="border-b border-border px-3 py-1.5">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    aria-label={searchPlaceholder}
                    className="h-8 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {visible.map((c) => (
                    <InboxConversationRow
                      key={c.id}
                      name={c.name}
                      subtitle={c.subtitle}
                      preview={c.preview}
                      time={c.time}
                      unread={c.unread}
                      selected={c.id === selected?.id}
                      onOpen={() => {
                        setSelectedId(c.id);
                        setOpened(true);
                      }}
                    />
                  ))}
                </div>
              </div>
            }
            thread={
              selected ? (
                <InboxThreadView
                  title={selected.name}
                  subtitle={selected.subtitle}
                  avatarName={selected.name}
                  messages={messages}
                  onBack={() => setOpened(false)}
                  composer={<InboxComposer value={draft} onChange={setDraft} onSubmit={send} placeholder="Write a message…" dataAttr="demo-panel-composer" />}
                />
              ) : null
            }
          />
        </ManagerPortalPageShell>
      </div>
      {toastNode}
    </ProductWindow>
  );
}
