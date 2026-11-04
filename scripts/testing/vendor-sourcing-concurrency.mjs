import fs from "node:fs";
import pg from "pg";

/*
 * Prerequisites: apply current migrations to a disposable dev/test database and
 * prepare unique, isolated rows for each race in the JSON manifest. Rows are
 * mutated; this runner does not seed, reset, or clean up. Set
 * VENDOR_SOURCING_CONCURRENCY=1, DATABASE_URL, and
 * VENDOR_SOURCING_CONCURRENCY_FIXTURE. Only local Postgres or the canonical
 * emstjswhotsnyksqhqyf project is accepted.
 *
 * Manifest example (IDs and complete action arguments are fixture-specific):
 * {
 *   "races": [
 *     { "scenario":"decline-vs-revise-or-approve", "name":"decline/revise",
 *       "left":{"kind":"rpc","name":"decline_vendor_service_quote","args":["WORK","MANAGER_UUID","VENDOR","MANAGER_UUID",null,"reason",null]},
 *       "right":{"kind":"rpc","name":"vendor_coordination_action","args":[{"kind":"revise_quote","proposal_id":"PROPOSAL_UUID","expected_version":1,"actor_user_id":"VENDOR_UUID","vendor_directory_id":"VENDOR","quote":{"scope":"repair","laborCents":"1000","materialsCents":"0","consultationFeeCents":"0"},"duration_minutes":60}]},
 *       "assert":{"workOrderId":"WORK","managerUserId":"MANAGER_UUID","proposalId":"PROPOSAL_UUID","expectTerminalDecline":true,"expectedOfferCount":1,"acceptedBidCount":0,"activeReservationCount":0} },
 *     { "scenario":"enrollment-vs-submission", "name":"enrollment/submission", "left":{"kind":"rpc","name":"enroll_vendor_sourcing_candidate","args":["CANDIDATE_UUID","LEASE_UUID"]}, "right":{"kind":"rpc","name":"vendor_coordination_action","args":[{"kind":"revise_quote","proposal_id":"PROPOSAL_UUID"}]}, "assert":{"workOrderId":"WORK2","managerUserId":"MANAGER_UUID","candidateId":"CANDIDATE_UUID","jobId":"JOB_UUID","expectedOfferCount":1,"acceptedBidCount":0,"activeReservationCount":0} },
 *     { "scenario":"resume-vs-decline-or-expiry", "name":"resume/expiry", "left":{"kind":"rpc","name":"control_vendor_sourcing","args":["WORK3","MANAGER_UUID","resume"]}, "right":{"kind":"rpc","name":"invalidate_vendor_service_offers","args":["WORK3","MANAGER_UUID","expired","OFFER_UUID"]}, "assert":{"workOrderId":"WORK3","managerUserId":"MANAGER_UUID","jobId":"JOB_UUID","offerId":"OFFER_UUID","offerStatus":"expired","candidateStatus":"expired","expectedOfferCount":1,"acceptedBidCount":0,"activeReservationCount":0} }
 *   ]
 * }
 * `vendor_coordination_action` takes one JSON object; all other args match
 * migration signatures. `barrierSide` may be left or right to swap which RPC
 * holds the explicit advisory lock while the other is verified waiting. The
 * expectedErrors list cannot whitelist deadlocks, lock timeouts, or cancellations.
 */

const { Client } = pg;
const DEV_PROJECT = "emstjswhotsnyksqhqyf";
const RPC_ALLOWLIST = new Set([
  "decline_vendor_service_quote",
  "vendor_coordination_action",
  "enroll_vendor_sourcing_candidate",
  "control_vendor_sourcing",
  "invalidate_vendor_service_offers",
  "link_vendor_directory_account",
]);
const REQUIRED_RACES = new Set(["decline-vs-revise-or-approve", "enrollment-vs-submission", "resume-vs-decline-or-expiry"]);
const UNACCEPTABLE_EXPECTED_ERRORS = new Set(["40P01", "55P03", "57014"]);
const optIn = process.env.VENDOR_SOURCING_CONCURRENCY;
const databaseUrl = process.env.DATABASE_URL;
const fixturePath = process.env.VENDOR_SOURCING_CONCURRENCY_FIXTURE;

function fail(message) {
  console.error(`vendor-sourcing-concurrency: ${message}`);
  process.exitCode = 1;
}

