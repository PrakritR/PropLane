import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BACKUP_DIR = join(homedir(), ".cockpit", "backups");

export function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function writeJsonFile(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}
