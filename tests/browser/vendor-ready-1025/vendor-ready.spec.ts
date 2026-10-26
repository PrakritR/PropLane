/**
 * Vendor-ready (studio claude-2/vendor-ready-1025) browser proof.
 *
 * Bundles the REAL vendor and manager panels with the project's own Tailwind
 * build and drives them in Chromium through request interception — no dev
 * server, accounts, database or Stripe. Only the portal session, app-UI
 * provider, Next navigation / `next/link` / `next/image` and analytics are
 * stubbed; every `/api/**` call is answered by the in-memory server below,
 * which records writes so the spec can assert exactly what was sent.
 *
 * What it shows a reviewer, end-user side:
 *
 *  - a directly ASSIGNED job offers the vendor its own visit picker, and
 *    "Schedule visit" posts `/api/portal/work-orders/schedule-visit` with the
 *    picked time; the job then reads Scheduled (intent 6);
 *  - the vendor's Tasks section is back, titled Tasks, and a row's own
 *    "Mark completed" PATCHes `/api/vendor/tasks` and moves the row to
 *    Completed (intent 6);
 *  - completing a Scheduled job REQUIRES a photo: pressing Complete with none
 *    refuses, and a picked photo is downscaled to a JPEG data URL before
 *    `/api/portal/work-orders/mark-done` carries it (intent 5);
 *  - the manager's service record reads completion photos back out of the
 *    private bucket through the signed-URL route, and a legacy inline-base64
 *    row still renders (intent 5);
 *  - the manager's pay sheet warns, in one line, that the vendor has no bank
 *    connected yet and still lets the payment go ahead (intent 8);
 *  - the vendor's reply to their manager goes IN-APP on the same conversation —
 *    the thread keeps it and the vendor is told "Sent in PropLane", with no work
 *    identity or reply binding involved (intent 1).
 *
 *   npx playwright test --config tests/browser/vendor-ready-1025.config.ts
 *
 * Set EVIDENCE_DIR to also write reviewer screenshots and the recorded writes there.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MANAGER_ID,
  PHOTO_JPEG_DATA_URL,
  VENDOR_NAME,
  assignedJob,
  completedJobLegacyPhoto,
  completedJobPrivatePhoto,
  outgoingInvoice,
  scheduledJob,
  vendorInboxThread,
  vendorJobs,
  vendorTasks,
} from "./seed";
import { validateCompletionPhotos } from "../../../src/lib/completion-photos";

/**
 * `completionPhotoPrefix` from `completion-photo-storage.server.ts`, inlined: that module is
 * `"server-only"` and throws when imported outside a server component. The prefix itself is
 * covered against the real helper by `tests/unit/completion-photos-access.test.ts`.
 */
const completionPhotoPrefix = (managerUserId: string, workOrderId: string) =>
  `manager/${managerUserId}/service-completion/${workOrderId}/`;

const evidenceDir = process.env.EVIDENCE_DIR;
async function shot(page: Page, name: string, opts: Parameters<Page["screenshot"]>[0] = {}) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  await page.screenshot({ path: path.join(evidenceDir, `${name}.png`), ...opts });
}
async function note(name: string, body: unknown) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

let javascript: string;
let css: string;
test.beforeAll(async () => {
  const stubs = path.resolve("tests/browser/vendor-ready-1025/stubs.tsx");
  const analytics = path.resolve("tests/browser/payments-upcoming/analytics-stub.ts");
  const image = path.resolve("tests/browser/vendor-ready-1025/image-stub.tsx");
  const aliases = Object.fromEntries(
    [
      "components/providers/app-ui-provider",
      "hooks/use-manager-user-id",
      "hooks/use-portal-session",
      "hooks/use-native-platform",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/vendor-ready-1025/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: {
      ...aliases,
      "next/navigation": stubs,
      "next/link": stubs,
      "next/image": image,
      "posthog-js": analytics,
      "@/lib/analytics/track-client": analytics,
      crypto: analytics,
      "node:crypto": analytics,
    },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    logLevel: "silent",
  });
  javascript = bundle.outputFiles[0].text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
});

