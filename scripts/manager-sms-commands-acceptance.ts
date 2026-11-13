/**
 * Acceptance test 4 (design-1112 section 3.3 / 4) against the DEV/TEST Supabase project ONLY.
 *
 *   npm run test:manager-sms-commands:dev
 *
 * Everything is seeded fresh under a throwaway manager account and a DEV-ONLY test property ("cmdaccept-..." ids on a
 * street that exists nowhere else). It never touches the locked live listings, staging or production, and it removes what
 * it created. It drives the real command layer, real tools and the real confirmation gate:
 *
 *   1. "change room 4 at <house> to 1150" -> preview + 4-digit code; nothing is written yet.
 *   2. a wrong code writes nothing; "YES <code>" writes room 4 only; the public listing projection now shows $1,150.
 *   3. the same text with two houses on one street -> ONE clarifying line, nothing written.
 *   4. an MMS with a HEIC and a JPEG "for <house> room 4" -> both in that room's gallery as JPEGs on the public bucket,
 *      originals kept in the private sms-media bucket.
 *   5. an alert handle -> "K7 yes Dec 1 works" reaches that prospect (the send core is captured, not Twilio),
 *      scoped to the workspace, expiring, wrong handles counted.
 *
 * Exit code 0 only if every check passed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { createDefaultListingSubmission, emptyRoom, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { deriveLegacyFields } from "@/lib/demo-property-pipeline";
import { buildMockPropertyFromDraft } from "@/lib/demo-property-pipeline";
import { handleManagerSmsCommand, mintReplyHandle } from "@/lib/manager-sms-commands/index.server";
import { buildCommandContext } from "@/lib/manager-sms-commands/context.server";
import { defaultRelayDeps, relayReply } from "@/lib/manager-sms-commands/reply-relay.server";
import { runManagerSmsAgentTurn } from "@/lib/agent/manager-sms-agent.server";
import { getPublicListings } from "@/lib/public-listings.server";
import { storeInboundMediaBytes } from "@/lib/sms-media.server";

const DEV_REF = "emstjswhotsnyksqhqyf";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url.includes(DEV_REF) || !key) {
  console.error(`Refusing to run: NEXT_PUBLIC_SUPABASE_URL must be the dev/test project (${DEV_REF}).`);
  process.exit(2);
}
for (const forbidden of ["xwszcafaontidfgznlxd", "qahnczmilgptcedaqype"]) {
  if (url.includes(forbidden)) {
    console.error("Refusing to run against staging or production.");
    process.exit(2);
  }
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const tag = `cmdaccept-${Math.random().toString(36).slice(2, 8)}`;
const results: Array<{ name: string; ok: boolean; detail?: string | null }> = [];
const check = (name: string, ok: boolean, detail?: string | null) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
};

const created = { userId: "", workspaceId: "", propertyIds: [] as string[], mediaPaths: [] as string[], listingPaths: [] as string[], sids: [] as string[] };

function submissionFor(address: string, roomCount: number) {
  const sub = createDefaultListingSubmission();
  sub.address = address;
  sub.buildingName = address;
  sub.rooms = Array.from({ length: roomCount }, (_, i) => ({ ...emptyRoom(i), id: `${tag}-room-${i + 1}`, monthlyRent: 900 + i * 10 }));
  return normalizeManagerListingSubmissionV1(sub);
}

async function seedProperty(id: string, address: string) {
  const submission = submissionFor(address, 4);
  const legacy = deriveLegacyFields(submission);
  const pendingLike = { ...legacy, id, submittedAt: new Date().toISOString(), submission, submittedByUserId: created.userId };
  const mock = buildMockPropertyFromDraft(pendingLike as never, id);
  const { error } = await db.from("manager_property_records").insert({
    id, manager_user_id: created.userId, workspace_id: created.workspaceId, status: "live",
    row_data: { id, submission, ...legacy }, property_data: { ...mock, id, adminPublishLive: true, listingSubmission: submission },
  });
  if (error) throw new Error(`seed property: ${error.message}`);
  created.propertyIds.push(id);
}

async function roomOf(propertyId: string, index: number) {
  const { data } = await db.from("manager_property_records").select("property_data").eq("id", propertyId).maybeSingle();
  const sub = (data?.property_data as { listingSubmission?: { rooms: Array<{ monthlyRent: number; photoDataUrls: string[] }> } } | undefined)?.listingSubmission;
  return sub?.rooms[index];
}

async function main() {
  // A phone no other dev profile holds: a number shared by two profiles is nobody's verified phone (by design).
  let phone = "";
  for (let attempt = 0; attempt < 40 && !phone; attempt += 1) {
    const candidate = `+1206555${String(1000 + Math.floor(Math.random() * 8999))}`;
    const { data: held } = await db.from("profiles").select("id").in("phone", [candidate, candidate.slice(2), candidate.slice(1)]).limit(1);
    if (!held?.length) phone = candidate;
  }
  if (!phone) throw new Error("could not find an unused test phone");
  const email = `${tag}@axis.local`;
  const { data: user, error: userError } = await db.auth.admin.createUser({ email, password: `Pw-${tag}-aA1!`, email_confirm: true });
  if (userError || !user.user) throw new Error(`create user: ${userError?.message}`);
  created.userId = user.user.id;
  await db.from("profiles").upsert({ id: created.userId, email, role: "manager", phone, phone_verified_at: new Date().toISOString() }, { onConflict: "id" });
  await db.from("profile_roles").upsert({ user_id: created.userId, role: "manager" }, { onConflict: "user_id,role" });
  const { data: ws, error: wsError } = await db.rpc("ensure_default_portal_workspace", { p_owner: created.userId });
  if (wsError || !ws) throw new Error(`workspace: ${wsError?.message}`);
  created.workspaceId = String(ws);
  console.log(`seeded manager ${tag} (dev only), workspace ${created.workspaceId}`);

  const houseA = `7001 Cmdaccept Way`;
  const houseB = `7003 Cmdaccept Way`;
  await seedProperty(`${tag}-a`, `${houseA}, Seattle, WA`);
  await seedProperty(`${tag}-b`, `${houseB}, Seattle, WA`);

  const base = { staffPhoneE164: phone, actorUserId: created.userId, workspaceIds: [created.workspaceId], mediaCount: 0, onPropLaneLine: true };
  let n = 0;
  const sid = () => {
    const value = `SM${tag}${++n}`.padEnd(34, "0").slice(0, 34);
    created.sids.push(value);
    return value;
  };

  // 1. preview + code, nothing written
  const ask = await handleManagerSmsCommand(db, { ...base, body: "change room 4 at 7001 to 1150", messageSid: sid() });
  const code = ask.handled ? /YES (\d{4})/.exec(ask.reply)?.[1] : undefined;
  check("1. edit text is answered with a preview and a 4-digit code", ask.handled && Boolean(code), ask.handled ? ask.reply : "not handled");
  check("1. nothing is written before the code", (await roomOf(`${tag}-a`, 3))?.monthlyRent === 930);

  // 2. wrong code writes nothing, right code writes room 4 only
  const ctx = await buildCommandContext(db, { actorUserId: created.userId, workspaceId: created.workspaceId });
  check("2. the manager's own context resolves on the workspace", Boolean(ctx));
  const turn = (text: string) => runManagerSmsAgentTurn(db, { ctx: ctx!, managerPhoneE164: phone, inboundText: text, inboundMessageSid: sid(), requireConfirmationCode: true });
  const wrong = await turn(`YES ${code === "0000" ? "1111" : "0000"}`);
  check("2. a wrong code writes nothing", (await roomOf(`${tag}-a`, 3))?.monthlyRent === 930, wrong?.reply);
  // The existing gate re-issues a FRESH code after a miss, so the live code is the one in the wrong-code reply.
  const freshCode = /YES (\d{4})/.exec(wrong?.reply ?? "")?.[1];
  check("2. a wrong code re-asks with a fresh code", Boolean(freshCode) && freshCode !== code, wrong?.reply);
  const ok = await turn(`YES ${freshCode}`);
  check("2. the right code runs the tool's handler", (await roomOf(`${tag}-a`, 3))?.monthlyRent === 1150, ok?.reply);
  check("2. no other room or house changed", (await roomOf(`${tag}-a`, 2))?.monthlyRent === 920 && (await roomOf(`${tag}-b`, 3))?.monthlyRent === 930);
  const listings = await getPublicListings();
  const live = listings.find((l) => l.id === `${tag}-a`);
  const publicRent = (live?.listingSubmission as { rooms?: Array<{ monthlyRent: number }> } | undefined)?.rooms?.[3]?.monthlyRent;
  check("2. the public listing projection shows $1,150 with no portal action", publicRent === 1150, `public rent ${publicRent}`);

  // 3. ambiguity: one line, nothing written
  const ambiguous = await handleManagerSmsCommand(db, { ...base, body: "change room 4 at cmdaccept way to 1300", messageSid: sid() });
  check("3. two houses on one street -> ONE clarifying line", ambiguous.handled && ambiguous.reply === `Which one: ${houseA} or ${houseB}?`, ambiguous.handled ? ambiguous.reply : "not handled");
  check("3. and nothing was written", (await roomOf(`${tag}-b`, 3))?.monthlyRent === 930);

  // 4. MMS: a HEIC and a JPEG into room 4
  const heic = readFileSync(path.join(process.cwd(), "tests/fixtures/heic/room-640x480.heic"));
  const jpeg = await sharp(Buffer.alloc(1600 * 1200 * 3, 130), { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg().toBuffer();
  const mmsSid = sid();
  const phoneKey = phone.slice(2);
  const files: Array<{ bytes: Buffer; mime: string }> = [{ bytes: heic, mime: "image/heic" }, { bytes: jpeg, mime: "image/jpeg" }];
  for (const [index, file] of files.entries()) {
    const stored = await storeInboundMediaBytes(db, { managerUserId: created.userId, messageSid: mmsSid, index, bytes: file.bytes, mime: file.mime });
    if (!stored) throw new Error("could not store the test media");
    created.mediaPaths.push(stored.path);
    await db.from("sms_media_files").upsert({ message_sid: mmsSid, media_index: index, workspace_id: created.workspaceId, sender_phone_key: phoneKey, storage_path: stored.path, content_type: stored.contentType, byte_size: stored.byteSize }, { onConflict: "message_sid,media_index" });
  }
  const filed = await handleManagerSmsCommand(db, { ...base, body: "for 7001 room 4", messageSid: mmsSid, mediaCount: 2 });
  check("4. MMS photos are filed and acknowledged", filed.handled && filed.reply.startsWith("Added 2 photos to 7001 Cmdaccept Way, Room 4."), filed.handled ? filed.reply : "not handled");
  const room4 = await roomOf(`${tag}-a`, 3);
  const urls = room4?.photoDataUrls ?? [];
  check("4. both photos are in room 4's gallery", urls.length === 2, `${urls.length} urls`);
  let allJpeg = urls.length === 2;
  for (const photoUrl of urls) {
    const res = await fetch(photoUrl);
    created.listingPaths.push(decodeURIComponent(photoUrl.split("/listing-photos/")[1] ?? ""));
    allJpeg &&= res.ok && (res.headers.get("content-type") ?? "").includes("image/jpeg");
  }
  check("4. the gallery URLs are public JPEGs (the HEIC was converted)", allJpeg);
  check("4. no other room or house got a photo", ((await roomOf(`${tag}-a`, 0))?.photoDataUrls ?? []).length === 0 && ((await roomOf(`${tag}-b`, 3))?.photoDataUrls ?? []).length === 0);
  const originals = await Promise.all(created.mediaPaths.map((p) => db.storage.from("sms-media").download(p)));
  check("4. originals are kept in the private sms-media bucket", originals.every((o) => !o.error && o.data) && Buffer.compare(Buffer.from(await originals[0]!.data!.arrayBuffer()), heic) === 0);
  const unclear = await handleManagerSmsCommand(db, { ...base, body: "", messageSid: mmsSid, mediaCount: 1 });
  check("4. (already-filed photos are not re-asked or re-filed)", !unclear.handled || !unclear.reply.includes("Added"));

  // 5. reply relay by handle
  const threadId = `${tag}-thread`;
  const prospect = "+12065550199";
  const handle = await mintReplyHandle(db, { staffPhoneE164: phone, workspaceId: created.workspaceId, threadId, counterpartyPhoneE164: prospect });
  check("5. an alert text gets a short handle", Boolean(handle && /^[A-Z][A-Z0-9]?\d$/.test(handle)), String(handle));
  const sent: Array<Record<string, unknown>> = [];
  const deps = {
    ...defaultRelayDeps,
    send: (async (_db: unknown, args: Record<string, unknown>) => { sent.push(args); return { body: { ok: true, status: "submitted" }, status: 200 }; }) as never,
    recordOutbound: async () => undefined,
  };
  const relay = await relayReply(db, { staffPhoneE164: phone, actorUserId: created.userId, workspaceIds: [created.workspaceId], body: `${handle} yes Dec 1 works`, messageSid: sid() }, deps);
  console.log("   relay result:", JSON.stringify(relay));
  check("5. \"<handle> <answer>\" goes to that prospect as the staff member", relay.handled && sent.length === 1 && sent[0]!.toPhone === prospect && sent[0]!.text === "yes Dec 1 works" && sent[0]!.author === "manager", JSON.stringify(sent));
  const other = await relayReply(db, { staffPhoneE164: phone, actorUserId: created.userId, workspaceIds: ["00000000-0000-0000-0000-000000000000"], body: `${handle} hello`, messageSid: sid() }, deps);
  check("5. a handle outside the phone's workspaces sends nothing", !other.handled && sent.length === 1);
  await db.from("sms_reply_handles").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("thread_id", threadId);
  const expired = await relayReply(db, { staffPhoneE164: phone, actorUserId: created.userId, workspaceIds: [created.workspaceId], body: `${handle} too late`, messageSid: sid() }, deps);
  check("5. an expired handle says so and sends nothing", expired.handled && expired.reply.includes("expired") && sent.length === 1);
  // 6. guided create-a-listing: a DRAFT, in this workspace, never public; photos then file into it
  await handleManagerSmsCommand(db, { ...base, body: "new listing", messageSid: sid() });
  await handleManagerSmsCommand(db, { ...base, body: "9001 Flowtest Ct Seattle", messageSid: sid() });
  await handleManagerSmsCommand(db, { ...base, body: "3 rooms", messageSid: sid() });
  await handleManagerSmsCommand(db, { ...base, body: "$880", messageSid: sid() });
  const proposal = await handleManagerSmsCommand(db, { ...base, body: "skip", messageSid: sid() });
  const flowCode = proposal.handled ? /YES (\d{4})/.exec(proposal.reply)?.[1] : undefined;
  check("6. the flow ends in a coded proposal to save a draft", Boolean(flowCode), proposal.handled ? proposal.reply : "not handled");
  const { data: before } = await db.from("manager_property_records").select("id").eq("manager_user_id", created.userId).like("id", "mgr-text-%");
  check("6. nothing is saved before the code", (before ?? []).length === 0);
  const saved = await turn(`YES ${flowCode}`);
  const { data: drafts } = await db.from("manager_property_records").select("id, status, workspace_id, row_data").eq("manager_user_id", created.userId).like("id", "mgr-text-%");
  const draft = drafts?.[0];
  if (draft) created.propertyIds.push(String(draft.id));
  check("6. the confirmed flow saves ONE draft in the workspace", drafts?.length === 1 && draft?.status === "draft" && draft?.workspace_id === created.workspaceId, saved?.reply);
  const draftSub = (draft?.row_data as { submission?: { address: string; rooms: Array<{ monthlyRent: number }> } } | undefined)?.submission;
  check("6. address, three rooms and the rent are on the draft", draftSub?.address === "9001 Flowtest Ct Seattle" && draftSub?.rooms.length === 3 && draftSub?.rooms.every((r) => r.monthlyRent === 880) === true);
  check("6. the draft is not in the public catalog", !(await getPublicListings()).some((l) => l.id === draft?.id));
  const flowSid = sid();
  const jpeg2 = await sharp(Buffer.alloc(1400 * 1000 * 3, 90), { raw: { width: 1400, height: 1000, channels: 3 } }).jpeg().toBuffer();
  const stored2 = await storeInboundMediaBytes(db, { managerUserId: created.userId, messageSid: flowSid, index: 0, bytes: jpeg2, mime: "image/jpeg" });
  if (stored2) {
    created.mediaPaths.push(stored2.path);
    await db.from("sms_media_files").upsert({ message_sid: flowSid, media_index: 0, workspace_id: created.workspaceId, sender_phone_key: phoneKey, storage_path: stored2.path, content_type: stored2.contentType, byte_size: stored2.byteSize }, { onConflict: "message_sid,media_index" });
  }
  const toDraft = await handleManagerSmsCommand(db, { ...base, body: "", messageSid: flowSid, mediaCount: 1 });
  check("6. photos texted right after go to the new draft's gallery", toDraft.handled && toDraft.reply.startsWith("Added 1 photo to 9001 Flowtest Ct Seattle."), toDraft.handled ? toDraft.reply : "not handled");
  const { data: draftAfter } = await db.from("manager_property_records").select("row_data").eq("id", String(draft?.id)).maybeSingle();
  const housePhotos = (draftAfter?.row_data as { submission?: { housePhotoDataUrls: string[] } } | undefined)?.submission?.housePhotoDataUrls ?? [];
  check("6. the draft's house gallery has the photo", housePhotos.length === 1, `${housePhotos.length}`);
  for (const photoUrl of housePhotos) created.listingPaths.push(decodeURIComponent(photoUrl.split("/listing-photos/")[1] ?? ""));

  const stranger = await handleManagerSmsCommand(db, { ...base, staffPhoneE164: "+12065550111", body: "change room 4 at 7001 to 999", messageSid: sid() });
  check("0. a phone that is not the manager's verified phone gets nothing", !stranger.handled);
}

async function cleanup() {
  try {
    for (const id of created.propertyIds) await db.from("manager_property_records").delete().eq("id", id);
    if (created.mediaPaths.length) await db.storage.from("sms-media").remove(created.mediaPaths);
    const listing = created.listingPaths.filter(Boolean);
    if (listing.length) await db.storage.from("listing-photos").remove(listing);
    if (created.sids.length) await db.from("sms_media_files").delete().in("message_sid", created.sids);
    await db.from("sms_reply_handles").delete().like("thread_id", `${tag}%`);
    await db.from("sms_listing_flows").delete().eq("workspace_id", created.workspaceId);
    if (created.userId) {
      await db.from("agent_pending_actions").delete().eq("user_id", created.userId);
      await db.auth.admin.deleteUser(created.userId);
    }
  } catch (error) {
    console.warn("cleanup was partial (dev data only):", error instanceof Error ? error.message : error);
  }
}

main()
  .catch((error) => {
    console.error("acceptance run aborted:", error instanceof Error ? error.message : error);
    results.push({ name: "run", ok: false, detail: "aborted" });
  })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
