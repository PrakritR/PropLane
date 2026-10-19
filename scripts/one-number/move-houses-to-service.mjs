#!/usr/bin/env node
/**
 * One-number W22: move ONE owner's houses in a city into a PropLane Service workspace (admin account).
 *
 *   node scripts/one-number/move-houses-to-service.mjs --target dev --owner-email ambika@example.com --label Ambika
 *   ... --owner-name Ambika                    no --owner-email: lists the accounts that match, then stops
 *   ... --apply --expect-houses 4              write it; the count is the one the dry run printed
 *   ... --apply --undo <journal file>          take it back (transfers the workspace back)
 *
 * What it does, per run (one owner, one workspace):
 *   1. Finds the owner's workspace whose houses are ALL in the city (default Seattle). A workspace that mixes cities,
 *      or holds a house whose city cannot be read, STOPS the run: it never splits a workspace.
 *   2. Seats the service owner (platform_service_settings) as an accepted member of that workspace, because the app's
 *      own `transfer_portal_workspace_ownership` hands a workspace only to an accepted member.
 *   3. Calls that RPC (the same one the product's "Transfer ownership" uses): the workspace, its houses, twelve
 *      property-keyed tables, its members and its work number / email follow. The former owner stays as an Admin
 *      member with the full admin permission stamp.
 *   4. Marks the workspace as a service workspace (is_service, city, name = --label) and flags the former owner's
 *      membership as the owner of record (W15, migrations 20261018260000 / 260100). No other row is edited by hand.
 *   5. Reads the same things back and compares them with the snapshot taken first: any difference undoes the move.
 *
 * Dry run is the default and prints, per house, the residents, leases, bookings, charges and conversations that go
 * with it, plus every row the app's transfer does NOT re-key ("left behind"). Apply needs --expect-houses <n> (the
 * number you approved) and, when anything is left behind, --acknowledge-unmoved. A journal (mode 0600) is written
 * before the first change and after each step; --undo reverses it.
 *
 * Guards: see lib/target.mjs. Production writes need --confirm-ref, --reason, and a fresh backup.mjs file taken with
 * the same --owner-email (it saves the rows this script touches).
 */
import { writeJsonFile, BACKUP_DIR, timestamp } from "./lib/files.mjs";
import { fetchAll, isMissingSchema } from "./lib/db.mjs";
import { UsageError } from "./lib/args.mjs";
import { bootstrap, isMain, runMain } from "./lib/runtime.mjs";
import { GuardError } from "./lib/target.mjs";
import {
  ADMIN_STAMP,
  classifyWorkspaces,
  diffSnapshots,
  houseLabel,
  houseSummaries,
  leftBehind,
  ownerProblems,
  readSnapshot,
  workspaceHistory,
} from "./lib/move-plan.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const SCRIPT = "move-houses-to-service";
export const JOURNAL_KIND = "one-number-move-houses-journal";

export class MoveRefusal extends GuardError {}

const clean = (v) => String(v ?? "").trim().replace(/\s+/g, " ");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------ reads ------------------------------------ */

async function serviceOwner(db) {
  const res = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (res.error) {
    if (isMissingSchema(res.error)) {
      throw new MoveRefusal("platform_service_settings does not exist on this project: apply migration 20261018260000_admin_service_workspaces.sql first.");
    }
    throw new Error(`platform_service_settings: ${res.error.message}`);
  }
  if (!res.data?.owner_user_id) throw new MoveRefusal("No service owner is configured (platform_service_settings is empty). Run create-service-workspace.mjs first.");
  const id = String(res.data.owner_user_id);
  const profile = await db.from("profiles").select("id, email, full_name, manager_id").eq("id", id).maybeSingle();
  if (profile.error) throw new Error(`profiles: ${profile.error.message}`);
  if (!profile.data) throw new MoveRefusal(`The service owner ${id} has no profile.`);
  return profile.data;
}

async function findOwnerByEmail(db, email) {
  const wanted = clean(email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(wanted)) throw new UsageError("--owner-email must be an email address.");
  const res = await db.from("profiles").select("id, email, full_name, manager_id, sms_from_number").ilike("email", wanted);
  if (res.error) throw new Error(`profiles: ${res.error.message}`);
  const rows = (res.data ?? []).filter((r) => clean(r.email).toLowerCase() === wanted);
  if (rows.length === 0) throw new MoveRefusal(`No account has the email ${wanted}.`);
  if (rows.length > 1) throw new MoveRefusal(`${rows.length} accounts share the email ${wanted}; refusing to guess.`);
  return rows[0];
}

