/**
 * Evidence transcript for the upstream Cursor commit merged into claude-1: an
 * Airbnb mail that names NOBODY (a payout, or a booking confirmation with no
 * guest name) must never put the "Airbnb guest · HM…" label back over a name a
 * person typed in Residents — while a mail that DOES name the guest still fills
 * a placeholder the sync invented.
 *
 * Driven through the REAL `applyAirbnbEmailToStay`, over the same fake
 * PostgREST the unit suite uses, and the resident row's stored name is printed
 * before and after each mail:
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-airbnb-resident-name-1017.test.ts
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { applyAirbnbEmailToStay } from "@/lib/channel-calendar/airbnb-email-intake.server";

type Row = Record<string, unknown>;

/** Reads `row_data->>key` like PostgREST does; every other column is a plain key. */
function column(row: Row, col: string): unknown {
  const at = col.indexOf("->>");
  if (at < 0) return row[col];
  const data = row[col.slice(0, at)] as Row | undefined;
  return data?.[col.slice(at + 3)];
}

/** Just the chain shapes the resident writers issue. */
function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  const from = (table: string) => {
    const master = (tables[table] ??= []);
    let working = [...master];
    let op: "select" | "upsert" | "update" | "delete" = "select";
    let payload: Row = {};
    let conflict = "id";
    const q: Record<string, unknown> = {
      select: () => q,
      limit: () => q,
      eq: (col: string, val: unknown) => {
        working = working.filter((r) => column(r, col) === val);
        return q;
      },
      upsert: (row: Row, opts?: { onConflict?: string }) => {
        op = "upsert";
        payload = row;
        conflict = opts?.onConflict ?? "id";
        return q;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return q;
      },
      delete: () => {
        op = "delete";
        return q;
      },
      maybeSingle: async () => ({ data: working[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (op === "upsert") {
          const keys = conflict.split(",").map((k) => k.trim());
          const existing = master.find((r) => keys.every((k) => r[k] === payload[k]));
          if (existing) Object.assign(existing, payload);
          else master.push({ ...payload });
        } else if (op === "update") {
          for (const r of working) Object.assign(r, payload);
        } else if (op === "delete") {
          const ids = new Set(working);
          const rest = master.filter((r) => !ids.has(r));
          master.length = 0;
          master.push(...rest);
        }
        return Promise.resolve({ data: op === "select" ? working : null, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}

const CODE = "HMHW5SHXRB";
const connection = {
  id: "c1",
  manager_user_id: "mgr-1",
  property_id: "p1",
  room_id: "r1",
  provider: "airbnb",
  label: "Room 9",
  import_url: "https://x",
  export_token: "t",
  imported_ranges: [
    { id: "uid-1", sourceUid: "uid-1", summary: "Reserved", start: "2099-10-13", end: "2099-10-16", reservationCode: CODE },
  ],
  last_synced_at: null,
  last_error: null,
  export_last_fetched_at: null,
};

/** The resident row the Airbnb sync files, with whatever name it currently carries. */
function tablesWithResidentNamed(name: string, email = "airbnb.c1.uid1@import.proplane.local") {
  return {
    external_calendar_connections: [{ ...connection }],
    channel_stay_details: [] as Row[],
    manager_application_records: [
      {
        id: "axis-1",
        manager_user_id: "mgr-1",
        resident_email: email,
        row_data: { id: "axis-1", name, icalConnectionId: "c1", icalSourceUid: "uid-1", application: { fullLegalName: name } },
      },
    ] as Row[],
  };
}

const residentName = (tables: { manager_application_records: Row[] }) =>
  String((tables.manager_application_records[0]!.row_data as Row).name);

const log: string[] = [];
const say = (line = "") => log.push(line);

afterAll(() => {
  const out = process.env.EVIDENCE_DIR ?? "";
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/airbnb-resident-name-on-mail.txt`, `${log.join("\n")}\n`, "utf8");
});

describe("evidence · an Airbnb mail that names nobody never overwrites a person's name", () => {
  it("keeps the manager's typed name through a payout mail, and a named booking still fills a placeholder", async () => {
    say("Airbnb mail → Residents row name (real applyAirbnbEmailToStay, reservation HMHW5SHXRB)");
    say("=".repeat(78));

    // 1. The manager renamed the imported stay in Residents.
    const typed = tablesWithResidentNamed("Maria Lopez");
    say("");
    say("1. Manager typed the guest's name in Residents");
    say(`   before: resident name = "${residentName(typed)}"`);
    await applyAirbnbEmailToStay(fakeDb(typed), "mgr-1", { kind: "payout", confirmationCode: CODE, payoutCents: 41_200 }, "2099-10-09T00:00:00.000Z");
    say("   mail:   payout notification (no guest name)");
    say(`   after:  resident name = "${residentName(typed)}"   ← kept, never "Airbnb guest · ${CODE}"`);
    expect(residentName(typed)).toBe("Maria Lopez");
    expect(((typed.manager_application_records[0]!.row_data as Row).application as Row).fullLegalName).toBe("Maria Lopez");
    expect(typed.channel_stay_details[0]).toMatchObject({ payout_cents: 41_200 });

    // 2. A booking confirmation that names nobody is the same story.
    const typedAgain = tablesWithResidentNamed("Maria Lopez");
    say("");
    say("2. Booking confirmation mail that names nobody");
    say(`   before: resident name = "${residentName(typedAgain)}"`);
    await applyAirbnbEmailToStay(fakeDb(typedAgain), "mgr-1", { kind: "booking", confirmationCode: CODE }, "2099-10-09T00:00:00.000Z");
    say(`   after:  resident name = "${residentName(typedAgain)}"   ← still the typed name`);
    expect(residentName(typedAgain)).toBe("Maria Lopez");

    // 3. The label the sync itself invented IS replaced by the same mail.
    const placeholder = tablesWithResidentNamed("Reserved");
    say("");
    say("3. Same mail over the label the sync invented");
    say(`   before: resident name = "${residentName(placeholder)}"`);
    await applyAirbnbEmailToStay(fakeDb(placeholder), "mgr-1", { kind: "booking", confirmationCode: CODE }, "2099-10-09T00:00:00.000Z");
    say(`   after:  resident name = "${residentName(placeholder)}"   ← a placeholder is still replaced`);
    expect(residentName(placeholder)).toBe(`Airbnb guest · ${CODE}`);

    // 4. A mail that really names the guest still wins over a typed name.
    const named = tablesWithResidentNamed("Maria Lopez");
    say("");
    say("4. Booking mail that DOES name the guest");
    say(`   before: resident name = "${residentName(named)}"`);
    await applyAirbnbEmailToStay(fakeDb(named), "mgr-1", { kind: "booking", confirmationCode: CODE, guestFirstName: "Juan" }, "2099-10-09T00:00:00.000Z");
    say(`   after:  resident name = "${residentName(named)}"   ← Airbnb's own guest name wins`);
    expect(residentName(named)).toBe("Juan");

    // 5. A row a real person signed in on is never touched at all.
    const account = tablesWithResidentNamed("Juan Angel", "juan@example.com");
    say("");
    say("5. Resident row a real person attached an account to");
    say(`   before: resident name = "${residentName(account)}" (resident_email juan@example.com)`);
    await applyAirbnbEmailToStay(fakeDb(account), "mgr-1", { kind: "booking", confirmationCode: CODE, guestFirstName: "Juan" }, "2099-10-09T00:00:00.000Z");
    say(`   after:  resident name = "${residentName(account)}"   ← a person's own row is never renamed`);
    expect(residentName(account)).toBe("Juan Angel");
  });
});
