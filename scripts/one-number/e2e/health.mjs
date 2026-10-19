/**
 * Dev database health gate. The shared dev project was knocked over by an hour-long run plus a parallel reap, so the
 * harness asks before every scenario: GET /rest/v1/profiles?select=id&limit=1 with the ANON key must answer 200 in under
 * 2 s. Otherwise it waits (60 s backoff, at most 20 minutes) and then gives up so the run stops instead of piling on.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function anonKey(env) {
  return (env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();
}

/** One probe. Never throws: { ok, status, ms }. */
export async function probe(resolved, env, { timeoutMs = 5000 } = {}) {
  const key = anonKey(env);
  const started = Date.now();
  try {
    const res = await fetch(`${resolved.url}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer().catch(() => {});
    const ms = Date.now() - started;
    return { ok: res.status === 200 && ms < 2000, status: res.status, ms };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(error?.message ?? error) };
  }
}

/** Wait until the probe is healthy; resolves with the last probe, throws after `maxWaitMs` (default 20 min). */
export async function waitHealthy(resolved, env, log = console.log, { backoffMs = 60_000, maxWaitMs = 20 * 60_000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let p = await probe(resolved, env);
  while (!p.ok) {
    if (Date.now() + backoffMs > deadline) throw new Error(`dev database unhealthy for ${Math.round(maxWaitMs / 60000)} min (last probe: status ${p.status}, ${p.ms} ms ${p.error ?? ""}); stopping`);
    log(`  dev db unhealthy (status ${p.status}, ${p.ms} ms); waiting ${backoffMs / 1000} s`);
    await sleep(backoffMs);
    p = await probe(resolved, env);
  }
  return p;
}

/**
 * Other agents run this harness against the same dev project. Two runs flip the same sms_runtime_config singleton, so a second
 * one corrupts the first. Wait (polling the process table) until no other `node ... e2e-scenarios.mjs` is running.
 */
export async function waitForOtherRuns(log = console.log, { maxWaitMs = 60 * 60_000 } = {}) {
  const { execFileSync } = await import("node:child_process");
  const others = () => {
    let out = "";
    try { out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }); } catch { return []; }
    return out.split("\n").map((l) => l.trim()).filter((l) => /^\d+\s+(\S*\/)?node\s+\S*e2e-scenarios\.mjs/.test(l) && !l.includes("--check-config") && !l.includes("--reap") && !l.startsWith(`${process.pid} `));
  };
  const deadline = Date.now() + maxWaitMs;
  let list = others();
  while (list.length) {
    if (Date.now() > deadline) throw new Error(`another e2e run is still going: ${list[0]}`);
    log(`  another e2e run is active (${list[0].slice(0, 120)}); waiting 30 s`);
    await sleep(30_000);
    list = others();
  }
}

/**
 * The dev e2e lock the coordinator asked for: `mkdir $HOME/.cockpit/slots-1018/e2e.lock` (atomic; fails when held). Holder info
 * (branch + pid) goes in `holder`. A lock whose pid is dead is stale and is taken over. Retries every 60 s up to `maxWaitMs`.
 * Returns a release() function (idempotent); also released on exit/SIGINT/SIGTERM by the caller.
 */
export async function acquireE2eLock(log = console.log, { branch = "on/smsmatrix", maxWaitMs = 3 * 60 * 60_000 } = {}) {
  const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const base = `${homedir()}/.cockpit/slots-1018`;
  const lock = `${base}/e2e.lock`;
  mkdirSync(base, { recursive: true });
  const deadline = Date.now() + maxWaitMs;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(`${lock}/owner`, `${branch} pid ${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = "";
      try { holder = readFileSync(`${lock}/owner`, "utf8").trim(); } catch { /* being written */ }
      const pid = Number(/pid[= ](\d+)/.exec(holder)?.[1] ?? NaN);
      if (Number.isFinite(pid) && !alive(pid)) { log(`  e2e lock held by dead pid ${pid} (${holder}); taking over`); rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`e2e lock still held after ${Math.round(maxWaitMs / 60000)} min: ${holder}`);
      log(`  e2e lock held (${holder || "unknown holder"}); retrying in 60 s`);
      await sleep(60_000);
    }
  }
  let released = false;
  const release = () => { if (released) return; released = true; try { rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ } };
  process.on("exit", release);
  return release;
}
