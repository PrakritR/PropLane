import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/20260925180000_sms_projection_durability_correction2.sql", import.meta.url),
  "utf8",
);

function bodyOf(name: string): string {
  const start = migration.indexOf(`create or replace function public.${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$$;", start);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("SMS projection correction 2 storage contract", () => {
  it("takes the shared owner lock before any replay, import, or delete row lock", () => {
    const project = bodyOf("project_sms_conversation_event");
    const importer = bodyOf("import_sms_projection_historical_event");
    const deletion = bodyOf("delete_sms_projection_conversation");
    const lock = "sms-projection-owner:'||v_owner::text";

    expect(project.indexOf(lock)).toBeGreaterThan(-1);
    expect(project.indexOf(lock)).toBeLessThan(project.indexOf("sms_projection_deleted_events"));
    expect(importer.indexOf(lock)).toBeGreaterThan(-1);
    expect(importer.indexOf(lock)).toBeLessThan(importer.indexOf("sms_projection_deleted_events"));
    expect(deletion.indexOf("sms-projection-owner:'||p_owner::text")).toBeGreaterThan(-1);
    expect(deletion.indexOf("sms-projection-owner:'||p_owner::text")).toBeLessThan(deletion.indexOf("for update"));
    expect(migration).toContain("create or replace function public.recompute_sms_projection_summary");
  });

  it("requires complete identity and original-envelope agreement for historical provider replay", () => {
    const project = bodyOf("project_sms_conversation_event");
    const importer = bodyOf("import_sms_projection_historical_event");

    for (const field of ["v_prior.occurred_at", "v_prior.from_phone", "v_prior.to_phone", "identity_kind", "identity_key", "counterparty_user_id"]) {
      expect(project).toContain(field);
    }
    for (const field of ["v_existing_turn.occurred_at", "v_existing_turn.from_phone", "v_existing_turn.to_phone", "identity_kind", "identity_key", "counterparty_user_id", "work_line_id"]) {
      expect(importer).toContain(field);
    }
    expect(project).toContain("update public.sms_projection_turns set conversation_id=v_target.id,source_namespace=v_namespace");
    expect(project).toContain("perform public.recompute_sms_projection_summary(v_prior_conversation.id)");
  });

  it("binds an old SMS thread alias only to one exact active projection", () => {
    const binder = bodyOf("bind_sms_projection_legacy_thread_alias");
    expect(binder).toContain("merged_into_id is null for update");
    expect(binder).toContain("sms_projection_ambiguous_aliases");
    expect(binder).toContain("source_namespace=p_source_namespace");
    expect(binder).toContain("p_occurred_at");
    expect(binder).toContain("t.body is not distinct from p_body");
    expect(binder).toContain("return false");
  });
});
