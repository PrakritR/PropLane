import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import { E2E_ACCOUNTS } from "../fixtures";
import { establishActivePortal, signIn, signInAsManager } from "../helpers/auth";

const enabled = process.env.E2E_TESTS_ENABLED === "1";
const DEV_TEST_SUPABASE_HOST = "emstjswhotsnyksqhqyf.supabase.co";
const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
const RUN_PREFIX = `conversation-identity-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type SeededActor = { id: string; email: string; name: string };
type SeededProperty = { id: string; title: string };
type InsertedRow = { id: string; ownerId: string };
type Fixture = {
  db: SupabaseClient;
  manager: SeededActor;
  managerWorkspaceId: string;
  resident: SeededActor & { password: string };
  relationshipProperty: SeededProperty;
  inserted: InsertedRow[];
  applicationId: string;
  applicationCreated: boolean;
  roleCreated: boolean;
  profileCreated: boolean;
  authUserCreated: boolean;
  ids: {
    residentEmail: string;
    residentTour: string;
    managerProspect: string;
    managerApplication: string;
    managerEmail: string;
    managerConflict: string;
  };
};

type InboxApiRow = {
  id: string;
  from?: string;
  email?: string;
  unread?: boolean;
  sourceThreadIds?: string[];
  readSources?: { id: string; observation: string; unread?: boolean }[];
  readSourcesComplete?: boolean;
  threadType?: string | null;
};

const residentEmailMarker = `${RUN_PREFIX}: ordinary manager email`;
const residentTourMarker = `${RUN_PREFIX}: historical tour notice`;
const managerProspectMarker = `${RUN_PREFIX}: prospect source`;
const managerApplicationMarker = `${RUN_PREFIX}: application source`;
const managerEmailMarker = `${RUN_PREFIX}: direct email source`;
const managerConflictMarker = `${RUN_PREFIX}: conflicting role source`;
const residentDraft = `${RUN_PREFIX}: resident draft for verified manager`;
const managerDraft = `${RUN_PREFIX}: manager draft for verified resident`;

let fixture: Fixture | null = null;

function requireDevTestDatabase(): { url: string; serviceKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !serviceKey) {
    throw new Error(
      "E2E_TESTS_ENABLED=1 requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the seeded dev/test project.",
    );
  }
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("E2E_TESTS_ENABLED=1 has an invalid NEXT_PUBLIC_SUPABASE_URL.");
  }
  if (hostname !== DEV_TEST_SUPABASE_HOST) {
    throw new Error(`Conversation identity fixtures only write to ${DEV_TEST_SUPABASE_HOST}; received ${hostname}.`);
  }
  return { url, serviceKey };
}

function inboxStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(date);
  const value = (type: "month" | "day" | "hour" | "minute" | "dayPeriod") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("month")} ${value("day")}, ${value("hour")}:${value("minute")} ${value("dayPeriod")}`;
}

function relationship(managerId: string, property: SeededProperty, counterpartyRole: "manager" | "resident" | "vendor") {
  return {
    managerUserId: managerId,
    propertyId: property.id,
    propertyTitle: property.title,
    counterpartyRole,
  };
}