async function listCandidates(db, needle, log) {
  const text = clean(needle).replace(/[%_,()]/g, " ").trim();
  if (!text) throw new UsageError("--owner-name needs a name to look for.");
  const [byName, byEmail] = await Promise.all([
    db.from("profiles").select("id, email, full_name").ilike("full_name", `%${text}%`).limit(25),
    db.from("profiles").select("id, email, full_name").ilike("email", `%${text}%`).limit(25),
  ]);
  const rows = new Map();
  for (const r of [...(byName.data ?? []), ...(byEmail.data ?? [])]) rows.set(r.id, r);
  log(`${SCRIPT}: accounts matching "${text}" (${rows.size}):`);
  for (const r of rows.values()) log(`${SCRIPT}:   ${r.email ?? "(no email)"}  ${r.full_name ?? ""}  ${r.id}`);
  if (rows.size === 0) log(`${SCRIPT}:   none`);
  throw new UsageError("Pick the account and run again with --owner-email <email>.");
}

async function loadOwnerWorld(db, ownerId, city) {
  const ws = await fetchAll(db, "portal_workspaces", "id, name, owner_user_id, city, is_service, is_default, owner_of_record_name, created_at", {
    filter: (q) => q.eq("owner_user_id", ownerId),
  });
  if (ws.missing) throw new MoveRefusal("portal_workspaces.is_service / city are missing: apply migrations 20261018260000 and 20261018260100 first.");
  const ids = ws.rows.map((w) => w.id);
  const houses = ids.length
    ? (await fetchAll(db, "manager_property_records", "id, manager_user_id, workspace_id, status, property_data, row_data", { filter: (q) => q.in("workspace_id", ids) })).rows
    : [];
  return { workspaces: ws.rows, houses, classified: classifyWorkspaces(ws.rows, houses, city) };
}

/* ----------------------------------- printing ----------------------------------- */

function printPlan(log, { owner, service, target, houses, summaries, snap, left, history, label, city }) {
  log(`${SCRIPT}: owner      ${owner.email} (${owner.full_name ?? "no name"}) ${owner.id}`);
  log(`${SCRIPT}: service    ${service.email} ${service.id}`);
  log(`${SCRIPT}: workspace  "${target.workspace.name}" ${target.workspace.id}${target.workspace.is_default ? " (the owner's default workspace)" : ""}`);
  log(`${SCRIPT}: becomes    service workspace "${label}" (${city}), owned by the service owner; ${owner.email} stays as Admin and owner of record`);
  log(`${SCRIPT}: houses (${houses.length}):`);
  for (const s of summaries) {
    log(
      `${SCRIPT}:   ${s.id}  ${s.address}  [${s.status ?? "?"}]  residents ${s.residents}, leases ${s.leases} (open ${s.openLeases}), ` +
        `bookings ${s.bookings} (upcoming ${s.upcomingBookings}), charges ${s.charges} (open ${s.openCharges}), services ${s.services}, ` +
        `applications ${s.applications}, conversations ${s.conversations}`,
    );
  }
  const moved = Object.entries(snap.tables).filter(([, e]) => e.moved && e.count > 0).map(([t, e]) => `${t} ${e.count}`);
  log(`${SCRIPT}: re-keyed by the app's transfer: ${moved.join(", ") || "no related rows"}`);
  log(`${SCRIPT}: members that stay: ${snap.members.length}; work numbers: ${snap.numbers.length}; work emails: ${snap.emails.length}`);
  if (left.length) {
    log(`${SCRIPT}: LEFT BEHIND (rows that name ${owner.email}'s account and that the app's transfer does not re-key):`);
    for (const l of left) log(`${SCRIPT}:   ${l.table}: ${l.rows}`);
  } else {
    log(`${SCRIPT}: left behind: nothing (no unmoved table holds a row for these houses)`);
  }
  if (history.length) log(`${SCRIPT}: workspace history that stays attached to the workspace id: ${history.map((h) => `${h.table} ${h.rows}`).join(", ")}`);
  if (snap.missingTables.length) log(`${SCRIPT}: not migrated here (skipped): ${snap.missingTables.join(", ")}`);
}

