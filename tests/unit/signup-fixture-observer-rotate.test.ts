import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALLABLE_DEFINERS_SQL, CATALOG_SQL, CONSTRAINTS_SQL, DEV_REF } from '../../scripts/security/signup-fixture-observer-provision.mjs';
import { STATE_SQL, SESSIONS_SQL, assertQuiescenceReceipt, digest, proveRotatedObserver, rotateObserver, rotationGithubIO, rotationSourceDigest, rotationStore, syncDirectory } from '../../scripts/security/signup-fixture-observer-rotate.mjs';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function privateDirectory() { const path = realpathSync(mkdtempSync(`${tmpdir()}/observer-rotate-`)); directories.push(path); return path; }
function harness() {
  const retained = new Map<string, unknown>();
  const state = { roles: [{ name: 'signup_fixture_observer' }], inventory: { roles: [{ name: 'signup_fixture_observer' }] } };
  const boundary = { ...Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`guard${n}`, true])), memberships: [] };
  const db = {
    connection: { stream: { encrypted: true, authorized: true } },
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('select current_user')) return { rows: [{ role: 'postgres', session_role: 'cli_login_postgres', database: 'postgres' }] };
      if (sql.includes('as schema_ok')) return { rows: [boundary] };
      if (sql === STATE_SQL) return { rows: [{ state }] };
      if (sql === SESSIONS_SQL) return { rows: [{ complete: true, sessions: '0' }] };
      if (sql === CATALOG_SQL) return { rows: [{ column: 'id' }] };
      if (sql === CONSTRAINTS_SQL || sql === CALLABLE_DEFINERS_SQL) return { rows: [] };
      return { rows: [] };
    }),
    end: vi.fn(async () => undefined),
  };
  const store = {
    has: (key: string) => retained.has(key),
    write: vi.fn((key: string, value: unknown) => { if (retained.has(key)) throw new Error('exclusive'); retained.set(key, value); }),
    read: (key: string) => { if (!retained.has(key)) throw new Error('absent'); return retained.get(key); },
    close: vi.fn(),
  };
  const dependencies = {
    store: vi.fn(() => store),
    secrets: { assertExisting: vi.fn(async () => undefined), assertQuiescent: vi.fn(async () => undefined), publish: vi.fn(async (value: string) => { void value; }) },
    quiescence: vi.fn(async (minimum = 0) => { void minimum; }),
    getConfig: vi.fn(() => ({ host: 'aws-1-us-west-2.pooler.supabase.com', port: 5432, database: 'postgres', user: `cli_login_postgres.${DEV_REF}`, password: 'bootstrap-private' })),
    connect: vi.fn(async () => db), prove: vi.fn(async () => undefined),
  };
  return { db, store, state, retained, dependencies };
}
function options(phase = 'apply') { return { phase, apiUrl: `https://${DEV_REF}.supabase.co`, reviewedSha256: rotationSourceDigest(), directory: '/private/operation' }; }