async function resolveSeededManager(db: SupabaseClient): Promise<{
  manager: SeededActor;
  managerWorkspaceId: string;
  relationshipProperty: SeededProperty;
}> {
  const managerEmail = E2E_ACCOUNTS.manager.email.toLowerCase();
  const { data: authData, error: authError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authError) throw new Error(`Could not resolve seeded auth accounts: ${authError.message}`);
  const authByEmail = new Map(
    (authData.users ?? []).flatMap((user) => {
      const email = user.email?.trim().toLowerCase();
      return email ? [[email, user.id] as const] : [];
    }),
  );
  const managerId = authByEmail.get(managerEmail);
  if (!managerId) throw new Error("Enabled conversation identity E2E requires the existing seeded manager auth account.");

  const [{ data: profiles, error: profileError }, { data: roles, error: roleError }] = await Promise.all([
    db.from("profiles").select("id,email,full_name").eq("id", managerId),
    db.from("profile_roles").select("user_id,role").eq("user_id", managerId),
  ]);
  if (profileError) throw new Error(`Could not verify seeded profiles: ${profileError.message}`);
  if (roleError) throw new Error(`Could not verify seeded roles: ${roleError.message}`);
  const profileById = new Map((profiles ?? []).map((profile) => [String(profile.id), profile]));
  const roleKeys = new Set((roles ?? []).map((row) => `${row.user_id}:${row.role}`));
  const managerProfile = profileById.get(managerId);
  if (
    String(managerProfile?.email ?? "").toLowerCase() !== managerEmail ||
    !roleKeys.has(`${managerId}:manager`)
  ) {
    throw new Error("Seeded E2E manager does not have the expected profile and manager role.");
  }

  const { data: defaultWorkspace, error: workspaceError } = await db
    .from("portal_workspaces")
    .select("id")
    .eq("owner_user_id", managerId)
    .eq("is_default", true)
    .maybeSingle();
  if (workspaceError) throw new Error(`Could not verify the seeded manager workspace: ${workspaceError.message}`);
  const managerWorkspaceId = String(defaultWorkspace?.id ?? "").trim();
  if (!managerWorkspaceId) {
    throw new Error("Seeded E2E manager must already have a default workspace; fixture setup will not create one.");
  }

  const assistantId = `agent_notice_${managerId}`;
  const { data: assistant, error: assistantError } = await db
    .from("portal_inbox_thread_records")
    .select("id")
    .eq("id", assistantId)
    .eq("owner_user_id", managerId)
    .eq("scope", MANAGER_SCOPE)
    .eq("thread_type", "agent_notice")
    .maybeSingle();
  if (assistantError) throw new Error(`Could not verify the seeded manager Assistant: ${assistantError.message}`);
  if (assistant?.id !== assistantId) {
    throw new Error("Seeded E2E manager must already have its default-workspace Assistant; fixture setup will not create one.");
  }

  const { data: properties, error: propertyError } = await db
    .from("manager_property_records")
    .select("id,row_data,workspace_id")
    .eq("manager_user_id", managerId)
    .eq("workspace_id", managerWorkspaceId)
    .order("id", { ascending: true });
  if (propertyError) throw new Error(`Could not verify seeded manager properties: ${propertyError.message}`);
  const owned = (properties ?? []).map((row) => {
    const data = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const title = String(data.title ?? data.name ?? data.property ?? data.address ?? id).trim() || id;
    return { id, title };
  }).filter((property) => property.id);
  const relationshipProperty = owned[0];
  if (!relationshipProperty) {
    throw new Error("Seeded E2E data must include an existing property in the seeded manager's default workspace.");
  }

  return {
    manager: {
      id: managerId,
      email: managerEmail,
      name: String(managerProfile?.full_name ?? "").trim() || managerEmail,
    },
    managerWorkspaceId,
    relationshipProperty,
  };
}

async function assertNoFixtureCollision(
  db: SupabaseClient,
  email: string,
  applicationId: string,
  inboxIds: string[],
) {
  const [{ data: authData, error: authError }, profile, application, inbox] = await Promise.all([
    db.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    db.from("profiles").select("id").or(`email.eq.${email},manager_id.eq.${applicationId}`).limit(1),
    db.from("manager_application_records").select("id").eq("id", applicationId).limit(1),
    db.from("portal_inbox_thread_records").select("id").in("id", inboxIds).limit(1),
  ]);
  if (authError) throw new Error(`Could not preflight temporary auth collision: ${authError.message}`);
  if (profile.error) throw new Error(`Could not preflight temporary profile collision: ${profile.error.message}`);
  if (application.error) throw new Error(`Could not preflight temporary application collision: ${application.error.message}`);
  if (inbox.error) throw new Error(`Could not preflight temporary inbox collisions: ${inbox.error.message}`);
  const authCollision = (authData.users ?? []).some((user) => user.email?.trim().toLowerCase() === email);
  if (
    authCollision ||
    (profile.data?.length ?? 0) > 0 ||
    (application.data?.length ?? 0) > 0 ||
    (inbox.data?.length ?? 0) > 0
  ) {
    throw new Error("Generated conversation fixture identity collided with existing dev/test data; no writes were made.");
  }
}

