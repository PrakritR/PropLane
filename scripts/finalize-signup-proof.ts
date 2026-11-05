/** CI always-run finalizer. No broad purge or production path is exposed. */
import { readdirSync } from "node:fs";
import { proveSignupShutdown, verifySignupPortClosed } from "../tests/helpers/signup-proof-shutdown";
import { finalizeSignupProof } from "../tests/helpers/signup-proof-cleanup";

async function main() {
try {
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR ?? "";
  const journals = readdirSync(dir).filter((name) => /^p8-[a-f0-9]{32}\.manifest\.json$/.test(name));
  if (journals.length) {
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? "";
    proveSignupShutdown(dir, origin, process.env.SIGNUP_PROOF_RUN_NONCE ?? "");
    await verifySignupPortClosed(origin);
    await finalizeSignupProof(dir);
  }
  console.log(`Signup fixture reconciliation completed; reservations=${journals.length}.`);
} catch {
  console.error("Signup fixture reconciliation refused. Preserve the encrypted private recovery artifact.");
  process.exitCode = 1;
}

}
void main();
