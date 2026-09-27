/**
 * The last of the four lease-signing hotfix defects (Part 3 of the Sep 2026
 * loop-test plan): a signature could be recorded against the wrong document
 * because the CLIENT hashed whatever copy it happened to be holding — often
 * the slim list projection, which carries no bytes at all — rather than the
 * document actually stored on the server.
 *
 * `newSignatureHashMismatch` is the server-side check that closes that gap.
 * It is deliberately pure and hash-function-agnostic: the caller supplies
 * `hashBytes` so this module needs neither `node:crypto` (the API route) nor
 * WebCrypto (a future client-side reuse), and it can be shared without
 * importing the browser-oriented storage module.
 */

import { leaseSignedDocumentBytes } from "@/lib/lease-execution-evidence";
import type { LeasePipelineRow, LeaseSignature } from "@/lib/lease-pipeline-storage";

/**
 * True when `next` introduces a NEW signature (one `stored` did not already
 * carry, for either role) whose reported `documentSha256` disagrees with the
 * SHA-256 of the bytes `stored` actually holds — the document the signer was
 * shown when they opened the lease.
 *
 * Deliberately narrow, so it never duplicates or loosens an existing guard:
 *
 * - Only a genuinely NEW signature is checked. A resend of an existing one,
 *   or a second signature over the first, is `leaseSignatureWriteRefusal`'s
 *   job, and that check runs first.
 * - An ABSENT reported hash is not a mismatch. `leaseDocumentSha256` already
 *   records `null` honestly when WebCrypto was unavailable to the signer's
 *   browser (a plain-http dev host); refusing that here would turn an
 *   honest gap into a hard block instead of an honest gap.
 * - Nothing to compare against (`stored` carries no document bytes at all)
 *   is not a mismatch either — that shape is refused elsewhere (a lease
 *   cannot be sent, let alone signed, with no document).
 */
export function newSignatureHashMismatch(
  stored: LeasePipelineRow | null | undefined,
  next: Pick<LeasePipelineRow, "residentSignature" | "managerSignature">,
  hashBytes: (bytes: Uint8Array) => string,
): boolean {
  if (!stored) return false;
  for (const role of ["resident", "manager"] as const) {
    const beforeSig: LeaseSignature | null | undefined = role === "resident" ? stored.residentSignature : stored.managerSignature;
    const afterSig: LeaseSignature | null | undefined = role === "resident" ? next.residentSignature : next.managerSignature;
    if (!afterSig) continue;
    if (beforeSig) continue; // resend or re-sign — not this guard's question
    const submitted = afterSig.documentSha256?.trim().toLowerCase();
    if (!submitted) continue;
    const storedBytes = leaseSignedDocumentBytes(stored);
    if (!storedBytes) continue;
    const expected = hashBytes(storedBytes).toLowerCase();
    if (expected !== submitted) return true;
  }
  return false;
}
