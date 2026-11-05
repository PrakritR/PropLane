import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as unknown, verify: vi.fn(), definers: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: function () { return state.client; } } }));
vi.mock('../../scripts/security/signup-fixture-observer-provision.mjs', () => ({
  verifyInstallation: (...args: unknown[]) => state.verify(...args),
  rejectUnreviewedDefiners: (...args: unknown[]) => state.definers(...args),
}));
import { connectSignupObserver } from '../../scripts/signup-proof-observer.mjs';
import { preflightSignupCleanup } from '../../scripts/signup-proof-cleanup-preflight.mjs';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); vi.clearAllMocks(); });
function harness() {
  const dir = mkdtempSync(path.join(tmpdir(), 'observer-offline-')); dirs.push(dir);
  const ca = path.join(dir, 'ca.pem'); writeFileSync(ca, 'offline CA');
  let transaction = false, clock = 0, lastQuery = 0;
  const client = {
    connection: { stream: { encrypted: true, authorized: true } },
    connect: vi.fn(async () => undefined), end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      if (transaction && clock - lastQuery > 15_000) throw new Error('idle transaction terminated');
      lastQuery = clock;
      if (sql === 'BEGIN READ ONLY') transaction = true;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') transaction = false;
      if (sql.startsWith('select current_user')) return { rows: [{ role: 'signup_fixture_observer', session_role: 'signup_fixture_observer', database: 'postgres' }] };
      if (sql.includes('session_counts')) return { rows: [{ project_ref: 'emstjswhotsnyksqhqyf', sessions: 0, refresh_tokens: 0 }] };
      return { rows: [] };
    }),
  };
  state.client = client; state.verify.mockResolvedValue(undefined); state.definers.mockResolvedValue(undefined);
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://emstjswhotsnyksqhqyf.supabase.co', SIGNUP_PROOF_OBSERVER_URL: 'postgres://signup_fixture_observer.emstjswhotsnyksqhqyf:offline@aws-1-us-west-2.pooler.supabase.com:5432/postgres', SUPABASE_DB_SSL_CA_FILE: ca };
  return { client, env, inTransaction: () => transaction, delayHTTP: () => { clock += 30_000; } };
}
describe('signup observer short read-only lifetime', () => {
  it('commits verification before HTTP guard intervals and keeps later observations in autocommit', async () => {
    const h = harness(); const client = await connectSignupObserver(h.env);
    expect(h.inTransaction()).toBe(false);
    expect(h.client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN READ ONLY', 'select current_user as role,session_user as session_role,current_database() as database', 'COMMIT']);
    expect(state.verify).toHaveBeenCalledWith(client); expect(state.definers).toHaveBeenCalledWith(client);
    for (let phase = 0; phase < 4; phase++) {
      h.delayHTTP();
      await expect(client.query('select * from signup_fixture_guard.session_counts($1::uuid)', ['00000000-0000-0000-0000-000000000000'])).resolves.toMatchObject({ rows: [{ sessions: 0 }] });
      expect(h.inTransaction()).toBe(false);
    }
    await client.end();
  });
  it.each(['installation', 'definers', 'commit'])('rolls back and closes on %s failure without exposing errors', async (failure) => {
    const h = harness();
    if (failure === 'installation') state.verify.mockRejectedValue(new Error('private credential'));
    if (failure === 'definers') state.definers.mockRejectedValue(new Error('private credential'));
    if (failure === 'commit') {
      const query = h.client.query.getMockImplementation()!;
      h.client.query.mockImplementation(async (sql) => { if (sql === 'COMMIT') throw new Error('private credential'); return query(sql); });
    }
    await expect(connectSignupObserver(h.env)).rejects.toThrow('Signup observer connection refused.');
    expect(h.inTransaction()).toBe(false); expect(h.client.end).toHaveBeenCalledOnce();
    expect(h.client.query).toHaveBeenLastCalledWith('ROLLBACK');
  });
  it('preflight uses the connected autocommit observer and always closes it', async () => {
    const h = harness();
    await preflightSignupCleanup(h.env);
    expect(h.inTransaction()).toBe(false); expect(h.client.end).toHaveBeenCalledOnce();
    expect(h.client.query.mock.calls.filter(([sql]) => sql === 'BEGIN READ ONLY')).toHaveLength(1);
    expect(h.client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
  });
});
