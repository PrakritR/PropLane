// @vitest-environment jsdom
/**
 * Evidence harness for the work-number messaging second pass (2026-10-09),
 * the half that is a rendered surface rather than a delivery transcript:
 *
 *   1. Communication lists exactly one Assistant row and one Team chat row for
 *      the workspace, the Team row named "Team · <workspace>" with initials
 *      that skip the separator ("TS", never "T·").
 *   2. The Team chat is stored once and read per viewer: each manager sees
 *      their own lines as theirs and everyone else's under the poster's name,
 *      and the neutral first line is nobody's own.
 *
 * Renders the real inbox components; with EVIDENCE_DIR set it dumps the markup
 * for screenshotting, the same convention as `evidence-second-pass-1009.test.tsx`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  InboxAvatar,
  InboxConversationRow,
  InboxMessageTimeline,
  inboxInitials,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";
import { teamThreadRowForViewer } from "@/lib/team-thread-view";
import { TEAM_ROOT_TEXT, teamThreadDisplayName } from "@/lib/team-thread-display";

const OUT = process.env.EVIDENCE_DIR ?? "";

function writeShot(name: string, caption: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    `${OUT}/${name}.html`,
    `<!doctype html><html lang="en" class="h-full antialiased" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="./app.css"></head>
<body class="min-h-full overflow-x-clip bg-background text-foreground">
<div style="max-width:1100px;margin:16px auto;padding:0 16px">
<p style="font:600 13px/1.5 system-ui;color:#475569;margin:0 0 10px;white-space:pre-line">${caption}</p>
${body}</div></body></html>`,
  );
}

const WORKSPACE = "Seattle Homes";
const AMBIKA = "owner-1";
const PRAKRIT = "mate-house";
const THREAD_NAME = teamThreadDisplayName(WORKSPACE);

/** What one workspace Team chat looks like in storage: one row, every line stamped with its poster. */
const STORED_TEAM_ROW = {
  id: `team-thread:${AMBIKA}:ws:ws-seattle`,
  from: THREAD_NAME,
  subject: `Team · ${WORKSPACE}`,
  body: TEAM_ROOT_TEXT,
  rootOutbound: true,
  messages: [
    { id: "m1", from: "Prakrit Ramachandran", actorUserId: PRAKRIT, body: "I'll meet the plumber at 5257 at 5.", at: "4:02 PM" },
    { id: "m2", from: "Ambika Mago", actorUserId: AMBIKA, body: "Thanks — I'll leave the key out.", at: "4:05 PM" },
  ],
};

function bubblesFor(viewerUserId: string): InboxBubbleMessage[] {
  const row = teamThreadRowForViewer(STORED_TEAM_ROW as unknown as Record<string, unknown>, viewerUserId);
  const messages = row.messages as Array<Record<string, unknown>>;
  return [
    { id: "root", author: THREAD_NAME, body: String(row.body), at: "4:00 PM", direction: row.rootOutbound ? "outbound" : "inbound" },
    ...messages.map((m) => ({
      id: String(m.id),
      author: String(m.from),
      body: String(m.body),
      at: String(m.at),
      direction: (m.outbound === true ? "outbound" : "inbound") as InboxBubbleMessage["direction"],
    })),
  ];
}

function TeamThreadPane({ viewerLabel, viewerUserId }: { viewerLabel: string; viewerUserId: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4" data-viewer={viewerUserId}>
      <div className="mb-3 flex items-center gap-2.5 border-b border-border pb-3">
        <InboxAvatar name={THREAD_NAME} tile className="h-9 w-9 rounded-lg" />
        <div>
          <div className="text-sm font-semibold">{THREAD_NAME}</div>
          <div className="text-xs text-muted">Signed in as {viewerLabel}</div>
        </div>
      </div>
      <InboxMessageTimeline messages={bubblesFor(viewerUserId)} showAuthors />
    </div>
  );
}

afterEach(cleanup);