async function insertExactRow(state: Fixture, row: Record<string, unknown>) {
  requireDevTestDatabase();
  const id = String(row.id);
  const ownerId = String(row.owner_user_id);
  const { error } = await state.db.from("portal_inbox_thread_records").insert(row);
  if (error) throw new Error(`Could not insert task-owned inbox row ${id}: ${error.message}`);
  state.inserted.push({ id, ownerId });
}

async function cleanupFixture(state: Fixture | null) {
  if (!state) return;
  requireDevTestDatabase();
  const failures: string[] = [];
  const remaining: InsertedRow[] = [];
  for (const row of state.inserted) {
    const { error } = await state.db
      .from("portal_inbox_thread_records")
      .delete()
      .eq("id", row.id)
      .eq("owner_user_id", row.ownerId);
    if (error) {
      failures.push(`${row.id}: ${error.message}`);
      remaining.push(row);
    }
  }
  state.inserted = remaining;
  if (state.applicationCreated) {
    const { error } = await state.db
      .from("manager_application_records")
      .delete()
      .eq("id", state.applicationId)
      .eq("manager_user_id", state.manager.id)
      .eq("resident_email", state.resident.email);
    if (error) failures.push(`${state.applicationId}: ${error.message}`);
    else state.applicationCreated = false;
  }
  if (state.roleCreated) {
    const { error } = await state.db
      .from("profile_roles")
      .delete()
      .eq("user_id", state.resident.id)
      .eq("role", "resident");
    if (error) failures.push(`profile_roles ${state.resident.id}: ${error.message}`);
    else state.roleCreated = false;
  }
  if (state.profileCreated) {
    const { error } = await state.db
      .from("profiles")
      .delete()
      .eq("id", state.resident.id)
      .eq("email", state.resident.email);
    if (error) failures.push(`profiles ${state.resident.id}: ${error.message}`);
    else state.profileCreated = false;
  }
  if (
    state.authUserCreated &&
    state.inserted.length === 0 &&
    !state.applicationCreated &&
    !state.roleCreated &&
    !state.profileCreated
  ) {
    const { error } = await state.db.auth.admin.deleteUser(state.resident.id);
    if (error) failures.push(`auth user ${state.resident.id}: ${error.message}`);
    else state.authUserCreated = false;
  }
  if (failures.length > 0) throw new Error(`Could not clean exact conversation fixtures: ${failures.join("; ")}`);
}