type Write = { url: string; method: string; body: unknown };
type Server = {
  jobs: ReturnType<typeof vendorJobs>;
  tasks: ReturnType<typeof vendorTasks>;
  threads: ReturnType<typeof vendorInboxThread>[];
  invoices: ReturnType<typeof outgoingInvoice>[];
  writes: Write[];
  /** Objects the fake private bucket holds, keyed by its storage path. */
  bucket: Map<string, string>;
  vendorPayoutsReady: boolean;
};

function fresh(overrides: Partial<Server> = {}): Server {
  return {
    jobs: vendorJobs(),
    tasks: vendorTasks(),
    threads: [vendorInboxThread()],
    invoices: [outgoingInvoice()],
    writes: [],
    bucket: new Map(),
    vendorPayoutsReady: true,
    ...overrides,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function wire(page: Page, server: Server) {
  /**
   * `crypto.randomUUID` exists only in a SECURE context, and this fixture is served over
   * plain http on a made-up host. The real app is https (or localhost, which counts), so
   * the panels rightly call it — without this the inbox reply throws before it ever sends.
   */
  await page.addInitScript(() => {
    if (typeof crypto.randomUUID === "function") return;
    (crypto as { randomUUID?: () => string }).randomUUID = () =>
      "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
        (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16),
      );
  });
  await page.route("http://vendor-ready.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") {
      return route.fulfill({ contentType: "application/javascript; charset=utf-8", body: javascript });
    }
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    // The fake private bucket's signed URL: the bytes the manager's record draws.
    if (url.pathname.startsWith("/signed/")) {
      const stored = server.bucket.get(decodeURIComponent(url.pathname.slice("/signed/".length)));
      if (!stored) return route.fulfill({ status: 404, body: "no such object" });
      const [, base64] = /^data:[^;]+;base64,(.+)$/.exec(stored) ?? [];
      return route.fulfill({ contentType: "image/jpeg", body: Buffer.from(base64 ?? "", "base64") });
    }
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        '<!doctype html><html data-theme="light"><head><meta charset="utf-8">' +
        '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div>' +
        '<script src="/fixture.js"></script></body></html>',
    });
  });

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body: unknown = null;
    if (method !== "GET") {
      try {
        body = JSON.parse(req.postData() ?? "null");
      } catch {
        body = req.postData();
      }
      server.writes.push({ url: url.pathname, method, body });
    }

    /* ----------------------------------------------------------- vendor jobs */
    if (url.pathname === "/api/portal-work-orders") {
      if (method === "GET") return json(route, { rows: server.jobs });
      return json(route, { ok: true });
    }

    // The vendor picks their own visit time on a directly assigned job.
    if (url.pathname === "/api/portal/work-orders/schedule-visit") {
      const { workOrderId, visitAt } = (body ?? {}) as { workOrderId?: string; visitAt?: string };
      const job = server.jobs.find((r) => r.id === workOrderId);
      if (!job || !visitAt) return json(route, { error: "No such job." }, 404);
      job.scheduledAtIso = visitAt;
      job.bucket = "scheduled";
      job.status = "Scheduled";
      return json(route, { ok: true, scheduledAtIso: visitAt });
    }

    /**
     * Completion: the REAL `validateCompletionPhotos` decides, and an accepted
     * photo is written to the fake private bucket under the same prefix the
     * server uses, so the row keeps a path and never the bytes.
     */
    if (url.pathname === "/api/portal/work-orders/mark-done") {
      const payload = (body ?? {}) as { workOrderId?: string; note?: string; completionPhotoDataUrls?: unknown };
      const checked = validateCompletionPhotos(payload.completionPhotoDataUrls);
      if (checked.ok !== true) return json(route, { error: checked.error }, checked.status);
      const job = server.jobs.find((r) => r.id === payload.workOrderId);
      if (!job) return json(route, { error: "No such job." }, 404);
      const paths = checked.photos.map((photo, i) => {
        const objectPath = `${completionPhotoPrefix(MANAGER_ID, job.id)}fixture-${i}.jpg`;
        server.bucket.set(objectPath, photo);
        return objectPath;
      });
      job.automationStatus = "vendor_marked_done";
      job.vendorMarkedDoneAt = new Date().toISOString();
      job.vendorMarkedDoneNote = payload.note ?? "";
      job.completedAt = job.vendorMarkedDoneAt;
      job.bucket = "completed";
      job.status = "Completed";
      job.completionPhotoPaths = paths;
      return json(route, { ok: true, completionPhotoPaths: paths });
    }

    // Signed URLs for a service's completion photos, with the route's own TTL.
    if (url.pathname === "/api/portal/work-orders/completion-photos") {
      const id = url.searchParams.get("workOrderId") ?? "";
      const job = [...server.jobs, completedJobPrivatePhoto(), completedJobLegacyPhoto()].find((r) => r.id === id);
      const paths = job?.completionPhotoPaths ?? [];
      for (const p of paths) if (!server.bucket.has(p)) server.bucket.set(p, PHOTO_JPEG_DATA_URL);
      return json(route, {
        urls: paths.map((p) => `http://vendor-ready.test/signed/${encodeURIComponent(p)}`),
        expiresInSeconds: 900,
      });
    }

    /* ---------------------------------------------------------- vendor tasks */
    if (url.pathname === "/api/vendor/tasks") {
      if (method === "GET") return json(route, { tasks: server.tasks });
      const { taskId, completed } = (body ?? {}) as { taskId?: string; completed?: boolean };
      const task = server.tasks.find((t) => t.id === taskId);
      if (!task) return json(route, { error: "Task not found." }, 404);
      task.completed = completed === true;
      return json(route, { task });
    }

    /* -------------------------------------------------------- vendor inbox */
    if (url.pathname === "/api/portal-inbox-threads") return json(route, { rows: server.threads });
    /**
     * The in-app reply. The real route answers `inApp: true` when the other party is a
     * PropLane account on the same conversation — nothing goes out by email or text.
     */
    if (url.pathname === "/api/vendor/send-inbox-message") {
      const { threadId, text } = (body ?? {}) as { threadId?: string; text?: string };
      const thread = server.threads.find((t) => t.id === threadId);
      if (!thread) return json(route, { error: "No such conversation." }, 404);
      thread.messages.push({
        id: `msg-${thread.messages.length + 1}`,
        from: "Harbor Plumbing",
        body: String(text ?? ""),
        at: new Date().toISOString(),
        outbound: true,
        channel: "proplane" as const,
      });
      return json(route, { ok: true, inApp: true, delivery: "sent" });
    }

    /* ------------------------------------------------- manager outgoing bills */
    if (url.pathname === "/api/manager/vendor-invoices") {
      return json(route, {
        invoices: server.invoices,
        payouts: [],
        totals: { owedCents: 14_500, paidThisYearCents: 0, billCount: 1, vendorCount: 1 },
      });
    }
    // The pay sheet's readiness answer: `vendorPayoutsReady: false` = no bank yet.
    if (/^\/api\/vendor\/invoices\/[^/]+\/outgoing$/.test(url.pathname)) {
      if (method === "GET") return json(route, { destination: null, vendorPayoutsReady: server.vendorPayoutsReady });
      return json(route, { ok: true });
    }
    if (/^\/api\/vendor\/invoices\/[^/]+\/pay$/.test(url.pathname)) {
      return json(route, { error: "Stripe is not available in this fixture." }, 503);
    }
    if (url.pathname === "/api/portal/proplane-balance") return json(route, { enabled: false });

    if (url.pathname === "/api/workspaces") {
      return json(route, {
        workspaces: [
          {
            id: "ws-fixture",
            name: "Magnolia workspace",
            ownerUserId: MANAGER_ID,
            owned: true,
            isDefault: true,
            propertyIds: ["prop-magnolia"],
            propertyNames: { "prop-magnolia": "The Magnolia" },
            propertyPermissions: {},
            livePropertyCount: 1,
          },
        ],
        activeWorkspaceId: "ws-fixture",
        plan: null,
      });
    }

    return json(route, {
      ok: true,
      rows: [],
      records: [],
      bids: [],
      offers: [],
      payouts: [],
      tasks: [],
      messages: [],
      items: [],
      invoices: [],
      properties: [],
      settings: null,
      vendors: [],
      contacts: [],
      threads: [],
    });
  });
}

