import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listMigrations } from "../../scripts/one-number/list-migrations.mjs";

const root = join(__dirname, "..", "..");
const runbook = readFileSync(join(root, "docs/agents/one-number-runbook.md"), "utf8");
const COMMON = ["target", "env-file", "confirm-ref", "reason", "backup", "apply", "help"];

describe("the cutover runbook cannot rot", () => {
  it("names every one-number migration on disk (and the order is the timestamp order)", () => {
    const onDisk = listMigrations("20261018");
    expect(onDisk.length).toBeGreaterThan(0);
    for (const m of onDisk) expect(runbook, `${m.file} missing from the runbook`).toContain(m.version);
    const listed = [...runbook.matchAll(/^\| (20261018\d{6}) \|/gm)].map((m) => m[1]);
    expect([...listed].sort()).toEqual(listed);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("every migration the runbook names exists on disk or says which branch carries it", () => {
    const disk = new Set(listMigrations("20261018").map((m: { version: string }) => m.version));
    for (const line of runbook.split("\n").filter((l) => /^\| 20261018\d{6} \|/.test(l))) {
      const version = /^\| (\d+) \|/.exec(line)![1]!;
      expect(disk.has(version) || /branch/.test(line), `${version} is neither on disk nor marked as a branch`).toBe(true);
    }
  });

  it("only mentions scripts that exist", () => {
    const scripts = new Set(readdirSync(join(root, "scripts/one-number")).filter((f) => f.endsWith(".mjs")));
    for (const m of runbook.matchAll(/scripts\/one-number\/([a-z-]+\.mjs)/g)) expect(scripts.has(m[1]!), m[1]).toBe(true);
  });

  it("only uses flags the script it calls accepts", () => {
    const blocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    let checked = 0;
    for (const block of blocks) {
      // Join continuation lines, then read each command.
      const commands = block.replace(/\\\n\s*/g, " ").split("\n").filter((l) => l.includes("scripts/one-number/"));
      for (const command of commands) {
        const script = /scripts\/one-number\/([a-z-]+\.mjs)/.exec(command)![1]!;
        const source = readFileSync(join(root, "scripts/one-number", script), "utf8");
        const prelude = ["backfill.mjs", "backup.mjs", "cutover.mjs", "verify.mjs", "shadow-report.mjs", "create-service-workspace.mjs"].includes(script);
        for (const flag of [...command.matchAll(/ --([a-z][a-z-]*)/g)].map((m) => m[1]!)) {
          const accepted = (prelude && COMMON.includes(flag)) || source.includes(`"${flag}"`) || source.includes(`flags.${flag}`) || source.includes(`"--${flag}"`);
          expect(accepted, `${script} does not accept --${flag}`).toBe(true);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("states the guards and where the dangerous steps stop", () => {
    for (const phrase of ["confirm-ref qahnczmilgptcedaqype", "Agents do not run this", "--rollback", "--undo", "qahnczmilgptcedaqype"]) expect(runbook).toContain(phrase);
    expect(existsSync(join(root, "scripts/one-number/backup.mjs"))).toBe(true);
  });
});