async function createFixture(): Promise<Fixture> {
  const { url, serviceKey } = requireDevTestDatabase();
  const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const seeded = await resolveSeededManager(db);
  const residentEmail = `${RUN_PREFIX.replace(/[^a-z0-9-]/gi, "-")}@test.proplane.local`.toLowerCase();
  const residentPassword = `Temp!${randomUUID()}Aa1`;
  const residentName = "Conversation Identity Resident";
  const applicationId = `AXIS-CONV-${randomUUID()}`;
  const ids = {
    residentEmail: `${RUN_PREFIX}-resident-email`,
    residentTour: `${RUN_PREFIX}-resident-tour`,
    managerProspect: `${RUN_PREFIX}-manager-prospect`,
    managerApplication: `${RUN_PREFIX}-manager-application`,
    managerEmail: `${RUN_PREFIX}-manager-email`,
    managerConflict: `${RUN_PREFIX}-manager-conflict`,
  };
  await assertNoFixtureCollision(db, residentEmail, applicationId, Object.values(ids));
  const state: Fixture = {
    db,
    ...seeded,
    resident: { id: "", email: residentEmail, name: residentName, password: residentPassword },
    ids,
    inserted: [],
    applicationId,
    applicationCreated: false,
    roleCreated: false,
    profileCreated: false,
    authUserCreated: false,
  };
  // Keep partial ownership reachable by afterAll even if setup throws and its
  // immediate cleanup encounters a transient failure.
  fixture = state;
  const now = Date.now();
  const makeRow = (args: {
    id: string;
    scope: string;
    ownerId: string;
    participantEmail: string;
    from: string;
    email: string;
    marker: string;
    subject: string;
    offsetMs: number;
    identity: ReturnType<typeof relationship>;
    category: string;
  }) => {
    const at = new Date(now + args.offsetMs);
    return {
      id: args.id,
      scope: args.scope,
      owner_user_id: args.ownerId,
      participant_email: args.participantEmail,
      thread_type: "person",
      row_data: {
        id: args.id,
        folder: "inbox",
        from: args.from,
        email: args.email,
        subject: args.subject,
        preview: args.marker,
        body: args.marker,
        time: inboxStamp(at),
        rootAt: at.toISOString(),
        rootChannel: "email",
        rootOutbound: false,
        unread: true,
        category: args.category,
        ...args.identity,
        identityProvenance: [args.identity],
      },
      updated_at: at.toISOString(),
    };
  };

  try {
    requireDevTestDatabase();
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email: residentEmail,
      password: residentPassword,
      email_confirm: true,
      user_metadata: { role: "resident" },
    });
    if (createError || !created.user?.id) {
      throw new Error(`Could not create isolated resident auth fixture: ${createError?.message ?? "missing user id"}`);
    }
    state.resident.id = created.user.id;
    state.authUserCreated = true;
    // The resident inbox GET deterministically creates this task-owned
    // Assistant row. Track it before navigation so cleanup also covers an
    // interrupted run after the route creates it.
    state.inserted.push({
      id: `resident-agent-${state.resident.id}`,
      ownerId: state.resident.id,
    });

    const { data: autoProfile, error: autoProfileError } = await db
      .from("profiles")
      .select("id,email")
      .eq("id", state.resident.id)
      .maybeSingle();
    if (autoProfileError) throw new Error(`Could not inspect isolated resident profile: ${autoProfileError.message}`);
    if (autoProfile) {
      if (String(autoProfile.email ?? "").trim().toLowerCase() !== residentEmail) {
        throw new Error("Temporary auth fixture produced a conflicting profile email.");
      }
      const { error } = await db.from("profiles").update({
        role: "resident",
        manager_id: applicationId,
        full_name: residentName,
        application_approved: false,
      }).eq("id", state.resident.id).eq("email", residentEmail);
      if (error) throw new Error(`Could not finish isolated resident profile: ${error.message}`);
    } else {
      const { error } = await db.from("profiles").insert({
        id: state.resident.id,
        email: residentEmail,
        role: "resident",
        manager_id: applicationId,
        full_name: residentName,
        application_approved: false,
      });
      if (error) throw new Error(`Could not insert isolated resident profile: ${error.message}`);
    }
    state.profileCreated = true;

    const { data: autoRole, error: autoRoleError } = await db
      .from("profile_roles")
      .select("user_id")
      .eq("user_id", state.resident.id)
      .eq("role", "resident")
      .maybeSingle();
    if (autoRoleError) throw new Error(`Could not inspect isolated resident role: ${autoRoleError.message}`);
    if (!autoRole) {
      const { error } = await db.from("profile_roles").insert({ user_id: state.resident.id, role: "resident" });
      if (error) throw new Error(`Could not insert isolated resident role: ${error.message}`);
    }
    state.roleCreated = true;

    const { error: applicationError } = await db.from("manager_application_records").insert({
      id: applicationId,
      manager_user_id: state.manager.id,
      resident_email: state.resident.email,
      property_id: state.relationshipProperty.id,
      assigned_property_id: null,
      row_data: {
        id: applicationId,
        axisId: applicationId,
        bucket: "pending",
        stage: "Submitted",
        email: state.resident.email,
        name: state.resident.name,
        property: state.relationshipProperty.title,
        managerUserId: state.manager.id,
        propertyId: state.relationshipProperty.id,
        residentUserId: state.resident.id,
        testRunId: RUN_PREFIX,
      },
      updated_at: new Date(now).toISOString(),
    });
    if (applicationError) throw new Error(`Could not insert isolated resident application: ${applicationError.message}`);
    state.applicationCreated = true;

    const residentIdentity = relationship(state.manager.id, state.relationshipProperty, "manager");
    const managerIdentity = relationship(state.manager.id, state.relationshipProperty, "resident");
    // Same address plus a conflicting trusted role must remain independently
    // selectable without inventing another external person.
    const conflictIdentity = relationship(state.manager.id, state.relationshipProperty, "vendor");
    const rows = [
    makeRow({
      id: ids.residentEmail,
      scope: RESIDENT_SCOPE,
      ownerId: state.resident.id,
      participantEmail: state.manager.email,
      from: state.manager.name,
      email: state.manager.email,
      marker: residentEmailMarker,
      subject: `${RUN_PREFIX} manager email`,
      offsetMs: 1_000,
      identity: residentIdentity,
      category: "Application",
    }),
    makeRow({
      id: ids.residentTour,
      scope: RESIDENT_SCOPE,
      ownerId: state.resident.id,
      participantEmail: state.manager.email,
      from: "PropLane Tours",
      email: state.manager.email,
      marker: residentTourMarker,
      subject: `${RUN_PREFIX} tour history`,
      offsetMs: 2_000,
      identity: residentIdentity,
      category: "Tour",
    }),
    makeRow({
      id: ids.managerProspect,
      scope: MANAGER_SCOPE,
      ownerId: state.manager.id,
      participantEmail: state.resident.email,
      from: state.resident.name,
      email: state.resident.email,
      marker: managerProspectMarker,
      subject: `${RUN_PREFIX} prospect history`,
      offsetMs: 3_000,
      identity: managerIdentity,
      category: "Tour",
    }),
    makeRow({
      id: ids.managerApplication,
      scope: MANAGER_SCOPE,
      ownerId: state.manager.id,
      participantEmail: state.resident.email,
      from: state.resident.name,
      email: state.resident.email,
      marker: managerApplicationMarker,
      subject: `${RUN_PREFIX} application history`,
      offsetMs: 4_000,
      identity: managerIdentity,
      category: "Application",
    }),
    makeRow({
      id: ids.managerEmail,
      scope: MANAGER_SCOPE,
      ownerId: state.manager.id,
      participantEmail: state.resident.email,
      from: state.resident.name,
      email: state.resident.email,
      marker: managerEmailMarker,
      subject: `${RUN_PREFIX} email history`,
      offsetMs: 5_000,
      identity: managerIdentity,
      category: "Application",
    }),
    makeRow({
      id: ids.managerConflict,
      scope: MANAGER_SCOPE,
      ownerId: state.manager.id,
      participantEmail: state.resident.email,
      from: state.resident.name,
      email: state.resident.email,
      marker: managerConflictMarker,
      subject: `${RUN_PREFIX} conflicting history`,
      offsetMs: 6_000,
      identity: conflictIdentity,
      category: "Application",
    }),
    ];
    for (const row of rows) await insertExactRow(state, row);
    return state;
  } catch (error) {
    await cleanupFixture(state);
    throw error;
  }
}

