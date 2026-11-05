import { createDecipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CALLABLE_DEFINERS_SQL, CATALOG_SQL, DEV_REF, INVENTORY_SQL, OBSERVER_SETUP_SQL, assertApplyOptions, githubSecretIO, provisionObserver, sourceDigest, verifyInstallation, rejectUnreviewedDefiners, observerMembershipsMeetBoundary } from '../../scripts/security/signup-fixture-observer-provision.mjs';

const backupKey = Buffer.alloc(32, 7).toString('base64');
function options(overrides = {}) {
  return { ref: DEV_REF, repository: 'PrakritR/PropLane', apiUrl: `https://${DEV_REF}.supabase.co`, reviewedSha256: sourceDigest(), backupPath: '/offline/observer.enc.json', backupKey, ...overrides };
}
const catalog = [{ schema: 'public', table_name: 'fixture', relkind: 'r', column_name: 'id', attnum: 1 }];
const boundary = { ...Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`guard${index}`, true])), memberships: [] };
function harness(overrides: { state?: object; boundary?: object; observerIdentity?: object; counts?: object; catalog?: object[]; denyCode?: string; publishFails?: boolean; disableFails?: boolean; backupFails?: boolean; commitFails?: boolean } = {}) {
  const state = { roles: [{ name: 'postgres' }], memberships: [], schema: null, functions: [], database_acl: null, ...overrides.state };
  let didFailCommit = false;
  const db = {
    connection: { stream: { encrypted: true, authorized: true } },
    query: vi.fn(async (sql: string) => {
      if (sql === INVENTORY_SQL) return { rows: [{ inventory: state }] };
      if (sql === CATALOG_SQL) return { rows: catalog };
      if (sql.startsWith('select current_user')) return { rows: [{ role: 'postgres', session_role: 'cli_login_postgres', database: 'postgres' }] };
      if (sql.includes('as schema_ok')) return { rows: [overrides.boundary ?? boundary] };
      if (sql === 'ALTER ROLE signup_fixture_observer NOLOGIN' && overrides.disableFails) throw new Error('sensitive DB error');
      if (sql === 'COMMIT' && overrides.commitFails && !didFailCommit) { didFailCommit = true; throw new Error('ambiguous commit'); }
      return { rows: [] };
    }), end: vi.fn(async () => undefined),
  };
  const observer = {
    connection: { stream: { encrypted: true, authorized: true } },
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('select current_user')) return { rows: [{ role: 'signup_fixture_observer', session_role: 'signup_fixture_observer', database: 'postgres', ...overrides.observerIdentity }] };
      if (sql === CATALOG_SQL) return { rows: overrides.catalog ?? catalog };
      if (sql.startsWith('select * from signup_fixture_guard')) return { rows: [{ project_ref: DEV_REF, sessions: '0', refresh_tokens: '0', ...overrides.counts }] };
      if (sql.startsWith('select user_id from auth.')) throw Object.assign(new Error('denied sensitive text'), { code: overrides.denyCode ?? '42501' });
      return { rows: [] };
    }), end: vi.fn(async () => undefined),
  };
  const secrets = { assertAbsent: vi.fn(async () => undefined), publish: vi.fn(async (dsn: string) => { void dsn; if (overrides.publishFails) throw new Error('secret DSN'); }), remove: vi.fn(async () => undefined) };
  const dependencies = {
    getConfig: vi.fn(() => ({ host: 'aws-1-us-west-2.pooler.supabase.com', port: 5432, user: `cli_login_postgres.${DEV_REF}`, password: 'private', database: 'postgres' })),
    connect: vi.fn().mockResolvedValueOnce(db).mockResolvedValueOnce(observer),
    writeBackup: vi.fn((path: string, content: string) => { void path; void content; if (overrides.backupFails) throw new Error('disk'); }), secrets,
  };
  return { db, observer, secrets, dependencies };
}

