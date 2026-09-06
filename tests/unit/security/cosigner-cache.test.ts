// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

beforeEach(() => { vi.resetModules(); window.sessionStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());

it("purges the old sensitive form cache and never persists new form contents", async () => {
  const key = "axis:cosigner-submissions:v1";
  window.sessionStorage.setItem(key, JSON.stringify([{ ssn: "123-45-6789" }]));
  const { appendCosignerSubmission, readCosignerSubmissionsForSignerAppId } = await import("@/lib/cosigner-submissions-storage");
  const sub = { signerAppId: "AXIS-TEST1234", ssn: "123-45-6789", dob: "1990-01-01" } as CosignerSubmission;
  appendCosignerSubmission(sub);
  expect(window.sessionStorage.getItem(key)).toBeNull();
  const cached = readCosignerSubmissionsForSignerAppId(sub.signerAppId);
  expect(cached[0].ssn).toBe("***-**-6789");
  expect(sub.ssn).toBe("123-45-6789");
});

it.each([401, 403, 500])("does not serve a cached record over an HTTP %s denial", async (status) => {
  const { appendCosignerSubmission, fetchCosignerSubmissionsForSignerAppId } = await import("@/lib/cosigner-submissions-storage");
  appendCosignerSubmission({ signerAppId: "AXIS-TEST1234", ssn: "123-45-6789" } as CosignerSubmission);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
  expect(await fetchCosignerSubmissionsForSignerAppId("AXIS-TEST1234")).toEqual([]);
});
