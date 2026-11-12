/**
 * Create (or link) the SMS group text of every house of ONE workspace, on the house's existing in-app house
 * chat (`house-thread:...`): the Twilio Conversation SID, the projected line and the members are stored on that
 * chat's row (`row_data.smsGroup`). One chat per house, never a second.
 *
 * What is in each group: the explicit staff phones given with `--phone`, plus the residents re-derived from
 * occupancy (current long-term residents with a verified phone who have not left the group and have not texted
 * STOP). The line it projects from is `resolveSmsGroupLine`: the workspace's work number, or the PropLane line
 * for a PropLane-managed workspace, never anything else.
 *
 * TWILIO LIMIT (read this): Group MMS needs at least TWO phones plus the line. A house with only one phone
 * (just the owner) is recorded as PENDING and its Conversation is created by the next sync, the moment a second
 * phone qualifies (a resident finishing onboarding, or another `--phone`). Twilio also refuses two groups with
 * an identical set of phones on one line, so give each house a different set (a resident per house does that).
 *
 * Idempotent: it reads who SHOULD be in each group, compares it with who IS, and does nothing when they match;
 * a house that already has a live Conversation keeps its SID and only has people added or removed.
 *
 * Dry run (default, reads only, nothing is created or texted):
 *   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local \
 *     scripts/create-house-group-chats.mts --workspace <workspace-id> --phone +15103098345
 *
 * Apply on the dev/test project (needs TWILIO_ACCOUNT_SID + API key pair or auth token):
 *   ... scripts/create-house-group-chats.mts --workspace <id> --phone +1... --apply
 *
 * Apply on PRODUCTION (the coordinator's run; needs the restricted Twilio key pair, the production origin in
 * TWILIO_CONVERSATIONS_WEBHOOK_URL or the canonical site URL, and the explicit flag AND env switch):
 *   ALLOW_PRODUCTION_HOUSE_GROUP_CHATS=1 NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.production.local \
 *     scripts/create-house-group-chats.mts --workspace c274ba4f-bf3f-41e0-b4ed-379ca578530f \
 *     --phone +15103098345 --name Prakrit --apply --production
 *
 * Options: --workspace <id> (required) · --phone <e164> (repeatable, staff) · --name <first name> (for the
 * phones, same order optional) · --property <id> (repeatable, default every house) · --apply · --production.
 */
import { createClient } from "@supabase/supabase-js";
import { loadHouseResidentCandidates } from "../src/lib/house-groups/residents.server";
import { conversationsWebhookUrl, createConversationsGateway } from "../src/lib/house-groups/conversations-gateway.server";
import { pacificDayKey } from "../src/lib/house-groups/time";
import { resolveSmsGroupLine } from "../src/lib/house-sms-group/line.server";
import { maskPhoneLast4, memberSetKey, planMembership, selectResidentMembers, type SmsGroupMember } from "../src/lib/house-sms-group/model";
import { listWorkspaceSmsGroups, loadHouseSmsGroup, threadIdFor } from "../src/lib/house-sms-group/store.server";
import { syncHouseSmsGroup, type StaffInput } from "../src/lib/house-sms-group/sync.server";
import { normalizeE164 } from "../src/lib/phone-e164";
import { normalizeConsentPhone } from "../src/lib/sms-consent";

const PRODUCTION_PROJECT_REF = "qahnczmilgptcedaqype";

function arg(name: string): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith("--")) out.push(argv[i + 1]!);
    else if (argv[i]!.startsWith(`--${name}=`)) out.push(argv[i]!.slice(name.length + 3));
  }
  return out;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`create-house-group-chats: ${message}`);
  process.exit(1);
}

const APPLY = flag("apply");
const workspaceId = arg("workspace")[0]?.trim() ?? "";
const phones = arg("phone");
const names = arg("name");
const onlyProperties = new Set(arg("property").map((p) => p.trim()).filter(Boolean));
if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) fail("--workspace <uuid> is required.");
const staff: StaffInput[] = phones.map((raw, i) => {
  const phoneE164 = normalizeE164(raw);
  if (!phoneE164) fail(`"${raw}" is not a valid phone number.`);
  return { phoneE164, firstName: names[i] ?? names[0] ?? "", userId: null };
});

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/^"|"$/g, "").trim();
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").replace(/^"|"$/g, "").trim();
if (!url || !key) fail("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (use --env-file).");
const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)?.[1] ?? "";
const isProduction = ref === PRODUCTION_PROJECT_REF;
if (APPLY && isProduction && !(flag("production") && process.env.ALLOW_PRODUCTION_HOUSE_GROUP_CHATS === "1")) {
  fail("applying to PRODUCTION needs both --production and ALLOW_PRODUCTION_HOUSE_GROUP_CHATS=1.");
}
if (APPLY && !isProduction && flag("production")) fail("--production was given but this is not the production project.");