/* ------------------------------------ journal ------------------------------------ */

function journalWriter(deps, path) {
  const write = deps.writeFile ?? writeJsonFile;
  return (journal) => write(path, journal);
}

function step(journal, name, detail = {}) {
  journal.steps.push({ name, at: new Date().toISOString(), ...detail });
}

/* ------------------------------------- apply ------------------------------------- */

async function transferRpc(db, { workspaceId, from, to, role, permissions }) {
  const res = await db.rpc("transfer_portal_workspace_ownership", {
    p_workspace: workspaceId,
    p_from: from,
    p_to: to,
    p_former_role: role,
    p_former_permissions: permissions,
  });
  if (res.error) throw new Error(`transfer_portal_workspace_ownership: ${res.error.message}`);
  return res.data ?? {};
}

async function seatServiceOwner(db, { owner, service, workspaceId }) {
  const now = new Date().toISOString();
  const row = {
    inviter_user_id: owner.id,
    invitee_user_id: service.id,
    tab_kind: "manager",
    inviter_axis_id: owner.manager_id ?? "",
    invitee_axis_id: service.manager_id ?? "",
    inviter_display_name: clean(owner.full_name) || owner.email || null,
    invitee_display_name: clean(service.full_name) || service.email || null,
    assigned_property_ids: [],
    payout_percent_for_manager: 0,
    property_co_manager_permissions: {},
    co_manager_permissions: { ...ADMIN_STAMP },
    workspace_id: workspaceId,
    workspace_permissions: {},
    team_role: "admin",
    house_scope: "all",
    invited_via: "code",
    invited_at: now,
    responded_at: now,
    status: "accepted",
    is_owner_of_record: false,
  };
  const res = await db.from("account_link_invites").insert(row).select("id");
  const id = res.data?.[0]?.id;
  if (res.error || !id) throw new Error(`account_link_invites: ${res.error?.message ?? "no row returned"}`);
  return String(id);
}

