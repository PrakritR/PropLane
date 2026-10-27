/**
 * "Any work?" on a vendor's OWN number, Oct 26 — written out as the text exchange the vendor actually sees.
 *
 * A reply is capped at two GSM-7 segments, so a long list is trimmed before it goes out. The fact a reviewer
 * cannot see on any screen is that the SAVED list is now exactly the trimmed one: a bare `BID n` resolves only
 * against jobs the vendor was actually shown. Before this, the trimmed-off jobs stayed in the saved list, so
 * "BID 5" could take a job whose title, area and sender never reached the phone.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-own-number-job-list-1026.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.ai" }));
vi.mock("@/lib/tools/vendor-line-context", () => ({ buildVendorLineContext: () => ({}) }));
vi.mock("@/lib/vendor-dispatch/responses.server", () => ({ recordVendorYes: vi.fn() }));
const board = vi.hoisted(() => ({ jobs: [] as Array<Record<string, unknown>>, requested: [] as string[] }));
vi.mock("@/lib/tools/domains/vendor-line", () => ({ runListOpenJobsNear: async () => ({ jobs: board.jobs }) }));
vi.mock("@/lib/service-work-board.server", () => ({
  requestBoardJob: async (_db: unknown, _actor: unknown, input: { ref: string }) => {
    board.requested.push(input.ref);
    return { ok: true };
  },
}));

const { handleOwnNumberWorkText } = await import("@/lib/one-number/vendor-jobs/own-number-work.server");

const VENDOR = "vendor-1";
const PHONE = "+12065550142";
const NOW = new Date("2026-10-26T18:00:00Z");

/* ------------------------------------------------------------------ transcript */

const transcript: string[] = [];
const say = (line = "") => transcript.push(line);
const scene = (title: string) => {
  say();
  say(title);
  say("-".repeat(title.length));
};

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "own-number-job-list-transcript.txt"), `${transcript.join("\n")}\n`);
});

let db: FakeDb;
const text = (body: string, sid: string) =>
  handleOwnNumberWorkText(db as unknown as SupabaseClient, { vendorUserId: VENDOR, phone: PHONE, text: body, messageSid: sid, now: NOW });

/** One exchange, printed the way the vendor's phone shows it. */
async function exchange(body: string, sid: string) {
  const turn = await text(body, sid);
  say(`  vendor →  ${body}`);
  const reply = turn.handled ? turn.reply : "(no reply — the text is not a job-list turn)";
  say(`  PropLane ←  ${reply}`);
  say(`              [${reply.length} characters]`);
  return turn;
}

/** The list the next `BID n` will resolve against, as it was saved. */
const savedEntries = (): Array<{ n: number; title: string }> => {
  const rows = db.tables.agent_messages.filter((m) => m.role === "assistant");
  const trace = (rows.at(-1)?.tool_trace ?? {}) as Row;
  return (Array.isArray(trace.entries) ? trace.entries : []) as Array<{ n: number; title: string }>;
};

beforeEach(() => {
  board.requested.length = 0;
  board.jobs = [
    { title: "Deep clean after a move-out, 3 bed 2 bath", area: "Wallingford", when: "This week", budget: "$240", ref: "SVC-1", serviceId: "wo-1" },
    { title: "Replace a leaking kitchen faucet and trap", area: "U-District", when: "Anytime", budget: "$180", ref: "SVC-2", serviceId: "wo-2" },
    { title: "Gutter clear and downspout flush, two storeys", area: "Ballard", when: "Next week", budget: "$200", ref: "SVC-3", serviceId: "wo-3" },
    { title: "Interior repaint of a studio, walls and trim", area: "Capitol Hill", when: "Nov 2", budget: "$900", ref: "SVC-4", serviceId: "wo-4" },
    { title: "Rebuild a rotted back porch step and rail", area: "Fremont", when: "Nov 9", budget: "$650", ref: "SVC-5", serviceId: "wo-5" },
  ];
  db = createFakeDb({ manager_vendor_records: [], agent_sessions: [], agent_messages: [] });
});

describe("the job list a vendor's own number sends back", () => {
  it("only lists what fits two segments, and a BID resolves against exactly that", async () => {
    scene("SCENE 1 — five jobs are open; the reply is capped at two SMS segments");
    const list = await exchange("any work?", "SM1");
    if (!list.handled) throw new Error("expected a reply");
    const shownNumbers = [...list.reply.matchAll(/(?:^|\s)(\d)\. /g)].map((m) => Number(m[1]));
    say(`              lists jobs ${shownNumbers.join(", ")} of ${board.jobs.length} open`);
    expect(list.reply.length).toBeLessThanOrEqual(300);
    expect(shownNumbers.length).toBeLessThan(board.jobs.length);

    scene("SCENE 2 — what the next reply will resolve against");
    savedEntries().forEach((e) => say(`  saved   ${e.n}. ${e.title}`));
    say(`  (${savedEntries().length} saved, ${shownNumbers.length} sent — the two are the same list)`);
    expect(savedEntries().map((e) => e.n)).toEqual(shownNumbers);

    scene("SCENE 3 — the vendor bids on a job that was trimmed off and never reached their phone");
    const unseen = board.jobs.length;
    const unseenTurn = await exchange(`bid ${unseen}`, "SM2");
    say(`              board requests made: ${board.requested.length === 0 ? "none" : board.requested.join(", ")}`);
    expect(unseenTurn).toMatchObject({ handled: true });
    expect(unseenTurn.handled && unseenTurn.reply).toContain(`I do not have a job ${unseen} on that list`);
    expect(board.requested).toEqual([]);

    scene("SCENE 4 — a job that WAS listed takes the bid");
    const seen = shownNumbers.at(-1)!;
    const seenTurn = await exchange(`bid ${seen}`, "SM3");
    say(`              board requests made: ${board.requested.join(", ")}`);
    expect(seenTurn.handled && seenTurn.reply).toContain("Requested:");
    expect(board.requested).toEqual([`SVC-${seen}`]);
  });
});