if (optIn !== "1") {
  fail("refusing to run without VENDOR_SOURCING_CONCURRENCY=1");
} else if (!databaseUrl || !fixturePath) {
  fail("set DATABASE_URL and VENDOR_SOURCING_CONCURRENCY_FIXTURE to a disposable dev/test fixture manifest");
} else {
  await run();
}

async function run() {
  let parsedUrl;
  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    fail("DATABASE_URL is not a valid PostgreSQL URL");
    return;
  }

  // Permit only the canonical dev/test Supabase project or an explicitly local Postgres.
  // A staging/production URL cannot pass this check, even with the opt-in flag.
  const allowedHosts = new Set([`db.${DEV_PROJECT}.supabase.co`, "localhost", "127.0.0.1", "::1"]);
  if (!allowedHosts.has(parsedUrl.hostname)) {
    fail(`database host ${parsedUrl.hostname} is outside the allowed dev/test targets`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  } catch (error) {
    fail(`cannot read fixture manifest: ${error.message}`);
    return;
  }
  if (!Array.isArray(manifest.races) || manifest.races.length < 3) {
    fail("fixture manifest must define at least the decline/revise, enrollment/submission, and resume/terminal races");
    return;
  }
  const configured = new Set(manifest.races.map((race) => race?.scenario));
  const missing = [...REQUIRED_RACES].filter((scenario) => !configured.has(scenario));
  if (missing.length) {
    fail(`manifest is missing required race scenarios: ${missing.join(", ")}`);
    return;
  }
  for (const race of manifest.races) {
    try {
      validateRace(race);
      validateScenario(race);
    } catch (error) {
      fail(error.message);
      return;
    }
  }

  const pair = [new Client({ connectionString: databaseUrl, application_name: "vendor-sourcing-race-a", connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=10000" }), new Client({ connectionString: databaseUrl, application_name: "vendor-sourcing-race-b", connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=10000" })];
  try {
    await Promise.all(pair.map((client) => client.connect()));
    const target = await pair[0].query("select current_database() as database, current_user as role, inet_server_addr()::text as address");
    console.log(`Connected to permitted dev/test database ${target.rows[0].database} (${target.rows[0].address ?? "local socket"}).`);

    for (const race of manifest.races) {
      console.log(`Starting two-connection race: ${race.name}`);
      const outcomes = await racePair(pair, race);
      const fatal = outcomes.filter((outcome) => UNACCEPTABLE_EXPECTED_ERRORS.has(outcome.error?.code));
      if (fatal.length) throw new Error(`${race.name}: fatal concurrency error(s): ${fatal.map((x) => `${x.error.code} ${x.error.message}`).join(" | ")}`);
      const unexpected = outcomes.filter((outcome) => outcome.error && !race.expectedErrors?.includes(outcome.error.code));
      if (unexpected.length) throw new Error(`${race.name}: unexpected SQL error(s): ${unexpected.map((x) => `${x.error.code ?? "?"} ${x.error.message}`).join(" | ")}`);
      await assertOutcome(pair[0], race.assert);
      console.log(`Passed: ${race.name}; outcomes ${outcomes.map((x) => x.error ? `SQLSTATE ${x.error.code}` : "committed").join(" / ")}.`);
    }
    console.log("All configured two-connection concurrency races passed. This evidence applies only to the supplied disposable fixtures and current database schema.");
  } catch (error) {
    fail(error.message);
  } finally {
    await Promise.all(pair.map((client) => client.end().catch(() => {})));
  }
}

