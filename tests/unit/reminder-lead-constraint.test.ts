import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_RULES, REMINDER_SUBJECT_KINDS } from "@/lib/reminders/rules";

/**
 * Every "after" reminder was silently unqueueable for as long as directional
 * timings have existed.
 *
 * `reminderSendTimes` encodes a timing as a signed lead — negative means after
 * the anchor — while the table's check constraint accepted `between 5 and
 * 43200`, positive only, with one hardcoded carve-out for `tour_interest` at
 * exactly -1440. Eleven kinds default to an `after:` timing, so their rows died
 * on a 23514 violation at insert and the queue just stayed empty.
 *
 * Nothing connected the shape the code produces to the shape the database
 * accepts, which is why this survived. This test is that connection: it reads
 * the live constraint out of the migrations and checks every lead the default
 * rules can actually generate against it.
 */

const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/** The last migration that redefines the lead constraint wins at runtime. */
function currentLeadConstraint(): string {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let latest = "";
  for (const file of files) {
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    const add = sql.match(
      /add constraint portal_reminder_records_lead_check\s+check \(([\s\S]*?)\);/i,
    );
    if (add) latest = add[1].replace(/\s+/g, " ").trim();
  }
  return latest;
}

/** Mirrors rules.ts: "before" is positive, "after" is negative. */
function leadFor(timing: string): number {
  const [direction, raw] = timing.split(":");
  const minutes = Number(raw);
  return direction === "before" ? minutes : -minutes;
}

describe("portal_reminder_records lead constraint", () => {
  const constraint = currentLeadConstraint();

  it("is defined by a migration", () => {
    expect(constraint).not.toBe("");
  });

  it("accepts a signed lead in either direction", () => {
    // The magnitude bounds are the real rule; the sign only carries direction.
    expect(constraint).toMatch(/abs\(lead_minutes\) between 5 and 129600/i);
  });

  it("does not decide validity from the kind", () => {
    // The old constraint carved out exactly one kind at exactly one value, so
    // every other after-timing was rejected and adding a kind meant editing it.
    expect(constraint).not.toMatch(/kind\s*=/i);
  });

  it("accepts every lead the default rules can generate", () => {
    const rejected: string[] = [];
    for (const kind of REMINDER_SUBJECT_KINDS) {
      for (const timing of DEFAULT_REMINDER_RULES[kind]?.timings ?? []) {
        const lead = leadFor(timing);
        const magnitude = Math.abs(lead);
        if (!(magnitude >= 5 && magnitude <= 129600)) {
          rejected.push(`${kind} ${timing} -> ${lead}`);
        }
      }
    }
    expect(rejected).toEqual([]);
  });

  it("covers the after-direction kinds that were dead", () => {
    const afterKinds = REMINDER_SUBJECT_KINDS.filter((kind) =>
      (DEFAULT_REMINDER_RULES[kind]?.timings ?? []).some((t) => t.startsWith("after:")),
    );
    // If this drops to a handful, the defaults changed and the regression this
    // test guards may no longer be reachable — re-read before relaxing it.
    expect(afterKinds.length).toBeGreaterThanOrEqual(9);
  });
});