describe('DEV observer provisioning refuses unsafe operations offline', () => {
  it.each([
    { ref: 'qahnczmilgptcedaqype' }, { ref: 'xwszcafaontidfgznlxd' }, { repository: 'other/repo' },
    { apiUrl: 'https://qahnczmilgptcedaqype.supabase.co' }, { apiUrl: undefined },
    { reviewedSha256: 'a'.repeat(64) }, { backupPath: './plaintext.json' }, { backupKey: 'short' }, { backupKey: undefined },
  ])('rejects invalid preconditions before any IO: %j', async (override) => {
    const h = harness();
    await expect(provisionObserver(options(override), h.dependencies)).rejects.toThrow();
    expect(h.dependencies.getConfig).not.toHaveBeenCalled();
    expect(h.dependencies.connect).not.toHaveBeenCalled();
    expect(h.secrets.assertAbsent).not.toHaveBeenCalled();
  });
  it('allows only absent memberships or exact PG16 postgres creator administration', () => {
    const creator = { role: 'signup_fixture_observer', member: 'postgres', admin: true, inherit: false, set: false };
    expect(observerMembershipsMeetBoundary([])).toBe(true);
    expect(observerMembershipsMeetBoundary([creator])).toBe(true);
    for (const invalid of [
      { ...creator, role: 'postgres', member: 'signup_fixture_observer' },
      { ...creator, member: 'authenticated' }, { ...creator, admin: false },
      { ...creator, inherit: true }, { ...creator, set: true },
      { ...creator, inherit: null }, { ...creator, set: undefined },
    ]) expect(observerMembershipsMeetBoundary([invalid])).toBe(false);
    expect(observerMembershipsMeetBoundary([creator, creator])).toBe(false);
    expect(observerMembershipsMeetBoundary(null)).toBe(false);
  });
  it('accepts only the exact reviewed source digest', () => { expect(() => assertApplyOptions(options())).not.toThrow(); });
  it('refuses an unexpected connector endpoint before connecting', async () => {
    const h = harness();
    h.dependencies.getConfig.mockReturnValue({ host: 'attacker.pooler.supabase.com', port: 5432, user: `cli_login_postgres.${DEV_REF}`, password: 'private', database: 'postgres' });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('connector refused');
    expect(h.dependencies.connect).not.toHaveBeenCalled();
  });
  it.each([
    { roles: [{ name: 'signup_fixture_observer' }] }, { schema: { name: 'signup_fixture_guard' } },
    { functions: [{ signature: 'unexpected()' }] }, { memberships: [{ role: 'postgres' }] },
  ])('never overwrites existing observer state: %j', async (state) => {
    const h = harness({ state });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.dependencies.writeBackup).not.toHaveBeenCalled();
    expect(h.db.query.mock.calls.some(([sql]) => sql === OBSERVER_SETUP_SQL)).toBe(false);
    expect(h.secrets.publish).not.toHaveBeenCalled();
  });
  it('requires backup success before creating objects', async () => {
    const h = harness({ backupFails: true });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.db.query.mock.calls.some(([sql]) => sql === OBSERVER_SETUP_SQL)).toBe(false);
  });
  it('backs up only encrypted allowlisted metadata before setup and publishes DSN after probes', async () => {
    const h = harness();
    await expect(provisionObserver(options(), h.dependencies)).resolves.toMatchObject({ project: DEV_REF, verified: true });
    const envelope = JSON.parse(h.dependencies.writeBackup.mock.calls[0][1]);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(backupKey, 'base64'), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(`signup-observer:${DEV_REF}:v1`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
    expect(Object.keys(payload.inventory).sort()).toEqual(['database_acl', 'functions', 'memberships', 'roles', 'schema']);
    expect(envelope).not.toHaveProperty('inventory');
    expect(JSON.stringify(envelope)).not.toContain('postgres');
    expect(h.dependencies.writeBackup.mock.invocationCallOrder[0]).toBeLessThan(h.db.query.mock.invocationCallOrder[h.db.query.mock.calls.findIndex(([sql]) => sql === OBSERVER_SETUP_SQL)]);
    const dsn = new URL(h.secrets.publish.mock.calls[0][0]);
    expect(dsn.hostname).toBe('aws-1-us-west-2.pooler.supabase.com');
    expect(dsn.username).toBe(`signup_fixture_observer.${DEV_REF}`);
    expect(dsn.password).toMatch(/^[a-f0-9]{64}$/);
    expect(h.observer.end.mock.invocationCallOrder[0]).toBeLessThan(h.secrets.publish.mock.invocationCallOrder[0]);
    expect(h.db.end).toHaveBeenCalledOnce();
    expect(h.secrets.remove).not.toHaveBeenCalled();
  });
  it.each([
    { boundary: { ...boundary, guard0: false } }, { boundary: { ...boundary, guard1: null } },
    { observerIdentity: { role: 'postgres' } }, { observerIdentity: { session_role: 'postgres' } },
    { counts: { project_ref: 'qahnczmilgptcedaqype' } }, { counts: { sessions: '-1' } }, { counts: { refresh_tokens: '1.2' } },
    { counts: { unexpected: 'leaked' } }, { catalog: [] }, { denyCode: '42P01' },
  ])('refuses incomplete or overprivileged verification: %j', async (override) => {
    const h = harness(override);
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.secrets.publish).not.toHaveBeenCalled();
    expect(h.db.end).toHaveBeenCalled();
  });
  it('disables committed login and revokes helper after failed observer verification', async () => {
    const h = harness({ catalog: [] });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.db.query).toHaveBeenCalledWith('ALTER ROLE signup_fixture_observer NOLOGIN');
    expect(h.db.query).toHaveBeenCalledWith('REVOKE EXECUTE ON FUNCTION signup_fixture_guard.session_counts(uuid) FROM signup_fixture_observer');
    expect(h.observer.end).toHaveBeenCalled();
  });
  it('contains an ambiguous commit outcome instead of assuming rollback succeeded', async () => {
    const h = harness({ commitFails: true });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.db.query).toHaveBeenCalledWith('ALTER ROLE signup_fixture_observer NOLOGIN');
  });
  it('removes just-attempted secret publication and contains login after publication fails', async () => {
    const h = harness({ publishFails: true });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.secrets.remove).toHaveBeenCalledOnce();
    expect(h.db.query).toHaveBeenCalledWith('ALTER ROLE signup_fixture_observer NOLOGIN');
  });
  it('reports incomplete containment without exposing original errors or DSNs', async () => {
    const h = harness({ publishFails: true, disableFails: true });
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('containment was incomplete');
    expect(h.secrets.remove).toHaveBeenCalledOnce();
  });
  it('rejects unverified TLS before SQL', async () => {
    const h = harness();
    h.db.connection.stream.authorized = false;
    await expect(provisionObserver(options(), h.dependencies)).rejects.toThrow('refused');
    expect(h.db.query.mock.calls.map(([sql]) => sql)).toEqual(['ROLLBACK']);
  });
  it('checks all expected boundary result fields rather than accepting an empty result', async () => {
    await expect(verifyInstallation({ query: async () => ({ rows: [{}] }) })).rejects.toThrow('boundary refused');
  });
  it('refuses callable SECURITY DEFINER routines before activation and reports only sanitized names/classification', async () => {
    const h = harness();
    const original = h.db.query.getMockImplementation()!;
    h.db.query.mockImplementation(async (sql) => sql === CALLABLE_DEFINERS_SQL
      ? { rows: [{ schema_name: 'public', routine_name: 'unsafe_rpc', volatility: 'v', classification: 'write-or-dynamic-body', prosrc: 'secret body omitted' }] }
      : original(sql));
    const recordEvidence = vi.fn();
    await expect(provisionObserver(options(), { ...h.dependencies, recordEvidence })).rejects.toThrow('refused');
    expect(recordEvidence).toHaveBeenCalledWith(JSON.stringify({ project: DEV_REF, unreviewedCallableDefiners: [{ name: 'public.unsafe_rpc', classification: 'write-or-dynamic-body' }] }));
    expect(h.db.query.mock.calls.some(([sql]) => sql.includes('PASSWORD'))).toBe(false);
    expect(h.secrets.publish).not.toHaveBeenCalled();
  });
  it('refuses malformed routine evidence without logging database-provided strings', async () => {
    const recordEvidence = vi.fn();
    await expect(rejectUnreviewedDefiners({ query: async () => ({ rows: [{ schema_name: 'public', routine_name: 'secret\ntext', classification: 'write-or-dynamic-body' }] }) }, recordEvidence)).rejects.toThrow('inventory format');
    expect(recordEvidence).not.toHaveBeenCalled();
  });
  it('contains no role hashes, dynamic application SQL, data writes or destructive blanket rollback', () => {
    expect(INVENTORY_SQL).not.toMatch(/rolpassword|pg_authid|auth\.sessions|auth\.refresh_tokens/);
    expect(OBSERVER_SETUP_SQL).not.toMatch(/GRANT .* ON ALL TABLES|DROP OWNED|CASCADE|\bBYPASSRLS\b/);
    expect(OBSERVER_SETUP_SQL).toContain('NOBYPASSRLS');
    expect(CATALOG_SQL).toContain("c.relkind in ('r','p')");
    expect(CATALOG_SQL).toContain('a.attnum>0 and not a.attisdropped');
  });
});

