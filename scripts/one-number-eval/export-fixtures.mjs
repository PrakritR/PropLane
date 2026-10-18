#!/usr/bin/env node
/**
 * Export redacted eval cases from the DEV/TEST database.
 *
 *   node --env-file=.env.local scripts/one-number-eval/export-fixtures.mjs [--limit 60] [--out path]
 *
 * Reads agent sessions and messages, the SMS inbound log and approved knowledge entries, strips PII
 * (names, phones, emails, addresses, links, long digit runs) and writes `fixtures/exported/*.json`
 * (git-ignored: review a file by hand before copying any case into a committed fixture).
 *
 * Refuses to run against anything but the dev/test project. Never writes to the database.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { extractKeyFacts, knowledgeEntryToCase } from "./cases.mjs";
import { looksLikePii, redactConversation, redactText } from "./redact.mjs";

const DEV_REF = "emstjswhotsnyksqhqyf";
const REFUSED_REFS = ["xwszcafaontidfgznlxd", "qahnczmilgptcedaqype"];

export function assertDevOnly(url) {
  const value = String(url ?? "");
  if (REFUSED_REFS.some((ref) => value.includes(ref))) {
    throw new Error("Refusing to export from a staging or production project.");
  }
  if (!value.includes(DEV_REF)) {
    throw new Error(`Refusing to export: ${value || "no Supabase URL"} is not the dev/test project.`);
  }
}

const ESCALATION_TOOLS = ["escalate_to_manager", "escalate_leasing_to_manager", "send_message_to_manager", "handoff_to_vendor"];

function roleForKind(kind) {
  const k = String(kind ?? "");
  if (k.startsWith("leasing_sms")) return "prospect";
  if (k.startsWith("resident_sms")) return "resident";
  if (k.startsWith("manager_sms")) return "manager";
  if (k.startsWith("vendor")) return "vendor";
  return null;
}

function parseArgs(argv) {
  const out = { limit: 60, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--limit") out.limit = Number(argv[++i]) || out.limit;
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

async function main() {
  const { limit, out } = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  assertDevOnly(url);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
  const db = createClient(url, key, { auth: { persistSession: false } });

  const cases = [];

  const { data: sessions } = await db
    .from("agent_sessions")
    .select("id, kind, user_id, updated_at")
    .or("kind.like.leasing_sms%,kind.like.resident_sms%,kind.like.manager_sms%,kind.like.vendor%")
    .order("updated_at", { ascending: false })
    .limit(limit);
  for (const session of sessions ?? []) {
    const role = roleForKind(session.kind);
    if (!role) continue;
    const { data: messages } = await db
      .from("agent_messages")
      .select("role, content, tool_trace, created_at")
      .eq("session_id", session.id)
      .order("created_at", { ascending: true })
      .limit(40);
    const rows = messages ?? [];
    const lastUser = [...rows].reverse().findIndex((m) => m.role === "user");
    if (lastUser === -1) continue;
    const userIndex = rows.length - 1 - lastUser;
    const reply = rows.slice(userIndex + 1).find((m) => m.role === "assistant");
    const { data: profile } = session.user_id
      ? await db.from("profiles").select("full_name").eq("id", session.user_id).maybeSingle()
      : { data: null };
    const known = [profile?.full_name].filter(Boolean);
    const userTurns = rows.filter((m) => m.role === "user").slice(-3).map((m) => String(m.content ?? ""));
    const turns = redactConversation(userTurns, known);
    const escalated = Array.isArray(reply?.tool_trace) && reply.tool_trace.some((t) => ESCALATION_TOOLS.includes(String(t?.tool ?? t)));
    cases.push({
      id: `session-${String(session.id).slice(0, 8)}`,
      role,
      source: "session",
      workspace: "A",
      turns,
      expect: { escalate: escalated ? true : null, maxSegments: 2 },
      ...(reply ? { observed: redactText(String(reply.content ?? ""), new Map(), known) } : {}),
    });
  }

  const { data: log } = await db.from("inbound_sms_log").select("body").order("created_at", { ascending: false }).limit(limit);
  const seen = new Set();
  for (const row of log ?? []) {
    const text = redactText(String(row.body ?? ""), new Map());
    if (!text.trim() || text.length < 8 || seen.has(text)) continue;
    seen.add(text);
    cases.push({ id: `sms-${cases.length}`, role: "prospect", source: "sms_log", workspace: "A", turns: [text], expect: { maxSegments: 2 } });
  }

  const { data: entries } = await db.from("property_knowledge_entries").select("id, workspace_id, property_id, question, answer, audience").eq("status", "approved").limit(limit);
  for (const entry of entries ?? []) {
    const c = knowledgeEntryToCase(entry);
    c.turns = c.turns.map((t) => redactText(t, new Map()));
    c.knowledge = c.knowledge.map((e) => ({ ...e, question: redactText(e.question, new Map()), answer: redactText(e.answer, new Map()) }));
    c.expect.facts = extractKeyFacts(c.knowledge[0].answer);
    c.workspace = "A";
    cases.push(c);
  }

  const clean = cases.filter((c) => !c.turns.some(looksLikePii));
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "exported");
  mkdirSync(dir, { recursive: true });
  const file = out ?? join(dir, `export-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
  console.log(JSON.stringify({ file, exported: clean.length, droppedForPii: cases.length - clean.length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
