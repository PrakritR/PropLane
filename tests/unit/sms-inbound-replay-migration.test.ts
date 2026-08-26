import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/20260826120000_sms_inbound_replay_state.sql"),
  "utf8",
);

function compactSql(): string {
  return SQL.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

describe("SMS inbound replay migration", () => {
  const sql = compactSql();

  it("deduplicates inbound agent history by provider MessageSid", () => {
    expect(sql).toContain("add column if not exists source_message_sid text");
    expect(sql).toContain("add column if not exists trace_id text");
    expect(sql).toContain(
      "create unique index if not exists agent_messages_sms_user_source_sid_uidx on public.agent_messages (source_message_sid) where source_message_sid is not null and role = 'user'",
    );
  });

  it("stores the exact prepared reply and its agent/action/outbox lineage additively", () => {
    for (const fragment of [
      "add column if not exists route_kind text",
      "add column if not exists counterparty_user_id uuid references auth.users (id) on delete set null",
      "add column if not exists agent_session_id uuid references public.agent_sessions (id) on delete set null",
      "add column if not exists inbound_agent_message_id uuid references public.agent_messages (id) on delete set null",
      "add column if not exists assistant_agent_message_id uuid references public.agent_messages (id) on delete set null",
      "add column if not exists pending_action_id uuid references public.agent_pending_actions (id) on delete set null",
      "add column if not exists turn_trace_id text",
      "add column if not exists reply_body text",
      "add column if not exists reply_prepared_at timestamptz",
      "add column if not exists outbox_id uuid references public.sms_outbox (id) on delete set null",
      "add column if not exists reply_enqueued_at timestamptz",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).toContain("check (reply_body is null or char_length(reply_body) between 1 and 1600)");
  });

  it("prepares a reply only for the live lease and refuses a different second payload", () => {
    expect(sql).toContain("create or replace function public.prepare_sms_inbound_reply");
    expect(sql).toContain("and lease_owner = p_worker_id");
    expect(sql).toContain("and status = 'processing'");
    expect(sql).toContain("and lease_expires_at > now()");
    expect(sql).toContain("reply_body is null or (");
    expect(sql).toContain("route_kind = p_route_kind");
    expect(sql).toContain("pending_action_id is not distinct from p_pending_action_id");
    expect(sql).toContain("turn_trace_id is not distinct from p_turn_trace_id");
    expect(sql).toContain("and reply_body = p_reply_body");
  });

  it("links an outbox only after preparation and makes the first link immutable", () => {
    expect(sql).toContain("create or replace function public.attach_sms_inbound_outbox");
    expect(sql).toContain("and reply_body is not null");
    expect(sql).toContain("and (outbox_id is null or outbox_id = p_outbox_id)");
    expect(sql).toContain("reply_enqueued_at = coalesce(reply_enqueued_at, now())");
  });

  it("keeps both replay mutation RPCs service-role only", () => {
    for (const signature of [
      "public.prepare_sms_inbound_reply(text, text, text, uuid, uuid, uuid, uuid, uuid, text, text)",
      "public.attach_sms_inbound_outbox(text, text, uuid)",
    ]) {
      expect(sql).toContain(`revoke execute on function ${signature} from public, anon, authenticated`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role`);
    }
  });
});