/** Page errors, minus Stripe.js's publishable-key complaint (there is no Stripe here by design). */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => {
    if (/publishable key/i.test(e.message)) return;
    errors.push(e.message);
  });
  return errors;
}

/**
 * The fixture is always served at the route's OWN path, never at `/`:
 * `isDemoModeActive()` treats `/` as the public demo sandbox, which would send
 * every panel down its demo branch instead of the real one.
 */
const at = (surface: string, route: string) =>
  `http://vendor-ready.test${route}?surface=${surface}&route=${encodeURIComponent(route)}`;

const toasts = (page: Page) => page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);

/* ------------------------------------------------------------------------- */

test("a directly assigned job gives the vendor its own visit picker, and Schedule visit books it", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 900 });

  // The vendor's Services list: the assigned job reads "Assigned · pick a time".
  await page.goto(at("vendor-jobs", "/vendor/work-orders/assigned"));
  const row = page.getByText("Kitchen sink keeps clogging").first();
  await expect(row).toBeVisible();
  await expect(page.getByText("Assigned · pick a time").first()).toBeVisible();
  await shot(page, "01-vendor-services-assigned-tab", { fullPage: true });

  // Open the job record's Schedule section: the picker is the vendor's, not the manager's.
  await page.goto(at("vendor-jobs", `/vendor/work-orders/${assignedJob().id}/schedule`));
  const picker = page.locator('[data-attr="vendor-job-schedule-picker"]');
  await expect(picker).toBeVisible();
  await shot(page, "02-vendor-job-schedule-picker-empty", { fullPage: true });

  // Nothing is booked just by opening it.
  expect(server.writes.filter((w) => w.url === "/api/portal/work-orders/schedule-visit")).toHaveLength(0);

  await page.locator('[data-attr="vendor-schedule-visit-input"]').fill("2026-10-28T10:00");
  await shot(page, "03-vendor-job-schedule-picker-filled", { fullPage: true });
  await page.locator('[data-attr="vendor-schedule-visit"]').click();

  await expect
    .poll(() => server.writes.filter((w) => w.url === "/api/portal/work-orders/schedule-visit").length)
    .toBe(1);
  const booked = server.writes.find((w) => w.url === "/api/portal/work-orders/schedule-visit")!;
  expect(booked.body).toMatchObject({ workOrderId: "wo-assigned" });
  // `datetime-local` is wall time, sent as UTC: the hour depends on the runner's zone,
  // so pin the day and the minute rather than a zone-specific hour.
  expect(String((booked.body as { visitAt: string }).visitAt)).toMatch(/^2026-10-2[89]T\d{2}:00:00/);
  await expect.poll(() => toasts(page)).toContain("Visit scheduled. Your manager has been notified.");
  await shot(page, "04-vendor-job-scheduled", { fullPage: true });

  // The job has moved off Assigned and onto Scheduled, with the vendor's time.
  await page.goto(at("vendor-jobs", "/vendor/work-orders/scheduled"));
  await expect(page.getByText("Kitchen sink keeps clogging").first()).toBeVisible();
  await shot(page, "05-vendor-services-scheduled-tab", { fullPage: true });
  await note("schedule-visit-writes.json", server.writes);
  expect(errors).toEqual([]);
});

