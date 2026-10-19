// A manager text with a reply completes its claim inside finishPreparedDelivery. Completing it a second time found no
// "processing" row and answered 503 after the reply was already sent, so Twilio retried every manager text (found by the
// end-to-end harness). A source guard, because the pipeline is one large private function.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/sms/inbound-pipeline.server.ts", "utf8");

describe("manager agent turn completes its claim once", () => {
  it("tracks that the delivery already completed the claim and skips the second completion", () => {
    expect(source).toMatch(/let managerClaimFinished = false;/);
    expect(source).toMatch(/managerClaimFinished = true;/);
    expect(source).toMatch(/if \(!managerClaimFinished && !\(await finishInboundClaim\(db, messageSid, inboundWorkerId, "completed"\)\)\)/);
  });
});
