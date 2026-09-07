/**
 * PRP-358 — `npm run seed:env` must not hand a worktree the production env file.
 *
 * Next loads `.env.production.local` for ANY production build and it outranks
 * `.env.local`, so a worktree that was seeded with it had every local
 * `npm run build && npm run start` silently pointed at the LIVE Supabase
 * project — a QA sweep ran against production for a minute that way. The seed
 * script copied every gitignored `.env*` file and merely printed a warning.
 *
 * This drives the real script against a throwaway git repository with a linked
 * worktree, exactly the shape `treehouse` creates, so the filter is tested where
 * it runs rather than re-implemented in the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../../scripts/seed-worktree-env.mjs");

let sandbox: string;
let primary: string;
let worktree: string;

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function runSeed(args: string[] = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd: worktree,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "seed-env-"));
  primary = join(sandbox, "primary");
  worktree = join(sandbox, "lane");
  git(["init", "-q", "-b", "main", primary], sandbox);
  git(["config", "user.email", "test@example.com"], primary);
  git(["config", "user.name", "Test"], primary);
  writeFileSync(join(primary, ".gitignore"), ".env*\n!.env.example\n");
  writeFileSync(join(primary, ".env.example"), "EXAMPLE=1\n");
  git(["add", "."], primary);
  git(["commit", "-q", "-m", "init"], primary);
  // The secrets a primary checkout really carries.
  writeFileSync(join(primary, ".env"), "SECRET=dev\n");
  writeFileSync(join(primary, ".env.test"), "SECRET=test\n");
  writeFileSync(join(primary, ".env.production.local"), "NEXT_PUBLIC_SUPABASE_URL=https://live.supabase.co\n");
  git(["worktree", "add", "-q", "-b", "lane", worktree], primary);
});

afterEach(() => {
  try {
    git(["worktree", "remove", "--force", worktree], primary);
  } catch {
    /* sandbox is removed below either way */
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("seed-worktree-env withholds the production env file", () => {
  it("copies .env and .env.test but never .env.production.local by default", () => {
    const out = runSeed();
    expect(existsSync(join(worktree, ".env"))).toBe(true);
    expect(existsSync(join(worktree, ".env.test"))).toBe(true);
    expect(existsSync(join(worktree, ".env.production.local"))).toBe(false);
    expect(out).toMatch(/hold\s+\.env\.production\.local/);
    expect(out).toMatch(/--include-production/);
    // No production file arrived, so no production warning either.
    expect(out).not.toMatch(/WARNING/);
  });

  it("copies it only when asked for in so many words, and then warns", () => {
    const out = runSeed(["--include-production"]);
    expect(existsSync(join(worktree, ".env.production.local"))).toBe(true);
    expect(out).toMatch(/WARNING\s+\.env\.production\.local is present/);
    expect(out).toMatch(/rm \.env\.production\.local/);
  });

  it("still warns about a production file an older seed left behind", () => {
    writeFileSync(join(worktree, ".env.production.local"), "NEXT_PUBLIC_SUPABASE_URL=https://live.supabase.co\n");
    const out = runSeed();
    expect(out).toMatch(/WARNING\s+\.env\.production\.local is present/);
  });

  it("dry run reports the hold without writing anything", () => {
    const out = runSeed(["--dry-run"]);
    expect(out).toMatch(/hold\s+\.env\.production\.local/);
    expect(out).toMatch(/would\s+seed \.env$/m);
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    expect(existsSync(join(worktree, ".env.production.local"))).toBe(false);
  });
});