function validateRace(race) {
  if (!race || typeof race.name !== "string" || !race.left || !race.right || !race.assert) {
    throw new Error("each race needs name, left, right, and assert fields");
  }
  for (const count of ["expectedOfferCount", "acceptedBidCount", "activeReservationCount"]) {
    if (!Number.isInteger(race.assert[count]) || race.assert[count] < 0) throw new Error(`${race.name}: assert.${count} must be an exact nonnegative count`);
  }
  if (race.expectedErrors !== undefined && !Array.isArray(race.expectedErrors)) {
    throw new Error(`${race.name}: expectedErrors must be an array of SQLSTATE strings`);
  }
  if (race.expectedErrors?.some((code) => UNACCEPTABLE_EXPECTED_ERRORS.has(code))) {
    throw new Error(`${race.name}: expectedErrors cannot allow deadlocks (40P01), lock timeouts (55P03), or cancellation/timeouts (57014)`);
  }
  if (race.barrierSide != null && !["left", "right"].includes(race.barrierSide)) {
    throw new Error(`${race.name}: barrierSide must be left or right`);
  }
  for (const operation of [race.left, race.right]) {
    if (!operation || !["rpc", "directory_identity_update"].includes(operation.kind)) throw new Error(`${race.name}: operations must call an allowlisted database RPC or directory identity update`);
    if (operation.kind === "rpc" && (!RPC_ALLOWLIST.has(operation.name) || !Array.isArray(operation.args))) {
      throw new Error(`${race.name}: RPC must use an approved vendor-sourcing/coordination function with an args array`);
    }
    if (operation.kind === "directory_identity_update" && (!Array.isArray(operation.args) || operation.args.length !== 3)) {
      throw new Error(`${race.name}: baseline identity update needs directory id, manager id, and vendor id`);
    }
    if (operation.kind === "directory_identity_update" && (process.env.VENDOR_LINK_BASELINE !== "1" || !["localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname))) {
      throw new Error(`${race.name}: direct directory identity update is a local baseline-only operation`);
    }
  }
  if (race.boundary && (!Array.isArray(race.boundary) || !race.boundary.length || race.boundary.some((part) => !["directory", "service"].includes(part.kind) || typeof part.id !== "string" || !part.id))) {
    throw new Error(`${race.name}: boundary must list directory/service ids in canonical order`);
  }
  if (race.boundary?.some((part, index) => part.kind === "directory" && index > 0)) {
    throw new Error(`${race.name}: directory boundary must precede service boundaries`);
  }
  const holder = race[race.barrierSide ?? "left"];
  const holderEnrolls = holder.kind === "rpc" && (holder.name === "link_vendor_directory_account" || holder.name === "enroll_vendor_sourcing_candidate" || (holder.name === "vendor_coordination_action" && holder.args[0]?.kind === "enroll"));
  if (holderEnrolls && race.boundary?.[0]?.kind !== "directory") {
    throw new Error(`${race.name}: link/enrollment holder requires an explicit directory-first boundary`);
  }
  if (holderEnrolls && holder.name === "link_vendor_directory_account" && race.boundary[0].id !== holder.args[0]) {
    throw new Error(`${race.name}: directory boundary does not match link RPC directory`);
  }
  if (holderEnrolls && holder.name === "vendor_coordination_action" && race.boundary[0].id !== holder.args[0]?.vendor_directory_id) {
    throw new Error(`${race.name}: directory boundary does not match coordination enrollment directory`);
  }
}

function validateScenario(race) {
  const operationNames = [race.left, race.right].map((operation) => operation.name);
  const actionKinds = [race.left, race.right]
    .filter((operation) => operation.name === "vendor_coordination_action")
    .map((operation) => operation.args[0]?.kind);
  const has = (name) => operationNames.includes(name);
  if (race.scenario === "decline-vs-revise-or-approve") {
    if (!has("decline_vendor_service_quote") || !has("vendor_coordination_action") || !actionKinds.some((kind) => ["revise_quote", "approve_manager"].includes(kind))) {
      throw new Error(`${race.name}: scenario requires decline_vendor_service_quote racing revise_quote or approve_manager`);
    }
  } else if (race.scenario === "enrollment-vs-submission") {
    if (!has("enroll_vendor_sourcing_candidate") || !has("vendor_coordination_action") || !actionKinds.includes("revise_quote")) {
      throw new Error(`${race.name}: scenario requires enroll_vendor_sourcing_candidate racing revise_quote`);
    }
  } else if (race.scenario === "resume-vs-decline-or-expiry") {
    if (!has("control_vendor_sourcing") || !(has("decline_vendor_service_quote") || has("invalidate_vendor_service_offers"))) {
      throw new Error(`${race.name}: scenario requires resume racing decline_vendor_service_quote or an offer expiry transition`);
    }
    if (![race.left, race.right].some((operation) => operation.name === "control_vendor_sourcing" && operation.args[2] === "resume")) {
      throw new Error(`${race.name}: control_vendor_sourcing must use action=resume`);
    }
    if (!(race.assert.expectTerminalDecline || race.assert.offerStatus === "expired" || race.assert.candidateStatus === "expired")) {
      throw new Error(`${race.name}: assert must prove the terminal decline/expiry survived`);
    }
  }
}

async function racePair(clients, race) {
  const holderSide = race.barrierSide ?? "left";
  const contenderSide = holderSide === "left" ? "right" : "left";
  const holderClient = clients[holderSide === "left" ? 0 : 1];
  const contenderClient = clients[contenderSide === "left" ? 0 : 1];
  const boundary = race.boundary ?? [{ kind: "service", id: race.assert.workOrderId }];
  const holderOperation = race[holderSide];
  if (holderOperation.name === "enroll_vendor_sourcing_candidate") {
    const derived = await holderClient.query(`select case when c.source='roster' then c.source_directory_id
      else 'sourced-'||md5(j.manager_user_id::text||':'||c.dedupe_key) end as local_id
      from public.vendor_sourcing_candidates c join public.vendor_sourcing_jobs j on j.id=c.job_id where c.id=$1`, [holderOperation.args[0]]);
    if (derived.rowCount !== 1 || derived.rows[0].local_id !== boundary[0].id) {
      throw new Error(`${race.name}: directory boundary does not match sourcing candidate's derived local id`);
    }
  }
  let holderOpen = false;
  let contenderOpen = false;
  let contenderFinished = false;
  let contenderPromise;

  try {
    await holderClient.query("begin");
    holderOpen = true;
    for (const part of boundary) {
      await holderClient.query(`select public.${part.kind === "directory" ? "lock_vendor_directory" : "lock_vendor_service"}($1)`, [part.id]);
    }
    await contenderClient.query("begin");
    contenderOpen = true;
    const backend = await contenderClient.query("select pg_backend_pid() as pid");
    const contenderPid = backend.rows[0].pid;
    contenderPromise = runOperation(contenderClient, race[contenderSide]).then((result) => {
      contenderFinished = true;
      return result;
    });

    await waitForAdvisoryWait(holderClient, contenderPid, boundary, race.name, () => contenderFinished);
    if (contenderFinished) throw new Error(`${race.name}: contender completed without waiting at the advisory boundary`);

    const holderResult = await runOperation(holderClient, race[holderSide]);
    if (holderResult.error && UNACCEPTABLE_EXPECTED_ERRORS.has(holderResult.error.code)) throw holderResult.error;
    if (holderResult.error) {
      await holderClient.query("rollback");
    } else {
      await holderClient.query("commit");
    }
    holderOpen = false;

    const contenderResult = await contenderPromise;
    if (contenderResult.error && UNACCEPTABLE_EXPECTED_ERRORS.has(contenderResult.error.code)) throw contenderResult.error;
    if (contenderResult.error) {
      await contenderClient.query("rollback");
    } else {
      await contenderClient.query("commit");
    }
    contenderOpen = false;

    return holderSide === "left" ? [holderResult, contenderResult] : [contenderResult, holderResult];
  } catch (error) {
    if (holderOpen) await holderClient.query("rollback").catch(() => {});
    if (contenderOpen) await contenderClient.query("rollback").catch(() => {});
    if (contenderPromise) await contenderPromise.catch(() => {});
    throw error;
  }
}

async function runOperation(client, operation) {
  try {
    if (operation.kind === "directory_identity_update") {
      const result = await client.query("update public.manager_vendor_records set vendor_user_id=$3 where id=$1 and manager_user_id=$2 and vendor_user_id is null", operation.args);
      if (result.rowCount !== 1) throw new Error("baseline directory identity update affected no row");
      return { committed: true };
    }
    const placeholders = operation.args.map((_, index) => `$${index + 1}`).join(", ");
    const cast = operation.name === "vendor_coordination_action" ? "::jsonb" : "";
    await client.query(`select public.${operation.name}(${placeholders}${cast})`, operation.args);
    return { committed: true };
  } catch (error) {
    return { error };
  }
}

async function waitForAdvisoryWait(observer, contenderPid, boundary, raceName, isFinished) {
  const deadline = Date.now() + 7500;
  while (Date.now() < deadline) {
    if (isFinished()) throw new Error(`${raceName}: contender finished before reaching the advisory wait`);
    const result = await observer.query(
      `select a.wait_event_type, a.wait_event, a.state, l.locktype
         from pg_stat_activity a
         join pg_locks l on l.pid=a.pid and not l.granted
        where a.pid=$1 and a.datname=current_database()
          and (l.classid::bigint,l.objid::bigint) in (
            select namespace, ((hashtext(id)::bigint + 4294967296) % 4294967296)
            from unnest($2::bigint[],$3::text[]) as boundary(namespace,id))`,
      [contenderPid, boundary.map((part) => part.kind === "directory" ? 161501 : 161500), boundary.map((part) => part.id)],
    );
    if (result.rows.some((row) => row.wait_event_type === "Lock" && row.wait_event === "advisory" && row.locktype === "advisory")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${raceName}: did not observe the second connection waiting on an advisory lock within 7.5 seconds`);
}

async function assertOutcome(client, assertion) {
  const { workOrderId, managerUserId } = assertion;
  if (!workOrderId || !managerUserId) throw new Error("assert needs workOrderId and managerUserId");
  const work = await client.query("select row_data from public.portal_work_order_records where id=$1 and manager_user_id=$2", [workOrderId, managerUserId]);
  if (work.rowCount !== 1) throw new Error(`assert: fixture work order ${workOrderId} is missing or has a different owner`);
  const proposals = await client.query("select id,status,accepted_bid_id from public.vendor_coordination_proposals where work_order_id=$1 and manager_user_id=$2", [workOrderId, managerUserId]);
  const offers = await client.query("select id,vendor_directory_id,status from public.work_order_vendor_offers where work_order_id=$1 and manager_user_id=$2", [workOrderId, managerUserId]);
  const reservations = await client.query("select id,proposal_id,status from public.vendor_coordination_reservations where work_order_id=$1 and manager_user_id=$2", [workOrderId, managerUserId]);
  const bids = await client.query("select id,status from public.work_order_bids where work_order_id=$1", [workOrderId]);
  const state = {
    work: work.rows[0].row_data,
    proposals: proposals.rows,
    offers: offers.rows,
    reservations: reservations.rows,
    bids: bids.rows,
  };
  if (assertion.proposalId) state.proposal = proposals.rows.find((row) => row.id === assertion.proposalId) ?? null;
  if (assertion.offerId) state.offer = offers.rows.find((row) => row.id === assertion.offerId) ?? null;
  if (assertion.candidateId) {
    const candidate = await client.query("select status,reason,proposal_id,local_directory_id from public.vendor_sourcing_candidates where id=$1", [assertion.candidateId]);
    if (candidate.rowCount !== 1) throw new Error(`assert: candidate ${assertion.candidateId} is missing`);
    state.candidate = candidate.rows[0];
  }
  if (assertion.jobId) {
    const job = await client.query("select state,stage,lease_token from public.vendor_sourcing_jobs where id=$1", [assertion.jobId]);
    if (job.rowCount !== 1) throw new Error(`assert: job ${assertion.jobId} is missing`);
    state.job = job.rows[0];
  }

  // Counts here catch duplicate intents and double financial outcomes. Fixture-specific
  // exact states remain declarative so a race can assert the terminal winner it permits.
  const activeReservations = reservations.rows.filter((row) => row.status === "active");
  const acceptedBids = bids.rows.filter((row) => row.status === "accepted");
  if (activeReservations.length > 1 || acceptedBids.length > 1) throw new Error("assert: duplicate active reservation or accepted bid");
  if (offers.rowCount !== assertion.expectedOfferCount) throw new Error(`assert: expected ${assertion.expectedOfferCount} offers, got ${offers.rowCount}`);
  if (assertion.maxOffers != null && offers.rowCount > assertion.maxOffers) throw new Error(`assert: ${offers.rowCount} offers exceeds maxOffers=${assertion.maxOffers}`);
  if (assertion.candidateStatus && state.candidate?.status !== assertion.candidateStatus) throw new Error(`assert: candidate status expected ${assertion.candidateStatus}, got ${state.candidate?.status}`);
  if (assertion.jobState && state.job?.state !== assertion.jobState) throw new Error(`assert: job state expected ${assertion.jobState}, got ${state.job?.state}`);
  if (assertion.proposalStatus && state.proposal?.status !== assertion.proposalStatus) throw new Error(`assert: proposal status expected ${assertion.proposalStatus}, got ${state.proposal?.status}`);
  if (assertion.offerStatus && state.offer?.status !== assertion.offerStatus) throw new Error(`assert: offer status expected ${assertion.offerStatus}, got ${state.offer?.status}`);
  if (acceptedBids.length !== assertion.acceptedBidCount) throw new Error(`assert: expected ${assertion.acceptedBidCount} accepted bid(s), got ${acceptedBids.length}`);
  if (activeReservations.length !== assertion.activeReservationCount) throw new Error(`assert: expected ${assertion.activeReservationCount} active reservation(s), got ${activeReservations.length}`);
  if (assertion.expectTerminalDecline && !(state.candidate?.status === "declined" || state.proposal?.status === "declined" || offers.rows.some((row) => row.status === "declined"))) {
    throw new Error("assert: no terminal decline state survived the race");
  }
}