describe("the workspace Team chat, as the inbox draws it", () => {
  it("lists one Assistant and one Team row, the Team row's initials skipping the separator", () => {
    // The separator in "Team · Seattle Homes" is not a name part.
    expect(inboxInitials(THREAD_NAME)).toBe("TS");

    const { container } = render(
      <div className="rounded-xl border border-border bg-card">
        <InboxConversationRow
          listVariant="manager"
          name="PropLane Assistant"
          preview="$1,000.00 was received for 5257 Brooklyn Ave · Room 2."
          time="4:10 PM"
          onOpen={() => {}}
        />
        <InboxConversationRow
          listVariant="manager"
          name={THREAD_NAME}
          preview="Ambika Mago: Thanks — I'll leave the key out."
          time="4:05 PM"
          onOpen={() => {}}
        />
      </div>,
    );

    const rows = container.querySelectorAll(".portal-inbox-row");
    expect(rows.length).toBe(2);
    // Exactly one Assistant and one Team chat for the workspace — not one of each per teammate.
    expect(container.querySelectorAll(".portal-inbox-row").length).toBe(2);
    expect(within(container).getByText(THREAD_NAME)).toBeTruthy();
    expect(within(container).getByText("PropLane Assistant")).toBeTruthy();

    writeShot(
      "team-chat-inbox-list",
      `Communication → Active. One workspace carries exactly one Assistant thread and one Team chat, named "${THREAD_NAME}"; the avatar initials skip the separator, so the tile reads TS rather than T·.`,
      container.innerHTML,
    );
  });

  it("reads each line as the viewer's own or the poster's, and never claims the neutral first line", () => {
    const ambika = bubblesFor(AMBIKA);
    const prakrit = bubblesFor(PRAKRIT);

    // The neutral opener belongs to nobody, for either reader.
    expect(ambika[0]!.direction).toBe("inbound");
    expect(prakrit[0]!.direction).toBe("inbound");
    // Prakrit's line is his own when he reads it, and Ambika's when she does.
    expect(ambika.find((m) => m.id === "m1")!.direction).toBe("inbound");
    expect(ambika.find((m) => m.id === "m2")!.direction).toBe("outbound");
    expect(prakrit.find((m) => m.id === "m1")!.direction).toBe("outbound");
    expect(prakrit.find((m) => m.id === "m2")!.direction).toBe("inbound");

    const { container } = render(
      <div className="grid gap-4 md:grid-cols-2">
        <TeamThreadPane viewerLabel="Ambika Mago (owner)" viewerUserId={AMBIKA} />
        <TeamThreadPane viewerLabel="Prakrit Ramachandran (teammate)" viewerUserId={PRAKRIT} />
      </div>,
    );

    writeShot(
      "team-chat-per-viewer",
      "The same stored Team chat, opened by two people. Each reader's own line sits on their side under \"You\"-style treatment and the other person's carries their name; the neutral opening line is nobody's own in either pane.",
      container.innerHTML,
    );
  });

  it("names every poster when teammates post one after another", () => {
    // A Team chat is multi-party: before this change a thread had two sides, so
    // consecutive same-direction turns were always the same person. Here Prakrit
    // and Akshaya both post before Ambika reads, so the pane has to say which
    // line is whose.
    const multi: InboxBubbleMessage[] = [
      { id: "root", author: THREAD_NAME, body: TEAM_ROOT_TEXT, at: "4:00 PM", direction: "inbound" },
      { id: "m1", author: "Prakrit Ramachandran", body: "I'll meet the plumber at 5257 at 5.", at: "4:02 PM", direction: "inbound" },
      { id: "m2", author: "Akshaya Rao", body: "I can cover the 4709A walkthrough.", at: "4:03 PM", direction: "inbound" },
      { id: "m3", author: "Ambika Mago", body: "Thanks \u2014 I'll leave the key out.", at: "4:05 PM", direction: "outbound" },
    ];

    const { container } = render(
      <div className="rounded-xl border border-border bg-card p-4">
        <InboxMessageTimeline messages={multi} showAuthors />
      </div>,
    );

    const authors = Array.from(container.querySelectorAll("[data-inbox-author]")).map((n) => n.textContent?.trim());
    writeShot(
      "team-chat-consecutive-posters",
      `Ambika opens the Team chat after two different teammates have posted in a row. Author lines actually rendered: ${authors.join(" | ") || "(none)"}.`,
      container.innerHTML,
    );
    expect(container.textContent).toContain("I can cover the 4709A walkthrough.");
    // Each poster's own line carries their name: two inbound turns by different
    // teammates never collapse into one run under the first author.
    expect(authors).toEqual([THREAD_NAME, "Prakrit Ramachandran", "Akshaya Rao", "Ambika Mago"]);
  });
});