async function applyMove(db, ctx) {
  const { owner, service, target, label, city, houseIds, journal, save, log } = ctx;
  const W = target.workspace.id;

  journal.state = "applying";
  save(journal);

  journal.tempMembershipId = await seatServiceOwner(db, { owner, service, workspaceId: W });
  step(journal, "service-owner-seated", { linkId: journal.tempMembershipId });
  save(journal);
  log(`${SCRIPT}: seated the service owner as an accepted member of the workspace (link ${journal.tempMembershipId})`);

  const result = await transferRpc(db, { workspaceId: W, from: owner.id, to: service.id, role: "admin", permissions: { ...ADMIN_STAMP } });
  step(journal, "ownership-transferred", { houses: result.houses ?? null, members: result.members ?? null });
  save(journal);
  log(`${SCRIPT}: transferred ownership through transfer_portal_workspace_ownership (houses ${result.houses ?? "?"}, members re-pointed ${result.members ?? "?"})`);

  const marked = await db
    .from("portal_workspaces")
    .update({ name: label, city, is_service: true })
    .eq("id", W)
    .eq("owner_user_id", service.id)
    .select("id");
  if (marked.error || (marked.data ?? []).length !== 1) throw new Error(`portal_workspaces: could not mark the service workspace (${marked.error?.message ?? "no row"})`);
  step(journal, "marked-service", { name: label, city });
  save(journal);

  // The RPC clears is_default on the transferred workspace. If it was the owner's default, the owner now has none:
  // give them the app's own fresh default (ensure_default_portal_workspace, what the app calls on demand).
  if (target.workspace.is_default) {
    const had = await db.from("portal_workspaces").select("id").eq("owner_user_id", owner.id).eq("is_default", true);
    if (had.error) throw new Error(`portal_workspaces: ${had.error.message}`);
    if ((had.data ?? []).length === 0) {
      const made = await db.rpc("ensure_default_portal_workspace", { p_owner: owner.id });
      if (made.error || !made.data) throw new Error(`ensure_default_portal_workspace: ${made.error?.message ?? "no id"}`);
      journal.createdDefaultId = String(made.data);
      step(journal, "default-workspace-created", { id: journal.createdDefaultId });
      save(journal);
      log(`${SCRIPT}: the workspace was ${owner.email}'s default; gave them a fresh empty default workspace (${journal.createdDefaultId})`);
    }
  }

  const flagged = await db
    .from("account_link_invites")
    .select("id, is_owner_of_record")
    .eq("workspace_id", W)
    .eq("inviter_user_id", service.id)
    .eq("invitee_user_id", owner.id)
    .eq("status", "accepted");
  if (flagged.error) throw new Error(`account_link_invites: ${flagged.error.message}`);
  const ownerLink = (flagged.data ?? [])[0];
  if (!ownerLink) throw new Error("the former owner's Admin membership was not created by the transfer");
  const taken = await db.from("account_link_invites").select("id").eq("workspace_id", W).eq("is_owner_of_record", true).in("status", ["pending", "accepted"]);
  if (taken.error) throw new Error(`account_link_invites: ${taken.error.message}`);
  if ((taken.data ?? []).length > 0) {
    journal.ownerOfRecordSet = false;
    step(journal, "owner-of-record-kept", { note: "the workspace already had an owner of record; not changed" });
    log(`${SCRIPT}: the workspace already has an owner of record; left as it is`);
  } else {
    const set = await db.from("account_link_invites").update({ is_owner_of_record: true }).eq("id", ownerLink.id).select("id");
    if (set.error || (set.data ?? []).length !== 1) throw new Error(`account_link_invites: could not flag the owner of record (${set.error?.message ?? "no row"})`);
    journal.ownerOfRecordSet = true;
    journal.ownerLinkId = ownerLink.id;
    step(journal, "owner-of-record-set", { linkId: ownerLink.id });
  }
  save(journal);

  const after = await readSnapshot(db, { workspaceId: W, houseIds, now: new Date(journal.snapshotBefore.asOf) });
  journal.snapshotAfter = after;
  const added = [{ invitee: owner.id, role: "admin", status: "accepted", scope: "all", assigned: [...houseIds].sort() }];
  const problems = [
    ...diffSnapshots(journal.snapshotBefore, after, { addedMembers: added }),
    ...ownerProblems(after, service.id),
  ];
  const w = after.workspace;
  if (!w || w.owner_user_id !== service.id) problems.push("the workspace is not owned by the service owner");
  if (w && (w.is_service !== true || w.name !== label)) problems.push("the workspace is not marked as the service workspace");
  if (target.workspace.is_default) {
    const defaults = await db.from("portal_workspaces").select("id").eq("owner_user_id", owner.id).eq("is_default", true);
    if (defaults.error || (defaults.data ?? []).length !== 1) problems.push("the original owner does not have exactly one default workspace");
  }
  step(journal, "verified", { problems });
  save(journal);
  return { after, problems };
}

/* ------------------------------------- undo ------------------------------------- */

