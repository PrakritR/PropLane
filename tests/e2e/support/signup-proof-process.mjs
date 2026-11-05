/** Own only newly spawned process groups; never discover or kill another server. */
export async function stopOwnedChild(child, { kill = process.kill, timeoutMs = 5000, reapTimeoutMs = 2000 } = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 1) throw new Error("Owned signup process identity unavailable.");
  const exited = child.exitCode !== null || child.signalCode !== null;
  const completion = exited ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
  const signal = (name) => {
    try { kill(-child.pid, name); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  let timer;
  try {
    await Promise.race([completion, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally { clearTimeout(timer); }
  // The leader may exit before its workers. Reap the entire owned group.
  signal("SIGKILL");
  await completion;
  const deadline = Date.now() + reapTimeoutMs;
  do {
    try { kill(-child.pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error("Owned signup process group is still live.");
}

/** Recovery always runs; account cleanup requires complete owned-process shutdown first. */
export async function finishOwnedProof(child, { writeReceipt, finalize, recover, stopChild = stopOwnedChild }) {
  let result = 1;
  try {
    await stopChild(child, { timeoutMs: 10_000 });
    await writeReceipt();
    result = await finalize();
  } finally {
    if (await recover() !== 0) result = 1;
  }
  return result;
}