describe('credential-only observer rotation', () => {
  it('retains one value before mutation, proves locally before stdin publication, and leaves CI pending', async () => {
    const h = harness();
    await expect(rotateObserver(options(), h.dependencies)).resolves.toMatchObject({ published: true, localVerified: true, complete: false });
    const prepared = h.retained.get('prepared') as { password: string; dsn: string };
    expect(prepared.password).toMatch(/^[a-f0-9]{64}$/);
    const mutation = h.db.query.mock.calls.findIndex(([sql]) => sql.startsWith('ALTER ROLE'));
    expect(h.store.write.mock.invocationCallOrder[0]).toBeLessThan(h.db.query.mock.invocationCallOrder[mutation]);
    expect(h.dependencies.prove.mock.invocationCallOrder[0]).toBeLessThan(h.dependencies.secrets.publish.mock.invocationCallOrder[0]);
    expect(h.dependencies.secrets.publish).toHaveBeenCalledWith(prepared.dsn);
    expect(h.db.query.mock.calls.filter(([sql]) => /^(ALTER|GRANT|REVOKE|CREATE|DROP)\b/.test(sql)).map(([sql]) => sql)).toEqual([`ALTER ROLE signup_fixture_observer PASSWORD '${prepared.password}'`]);
    expect(h.db.end).toHaveBeenCalledOnce(); expect(h.store.close).toHaveBeenCalledOnce();
  });
  it.each([{ reviewedSha256: 'a'.repeat(64) }, { apiUrl: 'https://qahnczmilgptcedaqype.supabase.co' }, { phase: 'provision' }])('rejects wrong source/target/phase before IO', async (override) => {
    const h = harness();
    await expect(rotateObserver({ ...options(), ...override }, h.dependencies)).rejects.toThrow();
    expect(h.dependencies.store).not.toHaveBeenCalled(); expect(h.dependencies.connect).not.toHaveBeenCalled();
  });
  it.each(['retention', 'consumer', 'secret', 'session', 'visibility', 'catalog', 'tls', 'target'])('refuses %s preconditions without password mutation', async (failure) => {
    const h = harness();
    if (failure === 'retention') h.store.write.mockImplementation(() => { throw new Error('disk private'); });
    if (failure === 'consumer') h.dependencies.quiescence.mockRejectedValue(new Error('private process'));
    if (failure === 'secret') h.dependencies.secrets.assertExisting.mockRejectedValue(new Error('private secret'));
    if (failure === 'tls') h.db.connection.stream.authorized = false;
    if (failure === 'target') h.dependencies.getConfig.mockReturnValue({ ...h.dependencies.getConfig(), host: 'wrong' });
    if (['session', 'visibility', 'catalog'].includes(failure)) {
      const query = h.db.query.getMockImplementation()!;
      h.db.query.mockImplementation(async (sql) => {
        if (sql === SESSIONS_SQL) return { rows: [{ complete: failure !== 'visibility', sessions: failure === 'session' ? '1' : '0' }] } as never;
        if (failure === 'catalog' && sql === CATALOG_SQL) return { rows: [] };
        return query(sql);
      });
    }
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('rotation pending');
    expect(h.db.query.mock.calls.some(([sql]) => sql.startsWith('ALTER ROLE'))).toBe(false);
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
  });
  it('rechecks external quiescence immediately before committing', async () => {
    const h = harness();
    h.dependencies.secrets.assertQuiescent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new CI consumer'));
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    expect(h.retained.has('prepared')).toBe(true);
    expect(h.db.query.mock.calls.some(([sql]) => sql.startsWith('ALTER ROLE'))).toBe(false);
  });
  it('refreshes transaction-cached activity when a consumer starts during GitHub inventory', async () => {
    const h = harness(); const query = h.db.query.getMockImplementation()!;
    let actualSessions = '0', cachedSessions: string | undefined;
    h.db.query.mockImplementation(async (sql) => {
      if (sql === 'select pg_catalog.pg_stat_clear_snapshot()') cachedSessions = undefined;
      if (sql === SESSIONS_SQL) {
        cachedSessions ??= actualSessions;
        return { rows: [{ complete: true, sessions: cachedSessions }] } as never;
      }
      return query(sql);
    });
    h.dependencies.secrets.assertQuiescent.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { actualSessions = '1'; });
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    expect(h.db.query.mock.calls.some(([sql]) => sql.startsWith('ALTER ROLE') || sql === 'COMMIT')).toBe(false);
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
    for (let n = 0; n < h.db.query.mock.calls.length; n++) if (h.db.query.mock.calls[n][0] === SESSIONS_SQL) expect(h.db.query.mock.calls[n - 1][0]).toBe('select pg_catalog.pg_stat_clear_snapshot()');
  });
  it.each(['before-alter', 'marker-io', 'publication-github', 'publication-marker', 'publication-budget'])('enforces the lease after blocking work: %s', async (point) => {
    const h = harness(); const parent = privateDirectory(), path = `${parent}/quiescence.json`;
    let now = 100000, checks = 0;
    writeFileSync(path, JSON.stringify({ project: DEV_REF, repository: 'PrakritR/PropLane', sourceSha256: options().reviewedSha256, consumerInventorySha256: 'a'.repeat(64), localConsumersExcluded: true, scheduledConsumersExcluded: true, issuedAt: now, expiresAt: now + 60000 }), { mode: 0o600 });
    h.dependencies.quiescence.mockImplementation(async (minimum = 0) => { assertQuiescenceReceipt(path, options().reviewedSha256, now, minimum); });
    h.dependencies.secrets.assertQuiescent.mockImplementation(async () => {
      checks++;
      if (point === 'before-alter' && checks === 2 || point === 'publication-github' && checks === 3) now += 61000;
      if (point === 'publication-budget' && checks === 3) now += 30000;
    });
    const write = h.store.write.getMockImplementation()!;
    h.store.write.mockImplementation((name, value) => {
      write(name, value);
      if (point === 'marker-io' && name === 'commit-attempt' || point === 'publication-marker' && name === 'publication-attempt') now += 61000;
    });
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
    if (point === 'before-alter') expect(h.db.query.mock.calls.some(([sql]) => sql.startsWith('ALTER ROLE'))).toBe(false);
    if (['before-alter', 'marker-io'].includes(point)) expect(h.db.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });
  it('refreshes cached activity after final GitHub publication reads', async () => {
    const h = harness(); const query = h.db.query.getMockImplementation()!; let consumers = '0', calls = 0, cached: string | undefined;
    h.dependencies.secrets.assertQuiescent.mockImplementation(async () => { if (++calls === 3) consumers = '1'; });
    h.db.query.mockImplementation(async (sql) => {
      if (sql === 'select pg_catalog.pg_stat_clear_snapshot()') cached = undefined;
      if (sql === SESSIONS_SQL) { cached ??= consumers; return { rows: [{ complete: true, sessions: cached }] } as never; }
      return query(sql);
    });
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
  });
  it('rechecks activity after durable commit marker IO before sending COMMIT', async () => {
    const h = harness(); const query = h.db.query.getMockImplementation()!, write = h.store.write.getMockImplementation()!;
    let consumers = '0', cached: string | undefined;
    h.store.write.mockImplementation((name, value) => { write(name, value); if (name === 'commit-attempt') consumers = '1'; });
    h.db.query.mockImplementation(async (sql) => {
      if (sql === 'select pg_catalog.pg_stat_clear_snapshot()') cached = undefined;
      if (sql === SESSIONS_SQL) { cached ??= consumers; return { rows: [{ complete: true, sessions: cached }] } as never; }
      return query(sql);
    });
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    expect(h.db.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER ROLE'))).toHaveLength(1);
    expect(h.db.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
  });
  it.each(['commit', 'publish'])('retains and resumes the same value after ambiguous %s', async (failure) => {
    const h = harness();
    if (failure === 'publish') h.dependencies.secrets.publish.mockRejectedValueOnce(new Error('dsn sensitive timeout'));
    else {
      const query = h.db.query.getMockImplementation()!;
      let once = true;
      h.db.query.mockImplementation(async (sql) => { if (sql === 'COMMIT' && once) { once = false; throw new Error('private DB'); } return query(sql); });
    }
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('pending');
    const prepared = h.retained.get('prepared');
    await expect(rotateObserver(options('resume'), h.dependencies)).resolves.toMatchObject({ complete: false, published: true });
    expect(h.retained.get('prepared')).toBe(prepared);
    expect(h.db.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER ROLE'))).toHaveLength(1);
    expect(h.dependencies.secrets.publish).toHaveBeenLastCalledWith((prepared as { dsn: string }).dsn);
  });
  it('does not infer rollback from a failed retained login after commit attempt', async () => {
    const h = harness();
    await rotateObserver(options(), h.dependencies);
    h.dependencies.prove.mockRejectedValueOnce(new Error('network/private credential'));
    await expect(rotateObserver(options('resume'), h.dependencies)).rejects.toThrow('pending');
    expect(h.db.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER ROLE'))).toHaveLength(1);
  });
  it('resumes a prepared transaction with no commit marker using the same retained value', async () => {
    const h = harness();
    h.dependencies.secrets.assertQuiescent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('new consumer'));
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow();
    h.dependencies.secrets.assertQuiescent.mockResolvedValue(undefined);
    await expect(rotateObserver(options('resume'), h.dependencies)).resolves.toMatchObject({ published: true });
    expect(h.store.write.mock.calls.filter(([name]) => name === 'prepared')).toHaveLength(1);
  });
  it('refuses non-password metadata drift on resume', async () => {
    const h = harness();
    await rotateObserver(options(), h.dependencies);
    h.state.roles.push({ name: 'unexpected' });
    await expect(rotateObserver(options('resume'), h.dependencies)).rejects.toThrow('pending');
    expect(h.db.query.mock.calls.filter(([sql]) => sql.startsWith('ALTER ROLE'))).toHaveLength(1);
  });
});

describe('private state and fixed GitHub transport', () => {
  it('persists exclusive private recovery files and refuses concurrent owners or overwrite', () => {
    const parent = privateDirectory();
    const store = rotationStore(`${parent}/operation`, false);
    store.write('prepared', { password: 'retained' });
    expect(JSON.parse(readFileSync(`${parent}/operation/prepared.json`, 'utf8'))).toEqual({ password: 'retained' });
    expect(() => rotationStore(`${parent}/operation`, true)).toThrow();
    expect(() => store.write('prepared', {})).toThrow();
    store.close();
    const resumed = rotationStore(`${parent}/operation`, true);
    expect(resumed.read('prepared')).toEqual({ password: 'retained' }); resumed.close();
  });
  it('syncs the new operation directory and its parent before any SQL; parent fsync failure refuses mutation', async () => {
    const parent = privateDirectory(), directory = `${parent}/operation`, h = harness(), synced: string[] = [];
    h.dependencies.store.mockImplementation(() => rotationStore(directory, false, (value: string) => { synced.push(value); if (value === parent) throw new Error('parent fsync failed'); syncDirectory(value); }) as never);
    await expect(rotateObserver(options(), h.dependencies)).rejects.toThrow('parent fsync failed');
    expect(synced).toEqual([directory, parent]);
    expect(h.dependencies.connect).not.toHaveBeenCalled();
    expect(h.db.query.mock.calls.some(([sql]) => sql.startsWith('ALTER ROLE') || sql === 'COMMIT')).toBe(false);
    expect(h.dependencies.secrets.publish).not.toHaveBeenCalled();
  });
  it('finishes real directory and parent synchronization before any connection or retained write', async () => {
    const parent = privateDirectory(), directory = `${parent}/operation`, h = harness(), synced: string[] = [];
    const actualStore = rotationStore(directory, false, (value: string) => { syncDirectory(value); synced.push(value); });
    h.dependencies.store.mockReturnValue(actualStore as never);
    h.dependencies.connect.mockImplementation(async () => {
      expect(synced).toEqual([directory, parent]);
      expect(() => readFileSync(`${directory}/prepared.json`)).toThrow();
      return h.db;
    });
    await expect(rotateObserver(options(), h.dependencies)).resolves.toMatchObject({ published: true });
    expect(JSON.parse(readFileSync(`${directory}/prepared.json`, 'utf8')).password).toMatch(/^[a-f0-9]{64}$/);
  });
  it('requires fresh bounded root consumer exclusion and inventory digest', () => {
    const parent = privateDirectory(); const path = `${parent}/quiescence.json`; const now = Date.now();
    const receipt = { project: DEV_REF, repository: 'PrakritR/PropLane', sourceSha256: rotationSourceDigest(), consumerInventorySha256: 'a'.repeat(64), localConsumersExcluded: true, scheduledConsumersExcluded: true, issuedAt: now, expiresAt: now + 60000 };
    writeFileSync(path, JSON.stringify(receipt), { mode: 0o600 });
    expect(() => assertQuiescenceReceipt(path, receipt.sourceSha256, now)).not.toThrow();
    expect(() => assertQuiescenceReceipt(path, receipt.sourceSha256, now + 60001)).toThrow();
    expect(() => assertQuiescenceReceipt(path, receipt.sourceSha256, now + 30000, 35000)).toThrow();
    expect(() => assertQuiescenceReceipt(path, receipt.sourceSha256, now + 20000, 35000)).not.toThrow();
    writeFileSync(path, JSON.stringify({ ...receipt, localConsumersExcluded: false }));
    expect(() => assertQuiescenceReceipt(path, receipt.sourceSha256, now)).toThrow();
    mkdirSync(`${parent}/public`, { mode: 0o755 });
    expect(() => rotationStore(`${parent}/public/operation`, false)).toThrow();
  });
  it('uses all five fixed-repository status queries and secret publication stdin only', () => {
    const run = vi.fn((cmd: string, args: string[], opts: unknown) => { void cmd; void opts; return { status: 0, stdout: args[0] === 'api' ? '[{"total_count":0,"workflow_runs":[]}]' : '[{"name":"TEST_SIGNUP_PROOF_OBSERVER_URL","updatedAt":"2026-11-07"}]' }; });
    const io = rotationGithubIO(run); io.assertExisting(); io.assertQuiescent(); io.publish('private-dsn');
    expect(run.mock.calls.slice(1, 6).map((call) => call[1])).toEqual(
      ['in_progress', 'queued', 'requested', 'waiting', 'pending'].map((status) =>
        ['api', '--paginate', '--slurp', `repos/PrakritR/PropLane/actions/runs?status=${status}&per_page=100`]),
    );
    expect(run.mock.calls[6][1]).toEqual(['secret', 'set', 'TEST_SIGNUP_PROOF_OBSERVER_URL', '--repo', 'PrakritR/PropLane']);
    expect(run.mock.calls[6][2]).toMatchObject({ input: 'private-dsn', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(JSON.stringify(run.mock.calls.map((call) => call[1]))).not.toContain('private-dsn');
  });
  it.each(['in_progress', 'queued', 'requested', 'waiting', 'pending'])('refuses an active %s consumer', (status) => {
    const run = vi.fn((_cmd: string, args: string[]) => ({ status: 0, stdout: JSON.stringify([
      args[3].includes(`status=${status}&`) ? { total_count: 1, workflow_runs: [{ status }] } : { total_count: 0, workflow_runs: [] },
    ]) }));
    expect(() => rotationGithubIO(run).assertQuiescent()).toThrow('CI consumers must be quiescent.');
  });
  it.each([
    '[]', '{}', 'null', '[null]', '[{}]', '[{"workflow_runs":[]}]',
    '[{"total_count":0}]', '[{"total_count":0,"workflow_runs":null}]',
    '[{"total_count":0,"workflow_runs":{}}]', '[{"total_count":-1,"workflow_runs":[]}]',
    '[{"total_count":"0","workflow_runs":[]}]', '[{"total_count":0.5,"workflow_runs":[]}]',
    '[{"total_count":9007199254740992,"workflow_runs":[]}]',
    '[{"total_count":1,"workflow_runs":[]}]',
    '[{"total_count":0,"workflow_runs":[{"status":"completed"}]}]',
    '[{"total_count":0,"workflow_runs":[{"status":"unknown"}]}]',
    '[{"total_count":0,"workflow_runs":[null]}]',
    '[{"total_count":0,"workflow_runs":[]},{}]',
    '[{"total_count":0,"workflow_runs":[]},{"total_count":1,"workflow_runs":[]}]',
    'truncated json',
  ])('refuses malformed, partial or nonzero inventory: %s', (stdout) => {
    expect(() => rotationGithubIO(() => ({ status: 0, stdout })).assertQuiescent()).toThrow();
  });
  it('checks every returned page and every status for malformed responses', () => {
    const statuses = ['in_progress', 'queued', 'requested', 'waiting', 'pending'];
    for (const status of statuses) {
      const run = vi.fn((_cmd: string, args: string[]) => ({ status: 0, stdout: JSON.stringify(
        args[3].includes(`status=${status}&`) ? [{ total_count: 0, workflow_runs: [] }, {}] : [{ total_count: 0, workflow_runs: [] }],
      ) }));
      expect(() => rotationGithubIO(run).assertQuiescent()).toThrow();
    }
    expect(() => rotationGithubIO(() => ({ status: 0, stdout: '[{"total_count":0,"workflow_runs":[]},{"total_count":0,"workflow_runs":[]}]' })).assertQuiescent()).not.toThrow();
  });
  it.each([{ status: 1 }, { status: null, error: new Error('timeout') }, { status: 0, error: new Error('API failure') }])('refuses GitHub API failures: %j', (result) => {
    expect(() => rotationGithubIO(() => ({ ...result, stdout: '[{"total_count":0,"workflow_runs":[]}]' })).assertQuiescent()).toThrow();
  });
  it('refuses a missing existing secret', () => {
    expect(() => rotationGithubIO(() => ({ status: 0, stdout: '[]' })).assertExisting()).toThrow();
    expect(digest({ b: 2, a: [2, 1] })).toBe(digest({ a: [1, 2], b: 2 }));
  });
});

describe('real local proof orchestration with restricted-client fakes', () => {
  function proofHarness(override: { counts?: object; denyCode?: string; catalog?: object[] } = {}) {
    const catalog = [{ column: 'id' }], clients: { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }[] = [];
    const connect = vi.fn(async () => {
      const client = { query: vi.fn(async (sql: string) => {
        if (sql.startsWith('select * from signup_fixture_guard')) return { rows: [{ project_ref: DEV_REF, sessions: '0', refresh_tokens: '0', ...override.counts }] };
        if (sql === CATALOG_SQL) return { rows: override.catalog ?? catalog };
        if (sql.startsWith('select user_id from auth.')) throw Object.assign(new Error('sensitive driver body'), { code: override.denyCode ?? '42501' });
        return { rows: [] };
      }), end: vi.fn(async () => undefined) };
      clients.push(client); return client;
    });
    return { catalog, clients, connect };
  }
  const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co`, SUPABASE_DB_SSL_CA_FILE: `${process.cwd()}/scripts/security/supabase-prod-ca-2021.crt` };
  it('runs ordinary preflight, count-only shape, catalog equivalence and rolled-back denied-read probes', async () => {
    const h = proofHarness(); await proveRotatedObserver(env, h.catalog, [], h.connect);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
    const queries = h.clients[1].query.mock.calls.map(([sql]) => sql);
    expect(queries.filter((sql) => sql === 'ROLLBACK TO SAVEPOINT denied_probe')).toHaveLength(2);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
  it.each([{ counts: { extra: 'forbidden' } }, { counts: { sessions: '-1' } }, { counts: { project_ref: 'wrong' } }, { denyCode: '42P01' }, { catalog: [] }])('refuses incomplete or overprivileged local proof: %j', async (override) => {
    const h = proofHarness(override); await expect(proveRotatedObserver(env, h.catalog, [], h.connect)).rejects.toThrow();
    expect(h.clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
  });
});
