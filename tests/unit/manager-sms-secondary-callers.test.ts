import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");
const SECONDARY_MANUAL_SMS_CALLERS = [
  "pro-inbox.tsx",
  "pro-resident-detail-inbox.tsx",
  "pro-communication-compose-modal.tsx",
] as const;

describe("secondary manager SMS send callers", () => {
  for (const file of SECONDARY_MANUAL_SMS_CALLERS) {
    it(`${file} pins retries and handles unknown outcomes`, () => {
      const source = readFileSync(join(PORTAL_DIR, file), "utf8");

      expect(source).toContain('fetch("/api/manager/sms-conversations"');
      expect(source).toContain('"Idempotency-Key"');
      expect(source).toContain("resolveManualSmsAttempt(");
      expect(source).toContain("isManualSmsOutcomeUnknown(");
      expect(source).toContain("MANUAL_SMS_UNKNOWN_MESSAGE");
    });
  }
});
