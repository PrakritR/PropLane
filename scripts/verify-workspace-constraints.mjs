#!/usr/bin/env node
/** Dev/test-only behavioral regression: database limits, UPSERT, delete-any-workspace, and direct-role denial. */
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
  // The database ceiling is ten (plan add-ons); the plan cap in /api/workspaces narrows it.
  const extras = await db.from('portal_workspaces').insert(Array.from({ length: 7 }, (_, n) => ({ owner_user_id: userId, name: `Extra ${n}` }))).select('id');
  assert.ifError(extras.error);
  assert.equal((await db.from('portal_workspaces').insert({ owner_user_id: userId, name: 'Eleventh' })).error?.code, '23514');
  assert.ifError((await db.from('portal_workspaces').delete().in('id', extras.data.map((row) => row.id))).error);
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
  assert.ok((await anonymous.rpc('delete_portal_workspace', { p_owner: userId, p_id: destination, p_move_to: null })).error, 'Browser roles cannot call the delete RPC.');
  // Delete any workspace, the default included: houses move in the same
  // transaction, and "default" passes to the oldest remaining workspace.
  const third = workspaces.data[1].id;
  const full = await db.rpc('delete_portal_workspace', { p_owner: userId, p_id: destination, p_move_to: third });
  assert.ifError(full.error); assert.equal(full.data, true);
  assert.equal((await db.from('manager_property_records').select('id', { count: 'exact', head: true }).eq('workspace_id', third)).count, 10, 'All ten houses moved with the delete.');
  assert.equal((await db.rpc('delete_portal_workspace', { p_owner: randomUUID(), p_id: third, p_move_to: null })).data, false, 'A stranger deletes nothing.');
  assert.equal((await db.rpc('delete_portal_workspace', { p_owner: userId, p_id: third, p_move_to: null })).error?.code, '23503', 'Houses left behind still refuse the delete.');
  const defaultRow = (await db.from('portal_workspaces').select('id').eq('owner_user_id', userId).eq('is_default', true).single()).data;
  assert.ifError((await db.rpc('delete_portal_workspace', { p_owner: userId, p_id: defaultRow.id, p_move_to: null })).error);
  const promoted = await db.from('portal_workspaces').select('id,is_default').eq('owner_user_id', userId);
  assert.deepEqual(promoted.data, [{ id: third, is_default: true }], 'The oldest remaining workspace became the default.');
  assert.ifError((await db.from('manager_property_records').delete().eq('manager_user_id', userId)).error);
  assert.ifError((await db.rpc('delete_portal_workspace', { p_owner: userId, p_id: third, p_move_to: null })).error);
  assert.equal((await db.from('portal_workspaces').select('id', { count: 'exact', head: true }).eq('owner_user_id', userId)).count, 0, 'The last workspace can go.');
  const named = await db.rpc('create_portal_workspace_with_limit', { p_owner: userId, p_name: 'Only one', p_limit: 3 });
  assert.ifError(named.error);
  const seeded = await db.from('portal_workspaces').select('name,is_default').eq('owner_user_id', userId);
  assert.deepEqual(seeded.data, [{ name: 'Only one', is_default: true }], 'A named create seeds nothing beside itself.');
  console.log('PASS: 10-workspace ceiling, drafts consume slots, concurrent tenth-slot arbitration, UPSERT at cap preserves workspace, nonempty delete refused, browser writes/RPC denied, delete moves houses + promotes default + last workspace deletable, named create seeds nothing.');
} finally {
  if (userId) {
    assert.ifError((await db.from('manager_property_records').delete().eq('manager_user_id', userId)).error);
    assert.ifError((await db.from('portal_workspaces').delete().eq('owner_user_id', userId)).error);
    assert.ifError((await db.auth.admin.deleteUser(userId)).error);
  }
}
