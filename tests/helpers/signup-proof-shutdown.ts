/** Post-server gate for the cleanup adapter. Never signals a discovered PID. */
import { lstatSync, readFileSync, realpathSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";

type Proof = { origin: string; pid: number; wrapperPid: number; runNonce: string; portClosed: boolean };
const refused = (): never => { throw new Error("Signup process shutdown proof refused."); };
function groupAbsent(pid: number): boolean {
  for (const target of [pid, -pid]) {
    try { process.kill(target, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
  }
  return true;
}
export function proveSignupShutdown(dir: string, origin: string, runNonce: string, absent = groupAbsent): void {
  try {
    const folder = lstatSync(dir);
    if (!path.isAbsolute(dir) || realpathSync(dir) !== dir || !folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o777) !== 0o700 || !/^[a-f0-9]{32}$/.test(runNonce) || existsSync(path.join(dir, "server-ready.json"))) refused();
    const file = path.join(dir, "server-stopped.json"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) refused();
    const proof = JSON.parse(readFileSync(file, "utf8")) as Proof;
    if (proof.origin !== origin || proof.runNonce !== runNonce || proof.portClosed !== true || !Number.isSafeInteger(proof.pid) || proof.pid <= 1 || !Number.isSafeInteger(proof.wrapperPid) || proof.wrapperPid <= 1 || !absent(proof.pid) || !absent(proof.wrapperPid)) refused();
    const testsFile = path.join(dir, "tests-stopped.json"), testsStat = lstatSync(testsFile);
    if (!testsStat.isFile() || testsStat.isSymbolicLink() || (testsStat.mode & 0o777) !== 0o600 || testsStat.size > 4096) refused();
    const tests = JSON.parse(readFileSync(testsFile, "utf8")) as { pid: number; runNonce: string };
    if (!Number.isSafeInteger(tests.pid) || tests.pid <= 1 || tests.runNonce !== runNonce || !absent(tests.pid)) refused();
    for (const name of readdirSync(dir).filter((name) => /^phone-worker-[0-9]+\.json$/.test(name))) {
      const workerFile = path.join(dir, name), workerStat = lstatSync(workerFile);
      if (!workerStat.isFile() || workerStat.isSymbolicLink() || (workerStat.mode & 0o777) !== 0o600 || workerStat.size > 4096) refused();
      const worker = JSON.parse(readFileSync(workerFile, "utf8")) as { pid: number; runNonce: string };
      if (!Number.isSafeInteger(worker.pid) || worker.pid <= 1 || name !== `phone-worker-${worker.pid}.json` || worker.runNonce !== runNonce || !absent(worker.pid)) refused();
    }
  } catch { refused(); }
}
export async function verifySignupPortClosed(origin: string): Promise<void> {
  if (!["http://localhost:3000", "http://localhost:3007", "http://localhost:3008", "http://localhost:3010"].includes(origin)) refused();
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error("Signup process shutdown proof refused.")));
    probe.listen(Number(new URL(origin).port), "127.0.0.1", () => probe.close(() => resolve()));
  });
}
