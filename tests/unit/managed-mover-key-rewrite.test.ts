import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { houseThreadId } from "@/lib/house-thread-id";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { teamThreadId, workspaceTeamThreadId } from "@/lib/team-thread-id";

/**
 * The ownership mover re-points owner COLUMNS; several stored TEXT KEYS embed the old owner's user id and must be rewritten in the
 * same transaction or the history goes invisible and a second thread is minted (supabase/migrations/20261112240000_*). This reads
 * the migration (like managed-move-classification.test.ts) and checks each key shape against its real generator.
 */
const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const FILE = "20261112240000_managed_mover_key_rewrite.sql";
const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const FROM = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

function fn(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThanOrEqual(0);
  const next = sql.indexOf("create or replace function", start + 10);
  return sql.slice(start, next < 0 ? undefined : next);
}

/** Same rules as `managed_move_rekey`, derived from the migration's own prefixes (checked below), to test each generator's output. */
function prefixesInRekey(): string[] {
  return [...fn("managed_move_rekey").matchAll(/'([a-z0-9_-]+:)' \|\| p_from::text/g)].map((m) => m[1]!);
}

describe("managed mover key rewrite: every owner-embedding key shape", () => {
  it("rewrites the bare `<owner>:` conversation key and each owner-prefixed id family", () => {
    const body = fn("managed_move_rekey");
    expect(body).toMatch(/starts_with\(p_value, p_from::text \|\| ':'\)/);
    expect(prefixesInRekey()).toEqual(expect.arrayContaining(["smsv2:", "team-thread:", "house-thread:"]));
  });

  it("matches what the real generators emit", () => {
    const prefixes = prefixesInRekey();
    const emitted = [
      workspaceTeamThreadId(FROM, WS),
      teamThreadId(FROM, "prop-1"),
      teamThreadId(FROM),
      houseThreadId(FROM, WS, "prop-1"),
    ];
    for (const id of emitted) expect(prefixes.some((p) => id.startsWith(`${p}${FROM}`)), id).toBe(true);
    const key = buildConversationKey({ ownerManagerUserId: FROM, role: "resident", counterpartyPhone: "+12065550100" });
    expect(key.startsWith(`${FROM}:`)).toBe(true);
  });

  it("recomputes the SMS notice id from the row's own phone and never guesses", () => {
    const gen = readFileSync(path.join(process.cwd(), "src/lib/sms-inbox-notice.server.ts"), "utf8");
    expect(gen).toMatch(/sms_notice_\$\{createHash\("sha256"\)\.update\(`\$\{managerUserId\}:\$\{phone\}`\)/);
    const plan = fn("managed_move_thread_plan");
    expect(plan).toMatch(/'sms_notice_' \|\| encode\(sha256\(convert_to\(p_from::text \|\| ':' \|\| ph, 'UTF8'\)\), 'hex'\)/);
    expect(plan).toMatch(/'sms_notice_' \|\| encode\(sha256\(convert_to\(p_to::text \|\| ':' \|\| ph, 'UTF8'\)\), 'hex'\)/);
  });

  it("plans Team chat, House chat and both legacy Team ids, and reports a collision instead of merging", () => {
    const plan = fn("managed_move_thread_plan");
    for (const shape of ["'team'", "'house'", "'legacy_team_house'", "'legacy_team'", "'sms_notice'"]) expect(plan).toContain(shape);
    expect(plan).toContain("'id_exists'");
    expect(plan).toContain("'conversation_key_exists'");
    expect(sql).toMatch(/key_collision:/);
  });

  it("never moves or renames a per-person Assistant (agent_notice) thread", () => {
    expect(fn("managed_move_thread_plan")).toMatch(/left\(t\.id, 13\) <> 'agent_notice_' and t\.thread_type is distinct from 'agent_notice'/);
    expect(fn("managed_move_scope_predicate")).toMatch(/left\(id, 13\) <> ''agent_notice_'' and thread_type is distinct from ''agent_notice''/);
    expect("agent_notice_".length).toBe(13);
  });

  it("renames an inbox thread without a unique-slot collision and carries row_data.id and the FK children", () => {
    const body = fn("managed_move_rename_inbox_thread");
    expect(body).toMatch(/'conversation_key', null/);
    expect(body).toMatch(/jsonb_set\(r\.row_data, '\{id\}'/);
    expect(body).toMatch(/update public\.portal_inbox_thread_aliases set thread_id = p_new/);
    expect(body).toMatch(/update public\.inbox_message_provider_refs set thread_record_id = p_new/);
  });

  it("points a column that REFERENCES a renamed thread at the plan's newId, never a re-derivation", () => {
    const mover = fn("move_managed_workspace_to_service_owner");
    const from = mover.indexOf("managed_move_thread_ref_columns() c loop", mover.indexOf("---- text keys"));
    expect(from).toBeGreaterThan(0);
    const loop = mover.slice(from, mover.indexOf("v_keyrw :=", from));
    // An `sms_notice_*` id is a sha256, so `managed_move_rekey` returns it unchanged: rewriting a reference with it
    // would leave every pointer on the row the rename just deleted, and the stash would record newId == oldId.
    expect(loop).toMatch(/jsonb_to_recordset\(v_plan\) as x\("oldId" text, "newId" text\)/);
    expect(loop).toMatch(/set %I = \$2 where %I = \$1/);
    expect(loop).not.toMatch(/set %I = public\.managed_move_rekey/);
    expect(loop).toMatch(/'oldId', rp\.old_id, 'newId', rp\.new_id/);
    // ... and the undo puts each reference back on the id it came from.
    expect(fn("undo_managed_workspace_move")).toMatch(/update public\.%I set %I = \$1 where %I = \$2'\, kr\.tbl, kr\.col, kr\.col\) using kr\."oldId", kr\."newId"/);
  });

  it("keeps every guard and the allowlist in the replaced mover, and stashes the old keys for the undo", () => {
    const mover = fn("move_managed_workspace_to_service_owner");
    for (const stop of ["workspace_not_service", "owner_is_not_expected_from", "open_checkout_attempts", "pending_withdrawals", "unclassified_table", "another_owner_of_record_seated", "client_holds_a_non_owner_seat"]) {
      expect(mover, stop).toContain(stop);
    }
    expect(mover).toMatch(/select owner_user_id into v_to from public\.platform_service_settings/);
    expect(mover).not.toMatch(/\bp_to\b/);
    expect(mover).toMatch(/'keyRewrites', v_key_counts/);
    expect(mover).toMatch(/'keyRewrites', v_keyrw/);
    expect(mover).not.toMatch(/property_data/);
    const undo = fn("undo_managed_workspace_move");
    expect(undo).toMatch(/keyRewrites,sms/);
    expect(undo).toMatch(/keyRewrites,threads/);
    expect(undo).toMatch(/keyRewrites,threadRefs/);
    expect(sql).toMatch(/revoke all on function public\.move_managed_workspace_to_service_owner\(uuid, uuid, boolean\) from public, anon, authenticated/);
    expect(sql).toMatch(/grant execute on function public\.move_managed_workspace_to_service_owner\(uuid, uuid, boolean\) to service_role/);
  });
});

describe("managed mover key columns cover every stored conversation key", () => {
  const IDENTITY = ["manager_user_id", "owner_user_id", "owner_manager_user_id", "landlord_id"];
  const KEY_COLUMN = /^(conversation_key|legacy_conversation_key|identity_key|alias_value)$/;
  const listed = [...fn("managed_move_key_columns").matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);

  function schema(): Map<string, Set<string>> {
    const tables = new Map<string, Set<string>>();
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const text = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      for (const m of text.matchAll(/create table\s+(?:if not exists\s+)?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
        const cols = tables.get(m[1]!.toLowerCase()) ?? new Set<string>();
        for (const line of m[2]!.split("\n")) {
          const c = /^\s*([a-z_]+)\s+(uuid|text|citext|varchar)\b/i.exec(line);
          if (c) cols.add(c[1]!.toLowerCase());
        }
        tables.set(m[1]!.toLowerCase(), cols);
      }
      for (const m of text.matchAll(/alter table\s+(?:if exists\s+)?(?:public\.)?([a-z_]+)([\s\S]*?);/gi)) {
        const cols = tables.get(m[1]!.toLowerCase());
        if (!cols) continue;
        for (const c of m[2]!.matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)\s+(uuid|text|citext)\b/gi)) cols.add(c[1]!.toLowerCase());
      }
    }
    return tables;
  }

  it("lists the generators' tables", () => {
    for (const k of [
      "inbound_sms_log.conversation_key", "manager_sms_messages.conversation_key", "sms_outbox.conversation_key",
      "manager_sms_conversation_houses.conversation_key", "prospect_tour_scheduling_state.conversation_key",
      "prospect_sms_tour_reminders.conversation_key", "sms_projection_conversations.legacy_conversation_key",
      "sms_projection_conversations.identity_key", "sms_projection_aliases.alias_value",
    ]) expect(listed, k).toContain(k);
  });

  it("fails when a MOVE/ACCOUNT table gains a conversation-key-like column that is not rewritten", () => {
    const classification = readFileSync(path.join(MIGRATIONS_DIR, "20261112230000_managed_workspace_mover.sql"), "utf8");
    const klass = new Map([...classification.matchAll(/\('([a-z_]+)',\s*'(move|account|keep|special)',\s*'[a-z_]+'\)/g)].map((m) => [m[1]!, m[2]!]));
    const missing: string[] = [];
    for (const [table, cols] of schema()) {
      if (!IDENTITY.some((c) => cols.has(c))) continue;
      // portal_inbox_thread_records.conversation_key is `mail:` / `acct:` / `ws:` / `house:<property>`: it never embeds an owner id.
      if (table === "portal_inbox_thread_records") continue;
      if (!["move", "account"].includes(klass.get(table) ?? "")) continue; // KEEP tables are the client's own history, never written
      for (const c of cols) if (KEY_COLUMN.test(c) && !listed.includes(`${table}.${c}`)) missing.push(`${table}.${c}`);
    }
    expect(missing.sort(), "add to managed_move_key_columns() (and the dry-run counts) or classify as KEEP").toEqual([]);
  });

  it("only names columns that exist", () => {
    const s = schema();
    for (const k of listed) {
      const [t, c] = k.split(".") as [string, string];
      const cols = s.get(t);
      if (cols) expect(cols.has(c), k).toBe(true);
    }
  });
});
