/** Additive portal fixtures. Dev/test only; never sends a message or changes a listing. */
import { createClient } from "@supabase/supabase-js";
import { buildSeedInboxThreadsForPerson, inboxThreadDbRow } from "./build-seed-resident-portal-extras.mjs";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (new URL(url).hostname !== "emstjswhotsnyksqhqyf.supabase.co") throw new Error("Portal fixtures require the dedicated dev/test database");
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: manager, error } = await db.from("profiles").select("id").eq("email", "manager@test.proplane.local").single();
if (error || !manager) throw error ?? new Error("Seed the canonical manager first");
const { data: houses, error: housesError } = await db.from("manager_property_records").select("id, property_data")
  .eq("manager_user_id", manager.id).order("id").limit(1);
if (housesError || !houses?.length) throw housesError ?? new Error("Seed the canonical properties first");
const prop = { id: houses[0].id, name: houses[0].property_data?.buildingName ?? "Test home" };
const states = [{ name: "Alex Tour", key: "unread", unread: true, folder: "inbox" },
  { name: "Jamie Resident", key: "read", unread: false, folder: "inbox" },
  { name: "Sam Archived", key: "archived", unread: false, folder: "trash" }];
for (const state of states) {
  const person = { axisId: `portal-reliability-${state.key}`, name: state.name, email: `portal-reliability-${state.key}@test.proplane.local`, prop, testRunId: "portal-reliability" };
  const [thread] = buildSeedInboxThreadsForPerson(person);
  thread.unread = state.unread; thread.folder = state.folder;
  thread.messages[thread.messages.length - 1].outbound = false;
  const result = await db.from("portal_inbox_thread_records").upsert(inboxThreadDbRow(thread, manager.id), { onConflict: "id" });
  if (result.error) throw result.error;
}
console.log("Seeded three dev/test inbox states; no messages sent and no listings changed.");
