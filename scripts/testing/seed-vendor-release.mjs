#!/usr/bin/env node
/** Bounded dev-only release fixture. Default is read-only inspection. No wipe or provider calls. */
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { TEST_SUPABASE_PROJECT_REF, DOGFOOD_ACCOUNT_PASSWORD } from '../../tests/helpers/canonical-test-accounts.mjs';

const prefix = 'vendor-release-20261104';
const args = process.argv.slice(2);
if (args.some((arg) => !['--inspect', '--apply', '--schema-confirmed'].includes(arg)) ||
    (args.includes('--apply') && !args.includes('--schema-confirmed'))) {
  throw new Error('Use --inspect, or --apply --schema-confirmed only after manager confirms reviewed dev schema apply.');
}
const apply = args.includes('--apply');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (url !== `https://${TEST_SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Exact dev/test HTTPS target required.');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Dev service-role credential required.');
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const uuid = (label) => {
  const hex = createHash('sha256').update(`${prefix}:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const testWorkspaceId = uuid('capture-workspace');
const specs = ['manager', 'resident', 'vendor'].map((role) => ({
  role, email: `${prefix}-${role}@example.invalid`, name: `Vendor Release QA ${role}`,
}));
async function must(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label} failed (${error.code ?? 'request error'}).`);
  return data;
}
async function authDirectory() {
  const users = [];
  for (let page = 1; ; page++) {
    const result = await must(db.auth.admin.listUsers({ page, perPage: 100 }), 'Read auth directory');
    users.push(...result.users);
    if (result.users.length < 100) return users;
    if (page >= 100) throw new Error('Auth directory pagination safety bound reached.');
  }
}
const users = await authDirectory();
// Refuse taking over an email that is not explicitly ours. Never reset existing passwords or roles.
for (const spec of specs) {
  const existing = users.find((user) => user.email?.toLowerCase() === spec.email);
  if (existing && (existing.user_metadata?.vendorReleaseFixture !== prefix || existing.user_metadata?.role !== spec.role)) {
    throw new Error(`Fixture account ownership mismatch: ${spec.role}.`);
  }
}
const schema = [
  ['portal_work_order_records', 'id,resident_user_id,resident_subject_was_bound,row_revision,assigned_property_id'],
  ['manager_property_records', 'id,workspace_id,test_workspace_id'],
  ['vendor_sourcing_jobs', 'id,state'], ['vendor_sourcing_candidates', 'id,proposal_id'],
  ['vendor_quote_contact_capabilities', 'id,sender_snapshot'],
  ['vendor_coordination_proposals', 'id,version'], ['manager_automation_settings', 'manager_user_id,vendor_dispatch'],
  ['test_workspaces', 'id'], ['test_workspace_members', 'user_id,portal_role'],
];
for (const [table, columns] of schema) await must(db.from(table).select(columns).limit(0), `Read ${table} schema`);
if (!apply) {
  console.log(JSON.stringify({ mode: 'read-only', target: TEST_SUPABASE_PROJECT_REF,
    fixtureAccountsPresent: specs.map((s) => ({ role: s.role, present: users.some((u) => u.email?.toLowerCase() === s.email) })),
    schemaShapeReadable: true, note: 'Column probes do not verify migration hashes, grants or functions. Manager migration postflight remains required.' }, null, 2));
  process.exit(0);
}

// Insert missing rows only. Re-runs retain browser progress and refuse foreign records.
async function ownedInsert(table, key, value, row, owns) {
  const existing = await must(db.from(table).select('*').eq(key, value).maybeSingle(), `Read ${table}`);
  if (existing) {
    if (!owns(existing)) throw new Error(`Existing ${table} fixture ownership/state mismatch.`);
    return existing;
  }
  return must(db.from(table).insert(row).select('*').single(), `Insert ${table}`);
}
const accounts = {};
for (const spec of specs) {
  let user = users.find((candidate) => candidate.email?.toLowerCase() === spec.email);
  if (!user) {
    user = (await must(db.auth.admin.createUser({ email: spec.email, password: DOGFOOD_ACCOUNT_PASSWORD,
      email_confirm: true, user_metadata: { role: spec.role, full_name: spec.name, vendorReleaseFixture: prefix } }), 'Create fixture auth user')).user;
  }
  accounts[spec.role] = { ...spec, id: user.id };
}
const manager = accounts.manager;
const resident = accounts.resident;
const vendor = accounts.vendor;
// Durable classification protects owner-triggered provider boundaries during ordinary browser QA.
await ownedInsert('test_workspaces', 'id', testWorkspaceId,
  { id: testWorkspaceId, name: prefix, status: 'active', created_by_user_id: manager.id },
  (r) => r.name === prefix && r.created_by_user_id === manager.id && r.status === 'active');
for (const account of [manager, resident]) {
  await ownedInsert('test_workspace_members', 'user_id', account.id,
    { workspace_id: testWorkspaceId, user_id: account.id, portal_role: account.role, state: 'active', created_by_user_id: manager.id },
    (r) => r.workspace_id === testWorkspaceId && r.portal_role === account.role && r.state === 'active' && !r.expires_at);
}
for (const account of Object.values(accounts)) {
  const profile = await must(db.from('profiles').select('*').eq('id', account.id).maybeSingle(), 'Read fixture profile');
  if (profile && (profile.email !== account.email || profile.role !== account.role)) throw new Error('Fixture profile mismatch.');
  // Auth's normal signup trigger may already have created the profile.
  if (!profile) await must(db.from('profiles').insert({ id: account.id, email: account.email, role: account.role, full_name: account.name }), 'Insert fixture profile');
  const roles = await must(db.from('profile_roles').select('role').eq('user_id', account.id), 'Read fixture roles');
  if (roles.some((r) => r.role !== account.role)) throw new Error('Unexpected extra fixture role.');
  if (!roles.length) await must(db.from('profile_roles').insert({ user_id: account.id, role: account.role }), 'Insert fixture role');
}
const workspaceId = await must(db.rpc('ensure_default_portal_workspace', { p_owner: manager.id }), 'Ensure owned default workspace');
await ownedInsert('manager_automation_settings', 'manager_user_id', manager.id,
  { manager_user_id: manager.id, row_data: { vendorReleaseFixture: prefix }, vendor_dispatch: {
    mode: 'off', agentMessagingEnabled: false, quoteSourcingEnabled: true, spendCapCents: null,
    approvedVendorIds: null, categories: ['Plumbing'], notify: { push: false, sms: false },
  } }, (r) => r.row_data?.vendorReleaseFixture === prefix);
const propertyId = `${prefix}-property`;
await ownedInsert('manager_property_records', 'id', propertyId,
  { id: propertyId, manager_user_id: manager.id, workspace_id: workspaceId, test_workspace_id: testWorkspaceId,
    status: 'unlisted', row_data: { id: propertyId, title: 'Vendor Release QA Home', address: '100 Fixture Lane',
      city: 'Seattle', state: 'WA', zip: '98101', imageUrl: '', vendorReleaseFixture: prefix }, property_data: { city: 'Seattle', state: 'WA' } },
  (r) => r.manager_user_id === manager.id && r.workspace_id === workspaceId && r.test_workspace_id === testWorkspaceId && r.row_data?.vendorReleaseFixture === prefix);
const now = new Date().toISOString();
// Real portal rows with explicit test-only attested tenancy; no fabricated legal signatures or money rows.
const leaseId = `${prefix}-tenancy`;
await ownedInsert('portal_lease_pipeline_records', 'id', leaseId,
  { id: leaseId, manager_user_id: manager.id, resident_user_id: resident.id, resident_email: resident.email,
    property_id: propertyId, status: 'manager', row_data: { id: leaseId, propertyId, residentUserId: resident.id,
      residentName: resident.name, residentEmail: resident.email, managerAttestedTenancyAt: now,
      title: 'QA existing tenancy', bucket: 'manager', vendorReleaseFixture: prefix } },
  (r) => r.manager_user_id === manager.id && r.resident_user_id === resident.id && r.row_data?.vendorReleaseFixture === prefix);
const manifest = [];
for (const [index, kind] of ['signed', 'directory'].entries()) {
  const directoryId = `${prefix}-${kind}-vendor`;
  const workOrderId = `${prefix}-${kind}-service`;
  const email = index ? `${prefix}-directory@example.invalid` : vendor.email;
  await ownedInsert('manager_vendor_records', 'id', directoryId,
    { id: directoryId, manager_user_id: manager.id, vendor_user_id: index ? null : vendor.id,
      row_data: { id: directoryId, name: index ? 'QA Directory Vendor' : vendor.name, email, phone: '',
        trade: 'Plumbing', trades: ['Plumbing'], city: 'Seattle', active: true, sharedWithManagers: false, vendorReleaseFixture: prefix } },
    (r) => r.manager_user_id === manager.id && r.vendor_user_id === (index ? null : vendor.id) && r.row_data?.vendorReleaseFixture === prefix);
  await ownedInsert('portal_work_order_records', 'id', workOrderId,
    { id: workOrderId, manager_user_id: manager.id, resident_user_id: resident.id, resident_email: resident.email,
      property_id: propertyId, assigned_property_id: propertyId, vendor_user_id: null, test_workspace_id: testWorkspaceId,
      row_data: { id: workOrderId, reference: `WO-${9026114 + index}`, title: 'Plumbing issue',
        description: 'A faucet is leaking.', propertyId, assignedPropertyId: propertyId,
        propertyName: 'Vendor Release QA Home', residentName: resident.name, residentEmail: resident.email,
        bucket: 'open', status: 'Open', priority: 'Normal', category: 'Plumbing', biddingOpen: true,
        managerInitiated: true, vendorReleaseFixture: prefix } },
    (r) => r.manager_user_id === manager.id && r.resident_user_id === resident.id && r.property_id === propertyId && r.row_data?.vendorReleaseFixture === prefix);
  // needs_attention jobs are never claimed by the sweep. Explicit later start/resume is acceptance work.
  const job = await ownedInsert('vendor_sourcing_jobs', 'work_order_id', workOrderId,
    { id: uuid(`${kind}-job`), work_order_id: workOrderId, manager_user_id: manager.id, state: 'needs_attention',
      reason: 'QA manual contact only; no invitation evidence or phone consent is seeded.' },
    (r) => r.manager_user_id === manager.id);
  const candidateId = uuid(`${kind}-candidate`);
  await ownedInsert('vendor_sourcing_candidates', 'id', candidateId,
    { id: candidateId, job_id: job.id, manager_user_id: manager.id, stage: 0, source: 'roster',
      source_directory_id: directoryId, local_directory_id: directoryId, dedupe_key: `fixture:${directoryId}`,
      contact: { name: index ? 'QA Directory Vendor' : vendor.name, trade: 'Plumbing', email, phone: null },
      status: 'manual_contact_required', expires_at: new Date(Date.now() + 7 * 86400000).toISOString() },
    (r) => r.manager_user_id === manager.id && r.job_id === job.id && r.local_directory_id === directoryId);
  manifest.push({ kind, workOrderId, directoryId, candidateId, jobId: job.id });
}
console.log(JSON.stringify({ target: TEST_SUPABASE_PROJECT_REF, prefix, testWorkspaceId, workspaceId, propertyId,
  accounts: Object.values(accounts).map(({ role, email, id }) => ({ role, email, id })), services: manifest,
  next: 'No enrollment, capability, sender provisioning, delivery, consent, approval or payment performed. See HTML fixture handoff.' }, null, 2));
