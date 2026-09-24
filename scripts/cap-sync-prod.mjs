#!/usr/bin/env node
/** Point Capacitor at production and clear the local dev server marker. */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const marker = join(process.cwd(), ".cap-dev-server");
if (existsSync(marker)) unlinkSync(marker);

const result = spawnSync(
  "npx",
  ["cap", "sync"],
  {
    stdio: "inherit",
    env: { ...process.env, CAP_SERVER_URL: "https://proplane.ai" },
  },
);

process.exit(result.status ?? 1);