test("vendor Tasks is its own section, and a row's own action marks the task completed", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.goto(at("vendor-tasks", "/vendor/tasks/in-progress"));

  // The page is Tasks — not "Services", which is what this list used to claim.
  await expect(page.getByRole("heading", { name: "Tasks" }).first()).toBeVisible();
  await expect(page.getByText("Replace furnace filters — all four units")).toBeVisible();
  await expect(page.getByText("Clear the back gutters before the storm")).toBeVisible();
  await shot(page, "06-vendor-tasks-open", { fullPage: true });

  // The row's own action. `RecordActionMenu` collapses a one-item ⋯ into the action itself,
  // so the trailing control on a task row IS "Mark completed".
  const markCompleted = page.getByRole("button", {
    name: "Mark completed · Replace furnace filters — all four units",
  });
  await expect(markCompleted).toBeVisible();
  await shot(page, "07-vendor-task-row-action", { fullPage: true });
  await markCompleted.click();

  await expect.poll(() => server.writes.filter((w) => w.url === "/api/vendor/tasks").length).toBe(1);
  expect(server.writes.find((w) => w.url === "/api/vendor/tasks")!.body).toMatchObject({
    taskId: "task-filters",
    completed: true,
  });
  await expect.poll(() => toasts(page)).toContain("Marked completed.");
  // It left In progress...
  await expect(page.getByText("Replace furnace filters — all four units")).toHaveCount(0);
  await shot(page, "08-vendor-tasks-open-after-complete", { fullPage: true });
  // ...and is listed under Completed.
  await page.goto(at("vendor-tasks", "/vendor/tasks/completed"));
  await expect(page.getByText("Replace furnace filters — all four units")).toBeVisible();
  await shot(page, "09-vendor-tasks-completed", { fullPage: true });
  await note("task-writes.json", server.writes);
  expect(errors).toEqual([]);
});

