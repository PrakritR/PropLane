import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * `transitionApplicationBucket` must observe the server's refusal.
 *
 * The manager panel flips the bucket optimistically and only then syncs, so a
 * server that (correctly) refuses to approve a withdrawn application used to leave
 * the local cache showing "approved" — with approval charges recorded and a
 * success toast — while the server had discarded everything. The stale-cache case
 * is exactly the one the local backstop cannot catch: the cached row has no
 * `withdrawnAt` yet.
 */

let ROWS: DemoApplicantRow[] = [];
const fetchMock = vi.fn();

const recordApprovedApplicationCharges = vi.fn();
const recordSubmittedApplicationFeeCharge = vi.fn();
const removeAllApplicationCharges = vi.fn();
const removeApprovedApplicationCharges = vi.fn();

vi.mock("@/lib/manager-applications-storage", async (importOriginal) => ({
  // Spread the real module: only the two storage accessors need overriding, and a
  // hand-listed mock silently breaks the moment the module gains an export this
  // path calls (`normalizeApplicationAxisId` is one).
  ...(await importOriginal<typeof import("@/lib/manager-applications-storage")>()),
  readManagerApplicationRows: () => ROWS,
  writeManagerApplicationRows: (rows: DemoApplicantRow[]) => {
    ROWS = rows;
  },
}));
vi.mock("@/lib/household-charges", () => ({
  recordApprovedApplicationCharges,
  recordSubmittedApplicationFeeCharge,
  removeAllApplicationCharges,
  removeApprovedApplicationCharges,
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => DEMO_MODE,
}));

let DEMO_MODE = false;

function row(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-9001",
    name: "Stale Cache Applicant",
    property: "The Pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    email: "applicant@example.com",
    ...over,
  };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("transitionApplicationBucket — a refused approval is rolled back, not reported as success", () => {
  beforeEach(() => {
    ROWS = [row()];
    DEMO_MODE = false;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    recordApprovedApplicationCharges.mockClear();
    removeApprovedApplicationCharges.mockClear();
  });

  it("rolls back and stamps when the server matched THIS application by id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: "This application was withdrawn by the applicant and can no longer be approved.",
        blocked: "withdrawn",
        blockedApplicationId: "axis-9001",
        matchedBy: "id",
      }),
    );
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("withdrawn");
    expect(result?.message).toMatch(/withdrawn/i);
    expect(ROWS[0].bucket).toBe("pending");
    expect(ROWS[0].stage).toBe("Submitted");
    // Stamped locally too, so the row reads "Withdrawn" and stops offering Approve
    // instead of inviting the same refused round trip until the sync TTL expires.
    expect(ROWS[0].withdrawnAt).toBeTruthy();
    expect(removeApprovedApplicationCharges).not.toHaveBeenCalled();
    expect(recordApprovedApplicationCharges).not.toHaveBeenCalled();
    // No welcome email may go out for an approval the server refused.
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/manager-applications"]);
  });

  it("rolls back WITHOUT stamping when the 409 came from another application (email fallback)", async () => {
    // Applicant withdrew unit A and then applied for unit B with the same manager.
    // B's mirror has not landed, so the guard's id lookup misses and its email
    // fallback matches A — stamping B here would permanently mislabel a record
    // nobody withdrew, and the mirror would make that durable.
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: "This application was withdrawn by the applicant and can no longer be approved.",
        blocked: "withdrawn",
        blockedApplicationId: "AXIS-8000",
        matchedBy: "email",
      }),
    );
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("error");
    // The message must point at the cause and the resolution, not invite a retry.
    expect(result?.message).toMatch(/withdrawn application on file/i);
    expect(result?.message).toMatch(/refresh/i);
    expect(ROWS[0].bucket).toBe("pending");
    expect(ROWS[0].withdrawnAt).toBeFalsy();
    expect(removeApprovedApplicationCharges).not.toHaveBeenCalled();
    expect(recordApprovedApplicationCharges).not.toHaveBeenCalled();
    // Only the refusal itself goes out — no extra reads that could race the rollback.
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/manager-applications"]);
  });

  it("rolls back WITHOUT stamping when the 409 names a different id even via the id lookup", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: "withdrawn", blockedApplicationId: "AXIS-8000", matchedBy: "id" }),
    );
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("error");
    expect(ROWS[0].bucket).toBe("pending");
    expect(ROWS[0].withdrawnAt).toBeFalsy();
  });

  it("rolls back when the request never reaches the server (offline / aborted)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("error");
    expect(result?.message).toMatch(/retry when connected/i);
    expect(ROWS[0].bucket).toBe("pending");
    // A network error is not a withdrawal signal.
    expect(ROWS[0].withdrawnAt).toBeFalsy();
    expect(removeApprovedApplicationCharges).not.toHaveBeenCalled();
    expect(recordApprovedApplicationCharges).not.toHaveBeenCalled();
    // The welcome email must not claim an approval that never landed.
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/manager-applications"]);
  });

  it("rolls back on any other non-2xx refusal (e.g. 403) rather than reporting success", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Forbidden." }));
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("error");
    expect(ROWS[0].bucket).toBe("pending");
    // A non-withdrawn refusal must not fabricate a withdrawal stamp.
    expect(ROWS[0].withdrawnAt).toBeFalsy();
    expect(removeApprovedApplicationCharges).not.toHaveBeenCalled();
    expect(recordApprovedApplicationCharges).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(["/api/manager-applications"]);
  });

  it("leaves the /demo walkthrough alone — no server sync, no rollback", async () => {
    DEMO_MODE = true;
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", {
      userId: "demo-everything",
      skipWelcomeEmail: true,
    });

    expect(result?.blocked).toBeUndefined();
    expect(ROWS[0].bucket).toBe("approved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rolls back when the guard could not verify the record (fail-closed 500)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: "Could not verify the application status." }));
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("error");
    expect(ROWS[0].bucket).toBe("pending");
  });

  it("refuses locally, without touching the server, when the cached row is already stamped", async () => {
    ROWS = [row({ withdrawnAt: "2026-07-22T00:00:00.000Z" })];
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBe("withdrawn");
    expect(ROWS[0].bucket).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordApprovedApplicationCharges).not.toHaveBeenCalled();
  });

  it("completes a normal approval and reports no block", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("send-resident-welcome") ? jsonResponse(200, { ok: true }) : jsonResponse(200, { ok: true }),
      ),
    );
    const { transitionApplicationBucket } = await import("@/lib/application-review");
    const result = await transitionApplicationBucket("AXIS-9001", "approved", { userId: "mgr-1" });

    expect(result?.blocked).toBeUndefined();
    expect(result?.welcomeSent).toBe(true);
    expect(ROWS[0].bucket).toBe("approved");
    expect(recordApprovedApplicationCharges).toHaveBeenCalledTimes(1);
  });
});
