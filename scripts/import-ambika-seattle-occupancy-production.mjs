/**
 * PLAN-0918-1909 fail-closed entry. Logic lives in the sibling .ts file.
 *
 * Dry-run (default):
 *   node --env-file=.env.production.local \
 *     scripts/import-ambika-seattle-occupancy-production.mjs
 *
 * Apply:
 *   ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 \
 *     node --env-file=.env.production.local \
 *       scripts/import-ambika-seattle-occupancy-production.mjs --apply
 *
 * Slim lease payloads:
 *   ALLOW_PRODUCTION_AMBIKA_SEATTLE_OCCUPANCY=1 \
 *     node --env-file=.env.production.local \
 *       scripts/import-ambika-seattle-occupancy-production.mjs --slim-payloads --apply
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "import-ambika-seattle-occupancy-production.ts");
const result = spawnSync(
  "npx",
  ["tsx", "--conditions=react-server", script, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env, cwd: join(here, "..") },
);
process.exit(result.status ?? 1);