describe('GitHub secret IO', () => {
  it('uses stdin only with the fixed repository/name and never a PAT or body flag', () => {
    const run = vi.fn((command: string, args: string[], options: { input?: string; stdio?: string[] }) => { void command; void args; void options; return { status: 0, stdout: '[]' }; });
    const io = githubSecretIO(run);
    io.assertAbsent(); io.publish('private-dsn');
    const call = run.mock.calls[1];
    expect(call[0]).toBe('gh');
    expect(call[1]).toEqual(['secret', 'set', 'TEST_SIGNUP_PROOF_OBSERVER_URL', '--repo', 'PrakritR/PropLane']);
    expect(call[2].input).toBe('private-dsn');
    expect(JSON.stringify(call[1])).not.toContain('private-dsn');
    expect(call[2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
  it('refuses overwriting an existing secret', () => {
    const run = vi.fn(() => ({ status: 0, stdout: '[{"name":"TEST_SIGNUP_PROOF_OBSERVER_URL"}]' }));
    expect(() => githubSecretIO(run).assertAbsent()).toThrow('rotation review');
    expect(run).toHaveBeenCalledOnce();
  });
  it('replaces CLI errors containing sensitive output with a fixed error', () => {
    const run = vi.fn(() => ({ status: 1, stdout: 'sensitive stdout', stderr: 'private dsn' }));
    expect(() => githubSecretIO(run).publish('private-dsn')).toThrow('GitHub secret operation failed.');
  });
});