// A plain client: the app's own service-role helper refuses the live project by design (`assertNonProdDatabase`).
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} on project ${ref || "(unknown)"}${isProduction ? " (PRODUCTION)" : ""}`);

  const { data: ws, error: wsError } = await db.from("portal_workspaces").select("id, name, owner_user_id, is_service").eq("id", workspaceId).maybeSingle();
  if (wsError || !ws) fail("workspace not found.");
  const ownerUserId = String((ws as { owner_user_id?: unknown }).owner_user_id ?? "");
  console.log(`Workspace "${(ws as { name?: unknown }).name}" ${(ws as { is_service?: unknown }).is_service ? "(PropLane-managed)" : ""}`);

  const line = await resolveSmsGroupLine(db, { workspaceId, ownerUserId });
  if (!line.ok) fail(`no sendable line for this workspace (${line.reason}). Nothing was changed.`);
  console.log(`Projected line: ${maskPhoneLast4(line.line)} (${line.kind === "shared" ? "PropLane shared line" : "work number / PropLane service line"})`);
  console.log(`Conversations webhook: ${conversationsWebhookUrl()}`);
  if (APPLY && isProduction && !/^https:\/\/(?!localhost)/.test(conversationsWebhookUrl())) fail("the Conversations webhook URL is not a public https origin.");
  if (APPLY && !createConversationsGateway()) fail("Twilio is not configured in this environment (TWILIO_ACCOUNT_SID + API key pair).");

  const { data: houses, error: housesError } = await db.from("manager_property_records").select("id, row_data").eq("workspace_id", workspaceId).limit(500);
  if (housesError) fail("could not read the workspace's houses.");
  const { propertyLabel } = await import("../src/lib/one-number/router-lookups.server");
  const list = ((houses ?? []) as { id: string; row_data: unknown }[])
    .filter((h) => onlyProperties.size === 0 || onlyProperties.has(h.id))
    .map((h) => ({ id: String(h.id), label: propertyLabel(h.row_data) || String(h.id) }));
  if (list.length === 0) fail("no houses matched.");
  console.log(`Staff phones: ${staff.length === 0 ? "none" : staff.map((s) => maskPhoneLast4(s.phoneE164)).join(", ")}`);
  console.log(`Houses: ${list.length}\n`);

  const seenSets = new Map<string, string>();
  for (const g of await listWorkspaceSmsGroups(db, workspaceId)) {
    if (g.state.status === "active") seenSets.set(memberSetKey(g.state.line, g.state.members.map((m) => m.phoneKey)), g.propertyId);
  }

  for (const house of list) {
    const existing = await loadHouseSmsGroup(db, threadIdFor({ ownerUserId, workspaceId, propertyId: house.id }));
    const current = existing?.state ?? null;
    if (!APPLY) {
      // Same plan the sync computes, without writing anything.
      const candidates = await loadHouseResidentCandidates(db, { ownerUserId, workspaceId, propertyId: house.id, today: pacificDayKey(new Date()) });
      const staffMembers: SmsGroupMember[] = [
        ...(current?.members.filter((m) => m.kind === "staff") ?? []),
        ...staff.map((s) => ({
          phoneKey: normalizeConsentPhone(s.phoneE164),
          phoneE164: s.phoneE164,
          kind: "staff" as const,
          firstName: s.firstName,
          roomLabel: "",
          userId: null,
          participantSid: null,
          addedAt: new Date().toISOString(),
        })),
      ];
      const picked = selectResidentMembers(candidates, current?.excludedPhoneKeys ?? [], new Set(staffMembers.map((m) => m.phoneKey)));
      const plan = planMembership({ current: current?.members ?? [], staff: staffMembers, residents: picked.members, now: new Date() });
      const setKey = memberSetKey(line.line, plan.desired.map((m) => m.phoneKey));
      const clash = seenSets.get(setKey);
      const verdict =
        plan.desired.length < 2
          ? `PENDING (${plan.desired.length} phone, Twilio needs 2 plus the line)`
          : clash && clash !== house.id
            ? "REFUSED (identical phone set already used by another house)"
            : current?.status === "active"
              ? "UPDATE existing Conversation"
              : "CREATE Conversation";
      if (plan.desired.length >= 2 && !clash) seenSets.set(setKey, house.id);
      console.log(`- ${house.label}: ${verdict}`);
      console.log(`    members: ${plan.desired.map((m) => `${m.firstName || m.kind} ${maskPhoneLast4(m.phoneE164)}`).join(", ") || "none"}`);
      if (current?.conversationSid) console.log(`    existing Conversation: ${current.conversationSid}`);
      continue;
    }
    const result = await syncHouseSmsGroup(db, { workspaceId, propertyId: house.id, enable: true, addStaff: staff });
    const after = await loadHouseSmsGroup(db, threadIdFor({ ownerUserId, workspaceId, propertyId: house.id }));
    console.log(`- ${house.label}: ${result.outcome} (${result.phones} phone${result.phones === 1 ? "" : "s"})${result.detail ? ` - ${result.detail}` : ""}`);
    if (after?.state?.conversationSid) console.log(`    Conversation: ${after.state.conversationSid}`);
  }
  console.log(APPLY ? "\nDone. Re-running is safe." : "\nDry run only. Add --apply to create.");
}

main().catch((error) => {
  console.error("create-house-group-chats failed:", error instanceof Error ? (process.env.DEBUG_STACK ? error.stack : error.message) : "unknown");
  process.exit(1);
});