async function openAndReadInbox(page: Page, route: string, scope: string): Promise<InboxApiRow[]> {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  // Read the real authenticated route explicitly. The UI sync has a 15-second
  // in-flight/TTL guard, so waiting for a navigation-triggered GET is flaky
  // after the dashboard/nav badge already warmed it during sign-in.
  const response = await page.request.get(`/api/portal-inbox-threads?scope=${encodeURIComponent(scope)}`);
  expect(response.status(), `GET ${scope}`).toBe(200);
  const payload = (await response.json()) as { rows?: InboxApiRow[] };
  expect(Array.isArray(payload.rows)).toBe(true);
  return payload.rows ?? [];
}

function rowContainingSources(rows: InboxApiRow[], ids: string[]): InboxApiRow {
  const expected = new Set(ids);
  const row = rows.find((candidate) => {
    const members = new Set(candidate.sourceThreadIds ?? [candidate.id]);
    return ids.every((id) => members.has(id));
  });
  expect(row, `one API row should contain sources ${[...expected].join(", ")}`).toBeTruthy();
  return row!;
}

function threadBubble(page: Page, marker: string) {
  return page.locator('[data-inbox-bubble-kind]').getByText(marker, { exact: true });
}

async function expectReadAcknowledgement(page: Page, ids: string[], action: () => Promise<void>) {
  const responsePromise = page.waitForResponse((response) => {
    if (response.request().method() !== "POST") return false;
    return new URL(response.url()).pathname === "/api/portal-inbox-threads";
  });
  await action();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    ok?: boolean;
    results?: { id: string; status: string; unread: boolean }[];
  };
  expect(payload.ok).toBe(true);
  expect(new Set((payload.results ?? []).map((result) => result.id))).toEqual(new Set(ids));
  for (const result of payload.results ?? []) {
    expect(["read", "alreadyRead"]).toContain(result.status);
    expect(result.unread).toBe(false);
  }
}