export async function undoMove(db, journal, { log, save, deps = {} }) {
  const W = journal.workspace.id;
  const O = journal.owner.id;
  const S = journal.service.id;
  const before = journal.snapshotBefore.workspace;
  const ws = await db.from("portal_workspaces").select("id, owner_user_id, name").eq("id", W).maybeSingle();
  if (ws.error) throw new Error(`portal_workspaces: ${ws.error.message}`);
  if (!ws.data) throw new MoveRefusal(`Workspace ${W} no longer exists; nothing to undo safely.`);
  const current = ws.data.owner_user_id;

  if (current === S) {
    if (journal.ownerOfRecordSet && journal.ownerLinkId) {
      const cleared = await db.from("account_link_invites").update({ is_owner_of_record: false }).eq("id", journal.ownerLinkId).select("id");
      if (cleared.error) throw new Error(`account_link_invites: ${cleared.error.message}`);
    }
    const member = await db
      .from("account_link_invites")
      .select("id")
      .eq("workspace_id", W)
      .eq("inviter_user_id", S)
      .eq("invitee_user_id", O)
      .eq("status", "accepted");
    if (member.error) throw new Error(`account_link_invites: ${member.error.message}`);
    if ((member.data ?? []).length === 0) {
      throw new MoveRefusal(`${journal.owner.email} is no longer an accepted member of the workspace, and the app can only hand a workspace to a member. Re-add them as Admin (Admin > Service > Team), then run --undo again.`);
    }
    await transferRpc(db, { workspaceId: W, from: S, to: O, role: "nothing", permissions: {} });
    log(`${SCRIPT}: transferred the workspace back to ${journal.owner.email}`);
  } else if (current !== O) {
    throw new MoveRefusal(`Workspace ${W} is owned by ${current}, neither the service owner nor the original owner. Refusing to touch it.`);
  } else {
    log(`${SCRIPT}: the workspace is already owned by ${journal.owner.email}`);
  }

  if (journal.tempMembershipId) {
    const gone = await db.from("account_link_invites").delete().eq("id", journal.tempMembershipId).eq("workspace_id", W).eq("invitee_user_id", S).select("id");
    if (gone.error) throw new Error(`account_link_invites: ${gone.error.message}`);
    if ((gone.data ?? []).length) log(`${SCRIPT}: removed the temporary service-owner membership`);
  }

  const restore = await db
    .from("portal_workspaces")
    .update({
      name: before.name,
      city: before.city ?? null,
      is_service: before.is_service === true,
      owner_of_record_name: before.owner_of_record_name ?? null,
    })
    .eq("id", W)
    .eq("owner_user_id", O)
    .select("id");
  if (restore.error) throw new Error(`portal_workspaces: ${restore.error.message}`);
  if (journal.createdDefaultId) {
    // Only the empty default we created is removed, and only when nothing has been put in it since.
    const id = journal.createdDefaultId;
    const [houses, members, numbers] = await Promise.all([
      db.from("manager_property_records").select("id").eq("workspace_id", id),
      db.from("account_link_invites").select("id").eq("workspace_id", id),
      db.from("manager_sms_numbers").select("id").eq("workspace_id", id),
    ]);
    const empty = [houses, members, numbers].every((r) => !r.error && (r.data ?? []).length === 0);
    if (empty) {
      const del = await db.from("portal_workspaces").delete().eq("id", id).eq("owner_user_id", O).eq("is_default", true).select("id");
      if (del.error) throw new Error(`portal_workspaces: ${del.error.message}`);
      if ((del.data ?? []).length) log(`${SCRIPT}: removed the empty default workspace created for the owner`);
    } else {
      log(`${SCRIPT}: the default workspace created for the owner (${id}) now holds data; left in place`);
    }
  }
  if (before.is_default) {
    const other = await db.from("portal_workspaces").select("id").eq("owner_user_id", O).eq("is_default", true);
    if (other.error) throw new Error(`portal_workspaces: ${other.error.message}`);
    if ((other.data ?? []).length === 0) {
      const d = await db.from("portal_workspaces").update({ is_default: true }).eq("id", W).eq("owner_user_id", O);
      if (d.error) throw new Error(`portal_workspaces: ${d.error.message}`);
    } else {
      log(`${SCRIPT}: note: the owner now has another default workspace (${other.data[0].id}); ${W} is not their default again`);
    }
  }

  // The RPC clears the old owner's cached sms_from_number and drops holds that would cross owners; put both back.
  const numbers = (journal.snapshotBefore.numberRows ?? []).map((n) => n.phone_number).filter(Boolean);
  if (journal.ownerSmsFromNumber && numbers.includes(journal.ownerSmsFromNumber)) {
    const prof = await db.from("profiles").select("sms_from_number").eq("id", O).maybeSingle();
    if (!prof.error && prof.data && !prof.data.sms_from_number) {
      await db.from("profiles").update({ sms_from_number: journal.ownerSmsFromNumber }).eq("id", O);
    }
  }
  for (const hold of journal.holdsBefore ?? []) {
    const have = await db.from("workspace_work_numbers").select("number_id").eq("workspace_id", hold.workspace_id).eq("number_id", hold.number_id);
    if (!have.error && (have.data ?? []).length === 0) {
      const back = await db.from("workspace_work_numbers").insert(hold);
      if (back.error) log(`${SCRIPT}: could not restore a number hold (${back.error.message}); it is in the journal`);
    }
  }
  save(journal);

  const after = await readSnapshot(db, {
    workspaceId: W,
    houseIds: journal.houseIds,
    now: new Date(journal.snapshotBefore.asOf),
  });
  const problems = [...diffSnapshots(journal.snapshotBefore, after), ...ownerProblems(after, O)];
  const w = after.workspace;
  if (!w || w.owner_user_id !== O) problems.push("the workspace is not back with its original owner");
  if (w && (w.is_service !== (before.is_service === true) || w.name !== before.name)) problems.push("the workspace name / service flag was not restored");
  return { after, problems };
}

