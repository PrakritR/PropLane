#!/usr/bin/env node
/** Dev/test-only behavioral regression: database limits, UPSERT and direct-role denial. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
assert.equal(new URL(url).hostname, 'emstjswhotsnyksqhqyf.supabase.co', 'This probe only targets dev/test.');
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const prefix = `e2e-test-workspace-${randomUUID()}`;
const password = randomUUID() + 'Aa1!';
let userId;
try {
  const user = await db.auth.admin.createUser({ email: `${prefix}@test.proplane.local`, password, email_confirm: true });
  assert.ifError(user.error); userId = user.data.user.id;
  const profile = await db.from('profiles').upsert({ id: userId, email: `${prefix}@test.proplane.local`, role: 'manager', full_name: 'Workspace constraint test' });
  assert.ifError(profile.error);
  const first = await db.rpc('ensure_default_portal_workspace', { p_owner: userId });
  assert.ifError(first.error);
  const workspaces = await db.from('portal_workspaces').insert([
    { owner_user_id: userId, name: 'Second' }, { owner_user_id: userId, name: 'Third' },
  ]).select('id');
  assert.ifError(workspaces.error);
  assert.equal((await db.from('portal_workspaces').insert({ owner_user_id: userId, name: 'Fourth' })).error?.code, '23514');
  const destination = workspaces.data[0].id;
  const record = (n) => ({ id: `${prefix}-${n}`, manager_user_id: userId, workspace_id: destination, status: 'draft', row_data: { buildingName: 'Workspace test draft' } });
  assert.ifError((await db.from('manager_property_records').insert(Array.from({ length: 9 }, (_, n) => record(n)))).error);
  const raced = await Promise.all([9, 10].map((n) => db.from('manager_property_records').insert(record(n))));
  assert.equal(raced.filter((r) => !r.error).length, 1, 'Only one concurrent caller gets the tenth slot.');
  assert.equal(raced.find((r) => r.error)?.error.code, '23514');
  const update = await db.from('manager_property_records').upsert({ ...record(0), workspace_id: undefined, row_data: { buildingName: 'Updated at capacity' } }).select('workspace_id').single();
  assert.ifError(update.error); assert.equal(update.data.workspace_id, destination, 'UPSERT keeps non-default workspace.');
  assert.equal((await db.from('portal_workspaces').delete().eq('id', destination)).error?.code, '23503', 'Deleting nonempty workspace is refused.');
  const anonymous = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const login = await anonymous.auth.signInWithPassword({ email: `${prefix}@test.proplane.local`, password });
  assert.ifError(login.error);
  assert.ok((await anonymous.from('portal_workspaces').insert({ owner_user_id: userId, name: 'Forged' })).error, 'Browser roles cannot write workspace rows.');
  assert.ok((await anonymous.rpc('ensure_default_portal_workspace', { p_owner: userId })).error, 'Browser roles cannot call privileged workspace RPC.');
  console.log('PASS: 3-workspace cap, drafts consume slots, concurrent tenth-slot arbitration, UPSERT at cap preserves workspace, nonempty delete refused, browser writes/RPC denied.');
} finally {
  if (userId) {
    assert.ifError((await db.from('manager_property_records').delete().eq('manager_user_id', userId)).error);
    assert.ifError((await db.from('portal_workspaces').delete().eq('owner_user_id', userId)).error);
    assert.ifError((await db.auth.admin.deleteUser(userId)).error);
  }
}
