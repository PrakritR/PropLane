import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { UsageError, parseArgs } from "./args.mjs";
import { GuardError, assertGuards, describeRun, resolveTarget } from "./target.mjs";

/** Flags every migration script accepts. */
export const COMMON_STRINGS = ["target", "env-file", "confirm-ref", "reason", "backup"];
export const COMMON_BOOLEANS = ["apply", "help"];

/**
 * Parse, load env, resolve the target and enforce the guards, then hand back a service-role client.
 * Everything that can go wrong is a GuardError / UsageError; `main` turns those into exit code 2.
 * `deps` lets tests inject the env, the client factory and the file reads.
 */
export function bootstrap(script, argv, spec, { write, deps = {} } = {}) {
  const { flags, rest } = parseArgs(argv, {
    booleans: [...COMMON_BOOLEANS, ...(spec.booleans ?? [])],
    strings: [...COMMON_STRINGS, ...(spec.strings ?? [])],
  });
  // The env FILE wins over whatever the shell already exports, so an ambient dev URL can never be mixed with a
  // production file (or the reverse). A project ref that does not match --target is refused either way.
  let env = { ...(deps.env ?? process.env) };
  if (!deps.env) {
    const file = flags["env-file"] ?? (flags.target === "dev" && existsSync(".env.local") ? ".env.local" : null);
    if (flags["env-file"] && !existsSync(flags["env-file"])) throw new UsageError(`--env-file not found: ${flags["env-file"]}`);
    if (file) env = { ...env, ...parseEnv(readFileSync(file, "utf8")) };
  }
  const resolved = resolveTarget({ target: flags.target, env });
  const wantsWrite = typeof write === "function" ? write(flags) : Boolean(write ?? flags.apply);
  const facts = assertGuards({ resolved, write: wantsWrite, flags, now: deps.now ?? Date.now(), fsDeps: deps.fsDeps });
  const lines = describeRun(facts, script);
  for (const line of lines) (deps.log ?? console.log)(line);
  const db = deps.db ?? (deps.createClient ?? createClient)(resolved.url, resolved.key, { auth: { persistSession: false } });
  return { flags, rest, resolved, facts, db, log: deps.log ?? console.log };
}

/** Run `fn`, mapping guard/usage errors to exit code 2 and any other failure to 1. */
export async function runMain(script, fn) {
  try {
    const code = await fn();
    process.exitCode = typeof code === "number" ? code : 0;
  } catch (error) {
    if (error instanceof GuardError || error instanceof UsageError) {
      console.error(`${script}: REFUSED. ${error.message}`);
      process.exitCode = 2;
    } else {
      console.error(`${script}: FAILED. ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(importMetaUrl) === process.argv[1];
}