/* ------------------------------------- run ------------------------------------- */

function readJournal(path, deps) {
  let parsed;
  try {
    parsed = JSON.parse((deps.readFile ?? ((p) => readFileSync(p, "utf8")))(path));
  } catch {
    throw new UsageError(`--undo: cannot read a journal at ${path}.`);
  }
  if (parsed?.kind !== JOURNAL_KIND) throw new UsageError("--undo: that file is not a move-houses journal.");
  return parsed;
}

export async function run(argv, deps = {}) {
  const { flags, db, log, resolved, facts } = bootstrap(
    SCRIPT,
    argv,
    {
      strings: ["owner-email", "owner-name", "label", "workspace-id", "city", "expect-houses", "undo", "journal-out"],
      booleans: ["acknowledge-unmoved"],
    },
    { write: (f) => Boolean(f.apply || f.undo), deps },
  );
  const apply = Boolean(flags.apply);
  const report = deps.report ?? {};

  /* --- undo --- */
  if (flags.undo) {
    const journal = readJournal(flags.undo, deps);
    if (journal.ref !== resolved.ref) throw new MoveRefusal(`That journal is for project ${journal.ref}, not ${resolved.ref}.`);
    if (journal.state === "undone") {
      log(`${SCRIPT}: that journal is already undone. Nothing to do.`);
      return 0;
    }
    log(`${SCRIPT}: undo: workspace ${journal.workspace.id} -> back to ${journal.owner.email}; ${journal.houseIds.length} house(s)`);
    if (!apply) {
      log(`${SCRIPT}: dry run, nothing written. Re-run with --apply to undo.`);
      return 0;
    }
    const save = journalWriter(deps, flags.undo);
    const { problems } = await undoMove(db, journal, { log, save, deps });
    journal.undo = { at: new Date().toISOString(), problems };
    if (problems.length) {
      journal.state = "undo-failed";
      save(journal);
      for (const p of problems) log(`${SCRIPT}: UNDO CHECK FAILED: ${p}`);
      report.problems = problems;
      return 1;
    }
    journal.state = "undone";
    save(journal);
    log(`${SCRIPT}: undone and verified: every count, member, number and owner matches the snapshot taken before the move.`);
    return 0;
  }

  /* --- move --- */
  if (!flags["owner-email"]) {
    if (flags["owner-name"]) await listCandidates(db, flags["owner-name"], log);
    throw new UsageError("--owner-email <the owner's account email> is required (use --owner-name to list matching accounts).");
  }
  const label = clean(flags.label);
  if (!label || label.length > 80) throw new UsageError('--label "<workspace name, 1-80 characters>" is required (for example --label Ambika).');
  const city = clean(flags.city ?? "Seattle");
  if (!city || city.length > 80) throw new UsageError("--city must be 1-80 characters.");

  const service = await serviceOwner(db);
  const owner = await findOwnerByEmail(db, flags["owner-email"]);
  if (owner.id === service.id) throw new MoveRefusal("That is the service owner's own account; there is nothing to move.");

  const world = await loadOwnerWorld(db, owner.id, city);
  const asked = flags["workspace-id"] ? clean(flags["workspace-id"]) : null;
  if (asked && !UUID.test(asked)) throw new UsageError("--workspace-id must be a workspace uuid.");
  const candidates = world.classified.filter((c) => c.candidate);
  let target;
  if (asked) {
    target = world.classified.find((c) => c.workspace.id.toLowerCase() === asked.toLowerCase());
    if (!target) {
      const done = await db.from("portal_workspaces").select("id, name, owner_user_id, is_service").eq("id", asked).maybeSingle();
      const link = done.data
        ? await db.from("account_link_invites").select("id").eq("workspace_id", done.data.id).eq("invitee_user_id", owner.id).eq("is_owner_of_record", true).in("status", ["pending", "accepted"])
        : { data: [] };
      if (done.data?.is_service && done.data.owner_user_id === service.id && (link.data ?? []).length) {
        log(`${SCRIPT}: "${done.data.name}" ${done.data.id} is already a service workspace with ${owner.email} as owner of record. Nothing to do.`);
        report.alreadyMoved = [done.data.id];
        return 0;
      }
      throw new MoveRefusal(`Workspace ${asked} is not one of ${owner.email}'s workspaces.`);
    }
    // An explicit --workspace-id is the captain's override: the city gate is skipped (the houses are still listed).
    target = { ...target, movable: true, mixed: false };
    log(`${SCRIPT}: --workspace-id given: the ${city} city check is SKIPPED for this workspace (${target.inCity} house(s) in ${city}, ${target.elsewhere.length} elsewhere, ${target.unknown.length} with no readable city)`);
  } else if (candidates.length === 0) {
    const mine = await db
      .from("portal_workspaces")
      .select("id, name")
      .eq("owner_user_id", service.id)
      .eq("is_service", true);
    const links = await db.from("account_link_invites").select("workspace_id").eq("invitee_user_id", owner.id).eq("is_owner_of_record", true).in("status", ["pending", "accepted"]);
    const done = (mine.data ?? []).filter((w) => (links.data ?? []).some((l) => l.workspace_id === w.id));
    if (done.length) {
      log(`${SCRIPT}: ${owner.email} already has a service workspace as owner of record: ${done.map((d) => `"${d.name}" ${d.id}`).join(", ")}. Nothing to do.`);
      report.alreadyMoved = done.map((d) => d.id);
      return 0;
    }
    throw new MoveRefusal(`${owner.email} owns no workspace with a house in ${city}.`);
  } else if (candidates.length > 1) {
    const lines = candidates.map((c) => `${c.workspace.id} "${c.workspace.name}" (${c.inCity} in ${city}, ${c.houses.length} houses)`);
    throw new MoveRefusal(`${owner.email} has ${candidates.length} workspaces with ${city} houses; pick one with --workspace-id:\n  ${lines.join("\n  ")}`);
  } else target = candidates[0];

  if (target.workspace.is_service) throw new MoveRefusal(`"${target.workspace.name}" is already a service workspace.`);
  if (target.houses.length === 0) throw new MoveRefusal("That workspace holds no houses.");
  if (target.mixed || !target.movable) {
    const lines = target.houses.map((h) => `${h.id}  ${houseLabel(h)}  -> ${h.city ?? "city not readable"}`);
    throw new MoveRefusal(
      `STOP: "${target.workspace.name}" mixes cities or holds a house whose city cannot be read (${target.inCity} in ${city}, ${target.elsewhere.length} elsewhere, ${target.unknown.length} unreadable). ` +
        `The script never splits a workspace. Fix the addresses or move the other houses out first:\n  ${lines.join("\n  ")}`,
    );
  }
  const W = target.workspace.id;
  const houseIds = target.houses.map((h) => h.id).sort();

  const servicesNames = await db.from("portal_workspaces").select("id, name").eq("owner_user_id", service.id);
  if (servicesNames.error) throw new Error(`portal_workspaces: ${servicesNames.error.message}`);
  if ((servicesNames.data ?? []).some((w) => clean(w.name).toLowerCase() === label.toLowerCase())) {
    throw new MoveRefusal(`The service owner already has a workspace named "${label}". Choose another --label.`);
  }
  const seated = await db
    .from("account_link_invites")
    .select("id")
    .eq("workspace_id", W)
    .eq("invitee_user_id", service.id)
    .in("status", ["pending", "accepted"]);
  if (seated.error) throw new Error(`account_link_invites: ${seated.error.message}`);
  if ((seated.data ?? []).length) throw new MoveRefusal("The service owner already has a membership row in that workspace; remove it first so the move starts from a known state.");

  const snap = await readSnapshot(db, { workspaceId: W, houseIds });
  const left = leftBehind(snap, owner.id);
  const history = workspaceHistory(snap);
  const summaries = houseSummaries(target.houses.map((h) => ({ ...h, label: houseLabel(h) })), snap);
  printPlan(log, { owner, service, target, houses: target.houses, summaries, snap, left, history, label, city });
  report.plan = { workspaceId: W, houseIds, left, ownerId: owner.id };

  const ackFlag = left.length ? " --acknowledge-unmoved" : "";
  if (!apply) {
    log(`${SCRIPT}: dry run, nothing written. To apply: add --apply --expect-houses ${houseIds.length}${ackFlag}${resolved.target === "production" ? ' --reason "<why>" --backup <backup file made with this --owner-email>' : ""}`);
    return 0;
  }

  /* --- apply guards --- */
  if (String(flags["expect-houses"] ?? "") !== String(houseIds.length)) {
    throw new MoveRefusal(`--expect-houses ${houseIds.length} is required (the count the dry run showed); got ${flags["expect-houses"] ?? "none"}.`);
  }
  if (left.length && !flags["acknowledge-unmoved"]) {
    throw new MoveRefusal("Rows are left behind (listed above). Re-run with --acknowledge-unmoved to accept that, or have the transfer extended first.");
  }
  if (resolved.target === "production") {
    const move = facts.backup?.move;
    if (!move || clean(move.ownerEmail).toLowerCase() !== clean(owner.email).toLowerCase() || !(move.workspaceIds ?? []).includes(W)) {
      throw new MoveRefusal(`The backup was not taken for this move. Run backup.mjs with --owner-email ${owner.email} and use that file.`);
    }
  }

  const path = flags["journal-out"] ?? join(BACKUP_DIR, `one-number-move-houses-${resolved.target}-${timestamp()}.json`);
  const save = journalWriter(deps, path);
  const holds = snap.numberRows.length
    ? await fetchAll(db, "workspace_work_numbers", "*", {
        key: "number_id",
        offsetPaging: true,
        filter: (q) => q.in("number_id", snap.numberRows.map((n) => n.id)),
      })
    : { rows: [] };
  const journal = {
    kind: JOURNAL_KIND,
    version: 1,
    target: resolved.target,
    ref: resolved.ref,
    createdAt: new Date().toISOString(),
    reason: facts.reason ?? null,
    state: "planned",
    label,
    city,
    owner: { id: owner.id, email: owner.email, name: owner.full_name ?? null },
    service: { id: service.id, email: service.email },
    workspace: { id: W, name: target.workspace.name },
    houseIds,
    ownerSmsFromNumber: owner.sms_from_number ?? null,
    holdsBefore: holds.rows ?? [],
    leftBehind: left,
    snapshotBefore: snap,
    steps: [],
  };
  save(journal);
  log(`${SCRIPT}: journal ${path}`);

  let outcome;
  try {
    outcome = await applyMove(db, { owner, service, target, label, city, houseIds, journal, save, log });
  } catch (error) {
    log(`${SCRIPT}: FAILED during the move: ${error instanceof Error ? error.message : String(error)}. Undoing.`);
    outcome = { problems: [`exception: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (outcome.problems.length) {
    for (const p of outcome.problems) log(`${SCRIPT}: CHECK FAILED: ${p}`);
    journal.state = "failed";
    save(journal);
    try {
      const undone = await undoMove(db, journal, { log, save, deps });
      journal.state = undone.problems.length ? "undo-failed" : "undone";
      journal.undo = { at: new Date().toISOString(), problems: undone.problems, automatic: true };
      save(journal);
      if (undone.problems.length) {
        for (const p of undone.problems) log(`${SCRIPT}: UNDO CHECK FAILED: ${p}`);
        log(`${SCRIPT}: the automatic undo did not restore everything. Journal: ${path}. Stop and read it before doing anything else.`);
      } else {
        log(`${SCRIPT}: undone and verified; the workspace is back with ${owner.email}. Journal: ${path}`);
      }
    } catch (error) {
      journal.state = "undo-failed";
      save(journal);
      log(`${SCRIPT}: the automatic undo FAILED: ${error instanceof Error ? error.message : String(error)}. Journal: ${path}. Run --undo ${path} after fixing the cause.`);
    }
    report.problems = outcome.problems;
    return 1;
  }

  journal.state = "applied";
  save(journal);
  log(`${SCRIPT}: moved and verified. ${houseIds.length} house(s), residents, leases, bookings, charges, conversations, members and numbers match the snapshot taken first.`);
  log(`${SCRIPT}: ${owner.email} can open "${label}" as Admin (owner of record). Undo: --apply --undo ${path}`);
  report.journal = path;
  return 0;
}

if (isMain(import.meta.url)) await runMain(SCRIPT, () => run(process.argv.slice(2)));
