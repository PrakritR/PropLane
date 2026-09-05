import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerTask } from "@/lib/manager-tasks";
// The email no longer POSTs Resend directly — it goes through
// deliverPortalInboxMessage, the same path every other portal notification
// uses, so a fetch stub captures nothing and every case read as "not sent".
// Capture at that boundary instead; this file is about the LINK the assignee
// is handed, not the transport underneath it.
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal-inbox-delivery")>();
  return {
    ...actual,
    deliverPortalInboxMessage: vi.fn(
      async (_db: unknown, args: { toEmails?: string[]; subject: string; text: string }) => {
        delivered.push({
          from: "",
          to: args.toEmails ?? [],
          subject: args.subject,
          text: args.text,
        });
        return { ok: true as const, skipped: false };
      },
    ),
  };
});

import { sendTaskAssigneeEmail } from "@/lib/manager-default-tasks.server";

/**
 * `sendTaskAssigneeEmail` builds the only link an assignee gets — it had no
 * coverage, and the module has now twice shipped with a helper it calls but no
 * longer imports (`formatPacificDateTime`, then `resolveEmailLinkBaseUrl`).
 * A missing import there is invisible to every other task test while the
 * created-task and due-reminder emails throw before Resend is ever called.
 */

type SentEmail = { from: string; to: string[]; subject: string; text: string };

const ENV_KEYS = [
  "RESEND_API_KEY",
  "RESEND_FROM",
  "NEXT_PUBLIC_CANONICAL_APP_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

const previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

let sent: SentEmail[] = [];
const delivered: SentEmail[] = [];

const task = (overrides: Partial<ManagerTask> = {}): ManagerTask => ({
  id: "task-1",
  title: "Collect August rent · Unit 2B",
  notes: "Follow up with the resident before posting a late fee.",
  propertyTitle: "1420 Pine St",
  completed: false,
  dueDate: "2026-08-28T17:00:00.000Z",
  assignee: { type: "team", id: "mgr-user-1", name: "Alex" },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  ...overrides,
});

function dbWithAssigneeEmail(email: string) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({ data: { email }, error: null }),
        })),
      })),
    })),
  } as never;
}

beforeEach(() => {
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.RESEND_FROM = "PropLane <tasks@prop-lane.space>";
  delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
  sent = [];
  delivered.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentEmail);
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe("sendTaskAssigneeEmail", () => {
  it("sends a due reminder that links to the Overdue tab on an absolute origin", async () => {
    const result = await sendTaskAssigneeEmail({
      db: dbWithAssigneeEmail("Alex@Example.com "),
      managerUserId: "mgr-user-1",
      task: task(),
      assignee: { type: "team", id: "mgr-user-1", name: "Alex" },
      kind: "due",
    });

    expect(result.sent).toBe(true);
    expect(delivered).toHaveLength(1);
    const email = delivered[0]!;
    expect(email.to).toEqual(["alex@example.com"]);
    expect(email.subject).toBe("Task due: Collect August rent · Unit 2B");
    // The regression: the link is built from resolveEmailLinkBaseUrl(), so it
    // must be a clickable absolute URL, never a bare "/portal/..." path.
    expect(email.text).toContain(
      "Open your task list: https://prop-lane.space/portal/tasks/overdue",
    );
    expect(email.text).toContain("Property: 1420 Pine St");
  });

  it("links a not-yet-late assignment to the In progress tab", async () => {
    await sendTaskAssigneeEmail({
      db: dbWithAssigneeEmail("vendor@example.com"),
      managerUserId: "mgr-user-1",
      task: task({ dueDate: undefined, id: "task-2", title: "Walk the vacant unit" }),
      assignee: { type: "team", id: "mgr-user-1", name: "Alex" },
      kind: "created",
    });

    const email = delivered[0]!;
    expect(email.subject).toBe("New task assigned: Walk the vacant unit");
    expect(email.text).toContain(
      "Open your task list: https://prop-lane.space/portal/tasks",
    );
  });

  it("honours a configured canonical origin", async () => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://www.prop-lane.space";
    await sendTaskAssigneeEmail({
      db: dbWithAssigneeEmail("alex@example.com"),
      managerUserId: "mgr-user-1",
      task: task(),
      assignee: { type: "team", id: "mgr-user-1", name: "Alex" },
      kind: "due",
    });
    expect(delivered[0]!.text).toContain(
      "https://www.prop-lane.space/portal/tasks/overdue",
    );
  });

  it("does not call the mailer when the assignee has no email", async () => {
    const result = await sendTaskAssigneeEmail({
      db: dbWithAssigneeEmail(""),
      managerUserId: "mgr-user-1",
      task: task(),
      assignee: { type: "team", id: "mgr-user-1", name: "Alex" },
      kind: "due",
    });
    expect(result).toEqual({ sent: false, error: "assignee_email_missing" });
    expect(sent).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The emailed path must be a real route
 * ------------------------------------------------------------------ */

const APP_DIR = resolve(__dirname, "../../src/app");
const OPTIONAL_CATCH_ALL = /^\[\[\.{3}.+\]\]$/;
const CATCH_ALL = /^\[\.{3}.+\]$/;
const DYNAMIC = /^\[(?!\[|\.{3}).+\]$/;
const ROUTE_GROUP = /^\(.+\)$/;

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  } catch {
    return [];
  }
}

function hasPage(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /^(page|route)\.(t|j)sx?$/.test(f));
  } catch {
    return false;
  }
}

function routeResolves(pathname: string, dir = APP_DIR): boolean {
  const path = pathname.split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean);
  const children = childDirs(dir);
  if (segments.length === 0) {
    if (hasPage(dir)) return true;
    if (children.some((c) => OPTIONAL_CATCH_ALL.test(c) && hasPage(join(dir, c)))) return true;
    return children.some((c) => ROUTE_GROUP.test(c) && routeResolves("/", join(dir, c)));
  }
  const [head, ...rest] = segments;
  const restPath = `/${rest.join("/")}`;
  const ordered = [
    ...children.filter((c) => c === head),
    ...children.filter((c) => DYNAMIC.test(c)),
    ...children.filter((c) => CATCH_ALL.test(c) || OPTIONAL_CATCH_ALL.test(c)),
  ];
  for (const candidate of ordered) {
    const next = join(dir, candidate);
    if ((CATCH_ALL.test(candidate) || OPTIONAL_CATCH_ALL.test(candidate)) && hasPage(next)) return true;
    if (routeResolves(restPath, next)) return true;
  }
  return children.some((c) => ROUTE_GROUP.test(c) && routeResolves(path, join(dir, c)));
}

describe("the task-list link an assignee is emailed resolves", () => {
  it("resolves its own fixtures, so a false pass is not possible", () => {
    expect(routeResolves("/portal/properties")).toBe(true);
    expect(routeResolves("/auth/login")).toBe(false);
  });

  it.each(["/portal/tasks/overdue", "/portal/tasks"])("%s", (path) => {
    expect(routeResolves(path)).toBe(true);
  });
});
