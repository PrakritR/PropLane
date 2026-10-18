import { existsSync, readFileSync } from "node:fs";

/**
 * Target + guard resolution shared by every one-number migration script.
 *
 * Fail closed. A script never guesses where it points: `--target` is required, the Supabase project
 * ref is read from the URL it will actually talk to and printed, and the ref must be the one the
 * named target owns. Anything that is not dev needs `--confirm-ref <ref>` even to READ. A WRITE
 * (`--apply`) on production needs every guard at once:
 *   --target production --apply --confirm-ref qahnczmilgptcedaqype --reason "<text>" --backup <path>
 * where <path> is a fresh file written by backup.mjs for that same project.
 *
 * These scripts are never run by an agent against staging or production. A human (or claude-1 on
 * the captain's explicit go) runs them.
 */

export const TARGET_REFS = Object.freeze({
  dev: "emstjswhotsnyksqhqyf",
  staging: "xwszcafaontidfgznlxd",
  production: "qahnczmilgptcedaqype",
});

export const BACKUP_KIND = "one-number-backup";
export const BACKUP_MAX_AGE_MINUTES = 120;
export const MIN_REASON_LENGTH = 10;

export class GuardError extends Error {}

export function refFromUrl(url) {
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co(?:\/|$)/i.exec(String(url ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

/** The credentials an env gives us, and the project they belong to. Throws a GuardError when unusable. */
export function resolveTarget({ target, env }) {
  if (!target || !Object.hasOwn(TARGET_REFS, target)) {
    throw new GuardError("--target dev|staging|production is required (there is no default).");
  }
  const url = (env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL ?? "").trim();
  const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!url) throw new GuardError("No Supabase URL in the environment (NEXT_PUBLIC_SUPABASE_URL).");
  const ref = refFromUrl(url);
  if (!ref) throw new GuardError(`Refusing: "${url}" is not a hosted Supabase project URL.`);
  const expected = TARGET_REFS[target];
  if (ref !== expected) {
    const owner = Object.entries(TARGET_REFS).find(([, value]) => value === ref)?.[0] ?? "an unknown project";
    throw new GuardError(`Refusing: --target ${target} expects project ${expected} but the environment points at ${ref} (${owner}).`);
  }
  if (!key) throw new GuardError("SUPABASE_SERVICE_ROLE_KEY is required.");
  return { target, ref, url, key };
}

/** A backup file is usable for a production write only when it is recent, complete and for this project. */
export function validateBackup(path, { ref, now = Date.now(), exists = existsSync, read = (p) => readFileSync(p, "utf8") }) {
  if (!path) throw new GuardError("--backup <path> is required (run backup.mjs first).");
  if (!exists(path)) throw new GuardError(`Backup file not found: ${path}`);
  let parsed;
  try {
    parsed = JSON.parse(read(path));
  } catch {
    throw new GuardError(`Backup file is not valid JSON: ${path}`);
  }
  const meta = parsed?.meta;
  if (!meta || meta.kind !== BACKUP_KIND) throw new GuardError("That file was not written by backup.mjs.");
  if (meta.complete !== true) throw new GuardError("That backup is incomplete.");
  if (meta.ref !== ref) throw new GuardError(`That backup is for project ${meta.ref}, not ${ref}.`);
  const created = Date.parse(meta.createdAt);
  if (!Number.isFinite(created)) throw new GuardError("That backup has no creation time.");
  const ageMinutes = (now - created) / 60000;
  if (ageMinutes < -5) throw new GuardError("That backup is dated in the future.");
  if (ageMinutes > BACKUP_MAX_AGE_MINUTES) {
    throw new GuardError(`That backup is ${Math.round(ageMinutes)} minutes old; take a fresh one (max ${BACKUP_MAX_AGE_MINUTES}).`);
  }
  return meta;
}

/**
 * Throws a GuardError unless the run is allowed. `write` is true for anything that mutates the
 * database (--apply, including rollback and undo). Returns the facts to print.
 */
export function assertGuards({ resolved, write, flags, now, fsDeps }) {
  const { target, ref } = resolved;
  if (target !== "dev") {
    if (flags["confirm-ref"] !== ref) {
      throw new GuardError(`--target ${target} needs --confirm-ref ${ref} (even for a dry run).`);
    }
  }
  const out = { target, ref, write, reason: null, backup: null };
  if (write && target !== "dev") {
    const reason = String(flags.reason ?? "").trim();
    if (reason.length < MIN_REASON_LENGTH) {
      throw new GuardError(`--reason "<text>" (at least ${MIN_REASON_LENGTH} characters) is required to write to ${target}.`);
    }
    out.reason = reason;
  }
  if (write && target === "production") {
    out.backup = validateBackup(flags.backup, { ref, now, ...(fsDeps ?? {}) });
    out.backupPath = flags.backup;
  }
  return out;
}

export function describeRun(facts, script) {
  const mode = facts.write ? "APPLY (writes)" : "DRY RUN (reads only)";
  const lines = [
    `${script}: target=${facts.target} project=${facts.ref}`,
    `${script}: mode=${mode}`,
  ];
  if (facts.reason) lines.push(`${script}: reason=${facts.reason}`);
  if (facts.backup) lines.push(`${script}: backup=${facts.backupPath} (made ${facts.backup.createdAt})`);
  return lines;
}
