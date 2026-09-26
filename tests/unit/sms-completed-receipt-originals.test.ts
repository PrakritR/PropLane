import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../supabase/migrations/20260926150000_sms_completed_receipt_originals.sql", import.meta.url), "utf8");
const resolver = migration.slice(0, migration.indexOf("-- The importer body below"));
const importer = migration.slice(migration.indexOf("create or replace function public.import_sms_projection_historical_event"));

describe("completed receipt original authority", () => {
  it("is service-only, uses a fixed search path and allows retained pending originals", () => {
    expect(resolver).toContain("security definer set search_path = public, pg_temp");
    expect(resolver).toContain("v_receipt.status in ('completed','processing','retryable') and v_log_count = 1");
    expect(resolver).toContain("v_receipt.inbound_payload is not null");
    expect(resolver).toContain("revoke all on function public.resolve_sms_completed_receipt_original(text,uuid) from public, anon, authenticated");
    expect(resolver).toContain("grant execute on function public.resolve_sms_completed_receipt_original(text,uuid) to service_role");
    expect(resolver).not.toMatch(/https?:\/\//);
  });

  it("checks exact source, sender, owner, role, wire, line epoch and original receipt time", () => {
    for (const clause of [
      "v_log_count > 1", "v_ingress_count > 1", "v_log.manager_user_id is distinct from v_owner",
      "v_log.body is distinct from v_body", "v_log.from_phone is distinct from v_from",
      "v_log.to_phone is distinct from v_to", "v_burst.counterparty_role <> 'prospect'",
      "v_ingress.manager_user_id is distinct from v_burst.manager_user_id",
      "v_burst.counterparty_phone_e164 is distinct from v_from",
      "v_burst.reply_from_number is distinct from v_to", "v_line_count <> 1",
      "'occurredAt',v_receipt.first_received_at",
    ]) expect(resolver).toContain(clause);
    expect(importer.match(/public\.resolve_sms_completed_receipt_original\(/g)).toHaveLength(2);
    expect(importer).toContain("sms_projection_deleted_events");
    expect(importer).toContain("sms-projection-owner:");
  });

  it("uses NULL-safe payload and sender checks and proves one exact holder/workspace line", () => {
    expect(resolver).toContain("jsonb_typeof(v_receipt.inbound_payload->'body') is distinct from 'string'");
    expect(resolver).toContain("jsonb_typeof(v_receipt.inbound_payload->'fromPhone') is distinct from 'string'");
    expect(resolver).toContain("jsonb_typeof(v_receipt.inbound_payload->'toPhone') is distinct from 'string'");
    expect(resolver).toContain("v_sender_key is distinct from v_receipt.recipient_phone_key");
    expect(resolver).toContain("n.manager_user_id=v_receipt.manager_user_id");
    expect(resolver).toContain("w.owner_user_id end)=v_owner");
    expect(resolver).toContain("select count(*), (array_agg(n.id))[1] into v_line_count,v_line_id");
    expect(resolver).toContain("'workLineId',v_line_id");
    expect(migration).not.toContain("sms_inbound_receipts_full_cursor_idx");
    expect(migration).toMatch(/create index if not exists sms_inbound_receipts_payload_cursor_idx\s+on public\.sms_inbound_receipts \(first_received_at,message_sid\)\s+where inbound_payload is not null;/);
    expect(migration).toContain("manager_sms_numbers_historic_phone_epoch_idx");
    expect(importer).toContain("select i.manager_user_id into v_owner from public.prospect_sms_ingress i");
  });

  it("encodes the documented ECMAScript trim set and PostgreSQL codepoint limit", () => {
    const codes = [9, 10, 11, 12, 13, 32, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];
    for (const code of codes) {
      expect(resolver).toContain(`\\${code.toString(16).toUpperCase().padStart(4, "0")}`);
      expect(`${String.fromCodePoint(code)}body${String.fromCodePoint(code)}`.trim()).toBe("body");
    }
    expect(resolver).toContain("left(btrim(v_body,v_trim_chars),2000)");
    expect(Array.from("😀".repeat(2000) + "tail").slice(0, 2000).join("")).toBe("😀".repeat(2000));
    expect(("😀".repeat(2000) + "tail").slice(0, 2000)).toBe("😀".repeat(1000));
    expect(resolver).not.toContain("lower(v_body)");
  });
});
