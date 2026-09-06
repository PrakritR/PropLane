/** Compatibility entry point. The old JSON-to-lease-table writer is deliberately removed. */
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/import-sales-workbook.ts", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