test("completing a scheduled job requires a photo, and the photo is sent downscaled and stored by path", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(at("vendor-jobs", `/vendor/work-orders/${scheduledJob().id}/schedule`));

  await expect(page.getByText(/Visit/).first()).toBeVisible();
  await shot(page, "10-vendor-job-complete-photo-required", { fullPage: true });

  // Complete with no photo: refused, and nothing is sent.
  await page.locator('[data-attr="vendor-mark-done"]').click();
  await expect.poll(() => toasts(page)).toContain("Add a completion photo before you complete this service.");
  expect(server.writes.filter((w) => w.url === "/api/portal/work-orders/mark-done")).toHaveLength(0);
  await shot(page, "11-vendor-job-complete-blocked-no-photo", { fullPage: true });

  // Pick a photo through the real picker. The file is a 2400x1600 PNG, so the
  // client's own downscale has to turn it into a <=1600px JPEG data URL.
  const bigPng = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2400;
    canvas.height = 1600;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#1d4ed8";
    ctx.fillRect(0, 0, 2400, 1600);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 180px sans-serif";
    ctx.fillText("DONE", 820, 880);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-attr="service-intake-photos"]').click();
  await (await chooser).setFiles({
    name: "valve-after.png",
    mimeType: "image/png",
    buffer: Buffer.from(bigPng),
  });
  await expect(page.getByText("Photos (1/6)")).toBeVisible();
  await shot(page, "12-vendor-job-complete-photo-attached", { fullPage: true });

  await page.locator('[data-attr="vendor-mark-done"]').click();
  await expect.poll(() => server.writes.filter((w) => w.url === "/api/portal/work-orders/mark-done").length).toBe(1);
  const sent = server.writes.find((w) => w.url === "/api/portal/work-orders/mark-done")!
    .body as { completionPhotoDataUrls: string[] };
  // Downscaled on the client: a JPEG (never the original PNG) under the server's 2 MB cap.
  expect(sent.completionPhotoDataUrls).toHaveLength(1);
  expect(sent.completionPhotoDataUrls[0]).toMatch(/^data:image\/jpeg;base64,/);
  const decodedBytes = Math.floor((sent.completionPhotoDataUrls[0]!.split(",")[1]!.length * 3) / 4);
  expect(decodedBytes).toBeLessThan(2 * 1024 * 1024);
  // Stored by PATH in the private bucket — the row never carries the bytes.
  const stored = server.jobs.find((r) => r.id === scheduledJob().id)!;
  expect(stored.completionPhotoPaths?.[0]).toMatch(
    new RegExp(`^${completionPhotoPrefix(MANAGER_ID, scheduledJob().id)}`),
  );
  expect(stored.completionPhotoDataUrls ?? []).toHaveLength(0);
  await note("mark-done-write.json", {
    url: "/api/portal/work-orders/mark-done",
    photoDataUrlPrefix: sent.completionPhotoDataUrls[0]!.slice(0, 48),
    photoDecodedBytes: decodedBytes,
    storedPath: stored.completionPhotoPaths?.[0],
    rowCarriesBytes: (stored.completionPhotoDataUrls ?? []).length > 0,
  });
  await shot(page, "13-vendor-job-completed", { fullPage: true });
  expect(errors).toEqual([]);
});