async function installExternalWriteFence(page: Page, blockManagerInboxPersistence = false) {
  const blockedAutomaticDrafts: string[] = [];
  const blockedInboxPersistence: string[] = [];
  const forbiddenSendAttempts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD") {
      await route.continue();
      return;
    }
    const pathname = new URL(request.url()).pathname;
    if (blockManagerInboxPersistence && pathname === "/api/portal-inbox-threads") {
      let action = "unparseable";
      try {
        const body = request.postDataJSON() as { action?: string };
        action = String(body.action ?? "unknown");
      } catch {
        // Every manager inbox mutation is blocked, including malformed or
        // scope-less persistence. The browser path remains read-only.
      }
      blockedInboxPersistence.push(`${action} ${pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (pathname.includes("inbox-draft-reply")) {
      blockedAutomaticDrafts.push(`${request.method()} ${pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (
      pathname.includes("send-inbox-message") ||
      pathname.includes("scheduled-messages") ||
      pathname.includes("scheduled-inbox-messages") ||
      pathname.includes("/api/manager/sms")
    ) {
      forbiddenSendAttempts.push(`${request.method()} ${pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return { blockedAutomaticDrafts, blockedInboxPersistence, forbiddenSendAttempts };
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("Conversation identity browser regression", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test.beforeAll(async () => {
    fixture = await createFixture();
  });

  test.afterAll(async () => {
    await cleanupFixture(fixture);
    fixture = null;
  });

  test("resident sees one verified manager history, deep links, read filtering, and a draft-only mobile reply", async ({ browser }) => {
    if (!fixture) throw new Error("Conversation identity fixture was not created.");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const page = await context.newPage();
      const writeFence = await installExternalWriteFence(page);
      await signIn(page, fixture.resident.email, fixture.resident.password, "/resident/dashboard");
      await establishActivePortal(page, "resident", "/resident/dashboard");
      const rows = await openAndReadInbox(
        page,
        "/resident/communication/unread",
        RESIDENT_SCOPE,
      );
      const merged = rowContainingSources(rows, [fixture.ids.residentEmail, fixture.ids.residentTour]);
      expect(merged.readSourcesComplete).toBe(true);
      expect(new Set((merged.readSources ?? []).map((source) => source.id))).toEqual(
        new Set([fixture.ids.residentEmail, fixture.ids.residentTour]),
      );
      expect(merged.unread).toBe(true);

      const rowButton = page.locator("[data-communication-inbox-list] .portal-inbox-row button").filter({ hasText: RUN_PREFIX });
      await expect(rowButton).toHaveCount(1);
      await expectReadAcknowledgement(page, [fixture.ids.residentEmail, fixture.ids.residentTour], async () => {
        await rowButton.click();
      });
      await expect(threadBubble(page, residentEmailMarker)).toBeVisible();
      await expect(threadBubble(page, residentTourMarker)).toBeVisible();
      await expect(page.locator(".portal-inbox-thread-header").getByText(fixture.manager.name, { exact: true })).toBeVisible();

      await page.goto(`/resident/communication/active/${encodeURIComponent(fixture.ids.residentEmail)}`);
      await expect(threadBubble(page, residentEmailMarker)).toBeVisible();
      await expect(threadBubble(page, residentTourMarker)).toBeVisible();
      await expect(page.getByText("PropLane Assistant", { exact: true }).first()).toBeVisible();
      await page.goto(`/resident/communication/active/${encodeURIComponent(fixture.ids.residentTour)}`);
      await expect(threadBubble(page, residentEmailMarker)).toBeVisible();
      await expect(threadBubble(page, residentTourMarker)).toBeVisible();

      await page.goto("/resident/communication/unread");
      await expect(page.locator("[data-communication-inbox-list] .portal-inbox-row button").filter({ hasText: RUN_PREFIX })).toHaveCount(0);

      const emptySearch = page.locator('[data-attr="resident-inbox-search"]');
      const noMatchQuery = `${RUN_PREFIX}-no-match`;
      await emptySearch.fill(noMatchQuery);
      await expect(
        page.locator("[data-communication-inbox-list]").getByText(`No messages match “${noMatchQuery}”.`, { exact: true }),
      ).toBeVisible();
      await emptySearch.fill("");
      await expect(page.locator("[data-communication-inbox-list]").getByText("No unread conversations.", { exact: true })).toBeVisible();
      await page.goto("/resident/communication/active");
      await expect(page.getByText("PropLane Assistant", { exact: true }).first()).toBeVisible();

      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/resident/communication/active/${encodeURIComponent(fixture.ids.residentEmail)}`);
      await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
      const composer = page.locator('textarea[data-attr="resident-inbox-reply"]');
      await expect(composer).toBeVisible();
      await composer.fill(residentDraft);
      await expect(composer).toHaveValue(residentDraft);
      await expect(page.locator(".portal-inbox-thread-header").getByText(fixture.manager.name, { exact: true })).toBeVisible();
      expect(writeFence.forbiddenSendAttempts).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("manager merges prospect, application, and email sources while isolating conflict and Assistant", async ({ browser }) => {
    if (!fixture) throw new Error("Conversation identity fixture was not created.");
    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
      baseURL,
      viewport: { width: 1440, height: 1000 },
    });
    try {
      const page = await context.newPage();
      const writeFence = await installExternalWriteFence(page, true);
      await signInAsManager(page);
      await context.addCookies([{
        name: "proplane-workspace",
        value: fixture.managerWorkspaceId,
        url: baseURL,
      }]);
      const rows = await openAndReadInbox(
        page,
        `/portal/communication/active/${encodeURIComponent(fixture.ids.managerApplication)}`,
        MANAGER_SCOPE,
      );
      const mergedIds = [fixture.ids.managerProspect, fixture.ids.managerApplication, fixture.ids.managerEmail];
      const merged = rowContainingSources(rows, mergedIds);
      expect(merged.readSourcesComplete).toBe(true);
      expect(new Set((merged.readSources ?? []).map((source) => source.id))).toEqual(new Set(mergedIds));
      const conflicting = rowContainingSources(rows, [fixture.ids.managerConflict]);
      expect(conflicting.sourceThreadIds ?? [conflicting.id]).not.toEqual(expect.arrayContaining(mergedIds));
      expect(rows.some((row) => row.threadType === "agent_notice" || row.id.startsWith("agent_notice_"))).toBe(true);

      await expect(threadBubble(page, managerProspectMarker)).toBeVisible();
      await expect(threadBubble(page, managerApplicationMarker)).toBeVisible();
      await expect(threadBubble(page, managerEmailMarker)).toBeVisible();
      await expect(threadBubble(page, managerConflictMarker)).toHaveCount(0);

      await page.goto(`/portal/communication/active/${encodeURIComponent(fixture.ids.managerEmail)}`);
      await expect(threadBubble(page, managerProspectMarker)).toBeVisible();
      await expect(threadBubble(page, managerApplicationMarker)).toBeVisible();
      await expect(threadBubble(page, managerEmailMarker)).toBeVisible();

      await page.setViewportSize({ width: 375, height: 812 });
      await page.getByRole("button", { name: "Back to conversations" }).click();
      const search = page.locator('[data-attr="unified-inbox-search"]');
      await search.fill(RUN_PREFIX);
      await expect(page.locator("[data-communication-inbox-list] .portal-inbox-row button").filter({ hasText: RUN_PREFIX })).toHaveCount(2);
      await search.fill(`${RUN_PREFIX}-no-match`);
      await expect(page.locator('[data-attr="unified-inbox-empty"]')).toBeVisible();
      await page.locator('[data-attr="unified-inbox-empty-clear-search"]').click();
      await expect(page.getByText("PropLane Assistant", { exact: true }).first()).toBeVisible();

      await page.goto(`/portal/communication/active/${encodeURIComponent(fixture.ids.managerProspect)}`);
      await expect(page.getByRole("button", { name: "Back to conversations" })).toBeVisible();
      const composer = page.locator('textarea[data-attr="inbox-reply"]');
      await expect(composer).toBeVisible();
      await composer.fill(managerDraft);
      await expect(composer).toHaveValue(managerDraft);
      await expect(page.locator(".portal-inbox-thread-header").getByText(fixture.resident.name, { exact: true })).toBeVisible();
      expect(writeFence.forbiddenSendAttempts).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
