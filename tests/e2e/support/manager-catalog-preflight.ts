import { optionalPurgeTableAbsentOnDev } from "../../helpers/synthetic-workspace-preflight";
async function main() {
  for (const table of ["payment_reminder_occurrences", "phone_required_skips", "scheduled_inbox_channel_deliveries"]) await optionalPurgeTableAbsentOnDev(table);
}
void main().catch(() => { process.exitCode = 1; });