test("the manager's service record reads completion photos back through signed URLs, and a legacy inline row still renders", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 1000 });

  // Private-bucket job: the bytes arrive only through the signed-URL route.
  await page.goto(at("manager-service", "/portal/services/wo-done-private"));
  const signedImage = page.locator('img[src*="/signed/"]').first();
  await expect(signedImage).toBeVisible();
  await expect
    .poll(() => signedImage.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await shot(page, "14-manager-service-record-signed-completion-photo", { fullPage: true });

  // Legacy row: the photo is still inline base64 on the row and still renders.
  await page.goto(at("manager-service", "/portal/services/wo-done-legacy"));
  const legacyImage = page.locator('img[src^="data:image/jpeg;base64,"]').first();
  await expect(legacyImage).toBeVisible();
  await shot(page, "15-manager-service-record-legacy-inline-photo", { fullPage: true });
  expect(errors).toEqual([]);
});

test("the pay sheet warns in one line when the vendor has no bank yet, and still lets the manager pay", async ({ page }) => {
  const server = fresh({ vendorPayoutsReady: false });
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 950 });
  await page.goto(at("manager-outgoing", "/portal/outgoing/to-pay"));

  await expect(page.getByText(VENDOR_NAME).first()).toBeVisible();
  await shot(page, "16-manager-outgoing-to-pay", { fullPage: true });

  // Reach the pay sheet the way the manager does: open the payment record, then its header's blue Pay.
  await page.goto(at("manager-outgoing", "/portal/outgoing/payment/inv-harbor-1"));
  // `PortalAdaptiveActionRow` renders each action twice (inline + overflow menu) and hides
  // whichever copy does not fit, so only the visible one is the manager's actual button.
  await page.locator('[data-attr="record-header-action-pay-now"]:visible').first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Pay vendor" }).first();
  await expect(dialog).toBeVisible();
  await shot(page, "17-manager-pay-vendor-dialog", { fullPage: true });
  await dialog.getByRole("button", { name: /^Pay \$145\.00$/ }).click();

  const sheet = page.locator('[data-attr="vendor-invoice-pay-sheet"]');
  await expect(sheet).toBeVisible();
  const warning = page.locator('[data-attr="vendor-invoice-pay-bank-warning"]');
  await expect(warning).toHaveText(
    `${VENDOR_NAME} hasn't connected a bank yet. You're charged now; they're paid when they connect.`,
  );
  // One line, not a block that stops the payment: Continue to payment is still there.
  await expect(warning).toHaveCount(1);
  await expect(page.locator('[data-attr="vendor-invoice-pay-start"]')).toBeEnabled();
  await shot(page, "18-manager-pay-sheet-no-bank-warning", { fullPage: true });
  expect(errors).toEqual([]);
});

test("a vendor's reply to their manager goes in-app on the same conversation", async ({ page }) => {
  const server = fresh();
  const errors = collectErrors(page);
  await wire(page, server);
  await page.setViewportSize({ width: 1180, height: 900 });
  await page.goto(at("vendor-inbox", "/vendor/communication/active/thr-taylor"));

  // The manager's message is already in the vendor's own PropLane inbox.
  await expect(page.getByText("Can you take a look at the radiator this week?").first()).toBeVisible();
  await shot(page, "19-vendor-inbox-manager-thread", { fullPage: true });

  const reply = "Booked for Wednesday 10am — I'll bring the bleed key.";
  const composer = page.locator("form textarea").last();
  await composer.click();
  await composer.fill(reply);
  await shot(page, "20-vendor-inbox-reply-typed", { fullPage: true });
  // The thread composer's send is the paper-plane submit, labelled only for screen readers.
  await page.locator("button.portal-inbox-composer-send:visible").last().click();

  await expect
    .poll(() => server.writes.filter((w) => w.url === "/api/vendor/send-inbox-message").length)
    .toBe(1);
  const sent = server.writes.find((w) => w.url === "/api/vendor/send-inbox-message")!;
  // The composer still asks for its "email" channel — the SERVER decides the reply stays
  // in-app because the other party is a PropLane account, and says so with `inApp: true`.
  expect(sent.body).toMatchObject({ threadId: "thr-taylor", text: reply, channel: "email" });
  // The reply is on the conversation, and the vendor is told it stayed inside PropLane —
  // no work number, no reply-binding address.
  await expect(page.getByText(reply).first()).toBeVisible();
  await expect.poll(() => toasts(page)).toContain("Sent in PropLane.");
  await note("vendor-reply-write.json", { write: sent, thread: server.threads[0] });
  await shot(page, "21-vendor-inbox-reply-sent-in-proplane", { fullPage: true });
  expect(errors).toEqual([]);
});
