import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALLABLE_DEFINERS_SQL, CATALOG_SQL, CONSTRAINTS_SQL, DEV_REF, REPOSITORY } from '../../scripts/security/signup-fixture-observer-provision.mjs';
import { digest, rotationSourceDigest, rotationStore, STATE_SQL } from '../../scripts/security/signup-fixture-observer-rotate.mjs';
import { boundedQuery, classifyBootstrapMetadata, HELD_SQL, INVENTORY_SQL, ORIGINAL_SHA256, PREFLIGHT_SQL, publishRetainedObserver, recoverySourceDigest, safePublicationRefusal } from '../../scripts/security/signup-fixture-observer-publish-retained.mjs';

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const p of directories.splice(0)) rmSync(p, { recursive: true, force: true }); });
function options() { return { apiUrl: `https://${DEV_REF}.supabase.co`, reviewedSha256: recoverySourceDigest(), originalSha256: ORIGINAL_SHA256, directory: '/private/not-read-in-tests' }; }
function harness() {
  const identity = { pid: 128, backend_start: '2026-11-07 17:55:00+00', role: 'signup_fixture_observer', session_role: 'signup_fixture_observer', database: 'postgres' };
  const state = { roles: [{ name: 'cli_login_postgres', valid_until: '2026-11-07T18:00:24.811562+00:00', login: true }, { name: 'signup_fixture_observer', valid_until: null, login: true }], inventory: { roles: [] } }, catalog = [{ column: 'id' }], constraints: unknown[] = [];
  const boundary = { ...Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`guard${n}`, true])), memberships: [] };
  const password = 'a'.repeat(64);
  const retained = { version: 1, phase: 'prepared', project: DEV_REF, repository: REPOSITORY, sourceSha256: ORIGINAL_SHA256, prestateSha256: digest(state), password, dsn: `postgresql://signup_fixture_observer.${DEV_REF}:${password}@aws-1-us-west-2.pooler.supabase.com:5432/postgres` };
  const records = new Map<string, Record<string, unknown>>([
    ['prepared', retained], ['metadata-backup', { prestate: state, catalog, constraints }],
    ['commit-attempt', { sourceSha256: ORIGINAL_SHA256, at: '2026-11-07T17:55:01.000Z' }],
    ['local-proof', { phase: 'locally-verified', sourceSha256: ORIGINAL_SHA256, at: '2026-11-07T17:55:02.000Z' }],
    ['publication-attempt', { phase: 'publication-attempt', sourceSha256: ORIGINAL_SHA256, at: '2026-11-07T17:55:03.000Z' }],
  ]);
  const events: string[] = [];
  let drained = false;
  function client(restricted: boolean) {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      connection: { stream: { encrypted: true, authorized: true, destroy: vi.fn() } },
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        events.push(`${restricted ? 'observer' : 'admin'}:${sql}`);
        if (sql === HELD_SQL) return { rows: [{ ...identity }] };
        if (sql === INVENTORY_SQL) return { rows: [{ complete: true, sessions: drained ? [] : [{ ...identity }] }] };
        if (sql.startsWith('select current_user')) return { rows: [{ role: 'postgres', session_role: 'cli_login_postgres', database: 'postgres' }] };
        if (sql.includes('as schema_ok')) return { rows: [boundary] };
        if (sql === CALLABLE_DEFINERS_SQL) return { rows: [] };
        if (sql === STATE_SQL) return { rows: [{ state }] };
        if (sql === CATALOG_SQL) return { rows: catalog };
        if (sql === CONSTRAINTS_SQL) return { rows: constraints };
        if (sql.includes('session_counts($1')) { events.push(`target:${values?.[0]}`); return { rows: [{ project_ref: DEV_REF, sessions: '0', refresh_tokens: '0' }] }; }
        if (sql.startsWith('select user_id')) throw Object.assign(new Error('private denial'), { code: '42501' });
        return { rows: [] };
      }),
      end: vi.fn(async () => { events.push(`${restricted ? 'observer' : 'admin'}:end`); if (restricted) drained = true; emitter.emit('end'); }),
    });
  }
  const admin = client(false), observer = client(true);
  const store = { has: (name: string) => records.has(name), read: (name: string) => { if (!records.has(name)) throw new Error('missing'); return records.get(name); }, write: vi.fn((name: string, value: Record<string, unknown>) => { events.push(`write:${name}`); if (records.has(name)) throw new Error('exclusive'); records.set(name, value); }), close: vi.fn() };
  const deps = {
    store: vi.fn(() => store), connect: vi.fn(async () => admin), connectObserver: vi.fn(async () => observer),
    getConfig: vi.fn(() => ({ host: 'aws-1-us-west-2.pooler.supabase.com', port: 5432, database: 'postgres', user: `cli_login_postgres.${DEV_REF}`, password: 'private-bootstrap' })),
    secrets: { assertExisting: vi.fn(async () => undefined), assertQuiescent: vi.fn(async () => undefined), publish: vi.fn(async (value: string) => { void value; events.push('publish'); }) },
    quiescence: vi.fn(async (minimum = 0) => { events.push(`lease:${minimum}`); }),
  };
  return { identity, state, boundary, records, retained, events, admin, observer, store, deps, setDrained: (value: boolean) => { drained = value; } };
}
function overrideQuery(client: ReturnType<typeof harness>['observer'], override: (sql: string, values?: unknown[]) => unknown) {
  const original = client.query.getMockImplementation()!;
  client.query.mockImplementation(async (sql, values) => (await override(sql, values)) ?? original(sql, values));
}

describe('publication-only retained observer recovery', () => {
  it('pins the unchanged six inputs and binds its own bytes', () => {
    expect(rotationSourceDigest()).toBe(ORIGINAL_SHA256);
    expect(recoverySourceDigest()).toBe(digest(`${ORIGINAL_SHA256}\0${readFileSync('scripts/security/signup-fixture-observer-publish-retained.mjs', 'utf8')}`));
    const source = readFileSync('scripts/security/signup-fixture-observer-publish-retained.mjs', 'utf8');
    expect(source).not.toMatch(/\b(?:ALTER ROLE|GRANT |REVOKE |CREATE ROLE|DROP |randomBytes|rotateObserver\(|proveRotatedObserver\(|preflightSignupCleanup\()/);
    expect(source).not.toMatch(/pg_terminate_backend|can_self_terminate|expectedClose/);
    expect(source).toContain('dependencies.connectObserver ?? connectSignupObserver');
    expect(source).toContain('dependencies.connect ?? connectNonproductionDatabase');
  });
  it('proves every preflight and rotation assertion on one reused held connection before normal close and passive drain', async () => {
    const h = harness();
    await expect(publishRetainedObserver(options(), h.deps)).resolves.toMatchObject({ published: true, localVerified: true, complete: false });
    expect(h.deps.connectObserver).toHaveBeenCalledOnce();
    expect(h.deps.secrets.publish).toHaveBeenCalledWith(h.retained.dsn);
    for (const sql of [...PREFLIGHT_SQL, 'BEGIN READ ONLY', CATALOG_SQL, CONSTRAINTS_SQL, CALLABLE_DEFINERS_SQL, 'select user_id from auth.sessions limit 0', 'select user_id from auth.refresh_tokens limit 0']) expect(h.observer.query.mock.calls.some(([query]) => query === sql)).toBe(true);
    expect(h.events).toContain('target:00000000-0000-0000-0000-000000000000');
    expect(h.events).toContain('target:00000000-0000-4000-8000-000000000000');
    expect(h.events.indexOf('observer:ROLLBACK')).toBeLessThan(h.events.indexOf('observer:end'));
    expect(h.observer.query.mock.calls.at(-1)?.[0]).toBe(HELD_SQL);
    expect(h.events[h.events.indexOf('observer:end') + 1]).toBe('lease:0');
    for (const client of [h.admin, h.observer]) expect(client.query.mock.calls.some(([sql]) => /pg_terminate_backend|can_self_terminate/.test(sql))).toBe(false);
    expect(h.admin.query.mock.calls.some(([sql]) => sql.includes('pg_terminate_backend'))).toBe(false);
    const observations = h.admin.query.mock.calls.map(([sql]) => sql);
    observations.forEach((sql, n) => { if (sql === INVENTORY_SQL) expect(observations[n - 1]).toBe('select pg_catalog.pg_stat_clear_snapshot()'); });
    expect(h.events[h.events.indexOf('publish') - 1]).toBe('lease:35000');
    expect(h.store.close).toHaveBeenCalledOnce();
  });
  it.each([{ originalSha256: '0'.repeat(64) }, { reviewedSha256: '0'.repeat(64) }, { apiUrl: 'https://qahnczmilgptcedaqype.supabase.co' }])('refuses source/target drift before IO', async (change) => {
    const h = harness(); await expect(publishRetainedObserver({ ...options(), ...change }, h.deps)).rejects.toThrow(); expect(h.deps.store).not.toHaveBeenCalled();
  });
  it.each(['missing', 'phase', 'pin', 'dsn', 'password', 'backup', 'chronology', 'future', 'invalid-date'])('refuses %s retained evidence', async (kind) => {
    const h = harness();
    if (kind === 'missing') h.records.delete('local-proof');
    if (kind === 'phase') h.retained.phase = 'applied';
    if (kind === 'pin') h.retained.sourceSha256 = 'b'.repeat(64);
    if (kind === 'dsn') h.retained.dsn += '?x=1';
    if (kind === 'password') h.retained.password = 'not-hex';
    if (kind === 'backup') h.retained.prestateSha256 = '0'.repeat(64);
    if (kind === 'chronology') h.records.get('local-proof')!.at = '2026-11-07T17:54:00.000Z';
    if (kind === 'future') h.records.get('publication-attempt')!.at = '2999-01-01T00:00:00.000Z';
    if (kind === 'invalid-date') h.records.get('commit-attempt')!.at = 'bad';
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('pending'); expect(h.deps.connect).not.toHaveBeenCalled(); expect(h.deps.secrets.publish).not.toHaveBeenCalled();
  });
  it.each(['visibility', 'two-backends', 'wrong-pid', 'wrong-start', 'wrong-role', 'wrong-db', 'changed-identity', 'tls', 'bootstrap', 'metadata', 'catalog', 'constraints', 'definer', 'boundary', 'project', 'shape', 'negative', 'denial', 'early-event', 'new-after-zero', 'lease', 'active-ci', 'durable', 'publish'])('fails closed for %s', async (kind) => {
    const h = harness(); let heldCalls = 0, inventoryCalls = 0;
    overrideQuery(h.admin, (sql) => {
      if (sql === INVENTORY_SQL) {
        inventoryCalls++;
        if (kind === 'visibility') return { rows: [{ complete: false, sessions: [] }] };
        if (kind === 'two-backends') return { rows: [{ complete: true, sessions: [h.identity, { ...h.identity, pid: 129 }] }] };
        if (['wrong-pid', 'wrong-start', 'wrong-role', 'wrong-db'].includes(kind) && inventoryCalls > 1) return { rows: [{ complete: true, sessions: [{ ...h.identity, ...(kind === 'wrong-pid' ? { pid: 129 } : kind === 'wrong-start' ? { backend_start: '2026-11-07 17:56:00+00' } : kind === 'wrong-role' ? { role: 'other' } : { database: 'other' }) }] }] };
        if (kind === 'new-after-zero' && inventoryCalls >= 5) return { rows: [{ complete: true, sessions: [h.identity] }] };
      }
      if (kind === 'metadata' && sql === STATE_SQL) return { rows: [{ state: { roles: [] } }] };
      if (kind === 'bootstrap' && sql.startsWith('select current_user')) return { rows: [{ role: 'postgres', session_role: 'postgres', database: 'postgres' }] };
    });
    overrideQuery(h.observer, (sql) => {
      if (kind === 'changed-identity' && sql === HELD_SQL && ++heldCalls > 1) return { rows: [{ ...h.identity, pid: 130 }] };
      if (kind === 'catalog' && sql === CATALOG_SQL) return { rows: [] };
      if (kind === 'constraints' && sql === CONSTRAINTS_SQL) return { rows: [{ changed: true }] };
      if (kind === 'definer' && sql === CALLABLE_DEFINERS_SQL) return { rows: [{ schema_name: 'public', routine_name: 'unsafe', classification: 'body-requires-review' }] };
      if (kind === 'boundary' && sql.includes('as schema_ok')) return { rows: [{ ...h.boundary, guard0: false }] };
      if (['project', 'shape', 'negative'].includes(kind) && sql.includes('session_counts($1')) return { rows: [{ project_ref: kind === 'project' ? 'other' : DEV_REF, sessions: kind === 'negative' ? '-1' : '0', refresh_tokens: '0', ...(kind === 'shape' ? { extra: 'bad' } : {}) }] };
      if (kind === 'denial' && sql.startsWith('select user_id')) return { rows: [] };
      if (kind === 'early-event' && sql === HELD_SQL) h.observer.emit('error', Object.assign(new Error('private'), { code: '57P01' }));
    });
    if (kind === 'tls') h.observer.connection.stream.authorized = false;
    if (kind === 'lease') h.deps.quiescence.mockImplementation(async (minimum) => { if (minimum === 35000) throw new Error('stale'); });
    if (kind === 'active-ci') h.deps.secrets.assertQuiescent.mockRejectedValue(new Error('active'));
    if (kind === 'durable') h.store.write.mockImplementation(() => { throw new Error('fsync'); });
    if (kind === 'publish') h.deps.secrets.publish.mockRejectedValue(new Error('timeout-private'));
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('pending');
    expect(h.records.has('recovery-published')).toBe(false);
    if (kind !== 'publish') expect(h.deps.secrets.publish).not.toHaveBeenCalled();
    if (['project', 'shape', 'negative', 'denial', 'catalog', 'constraints', 'definer', 'boundary'].includes(kind)) expect(h.events).not.toContain('publish');
  });
  it.each(['57P01', 'ECONNRESET', 'EPIPE', 'XX000'])('refuses observer error %s during deliberate normal close', async (code) => {
    const h = harness(); h.observer.end.mockImplementation(async () => { h.observer.emit('error', Object.assign(new Error('PRIVATE'), { code })); h.observer.emit('end'); });
    const error = await publishRetainedObserver(options(), h.deps).catch((failure) => failure);
    expect(error.closeDiagnostics).toMatchObject({ step: 'client-close', closeResult: 'complete', errorCode: code });
    expect(h.deps.secrets.publish).not.toHaveBeenCalled(); expect(error.message).not.toContain('PRIVATE');
  });
  it.each(['early-end', 'close-rejection', 'close-timeout', 'close-timeout-resolves', 'admin-error', 'late-observer-error'])('refuses %s lifecycle failure', async (kind) => {
    vi.useFakeTimers(); const h = harness();
    if (kind === 'early-end') overrideQuery(h.observer, (sql) => { if (sql === HELD_SQL) h.observer.emit('end'); });
    if (kind === 'close-rejection') h.observer.end.mockRejectedValue(new Error('PRIVATE'));
    if (kind === 'close-timeout') h.observer.end.mockImplementation(() => new Promise(() => undefined));
    if (kind === 'close-timeout-resolves') h.observer.end.mockImplementation(() => new Promise<void>((resolve) => { h.observer.connection.stream.destroy.mockImplementation(() => { h.observer.emit('end'); resolve(); }); }));
    if (kind === 'admin-error' || kind === 'late-observer-error') overrideQuery(h.admin, (sql) => { if (sql === INVENTORY_SQL && h.observer.end.mock.calls.length) h[kind === 'admin-error' ? 'admin' : 'observer'].emit('error', Object.assign(new Error('PRIVATE'), { code: '57P01' })); });
    const assertion = expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('pending');
    await vi.runAllTimersAsync(); await assertion;
    expect(h.deps.secrets.publish).not.toHaveBeenCalled();
    if (kind.startsWith('close-timeout')) expect(h.observer.connection.stream.destroy).toHaveBeenCalled();
  });
  it.each(['observer', 'admin'] as const)('retains publication ambiguity for %s error during publication', async (source) => {
    const h = harness();
    h.deps.secrets.publish.mockImplementation(async () => { await Promise.resolve(); h[source].emit('error', Object.assign(new Error('PRIVATE'), { code: '57P01' })); });
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('phase=secret-publication');
    expect(h.deps.secrets.publish).toHaveBeenCalledWith(h.retained.dsn);
    expect(h.records.has('recovery-published')).toBe(false);
    expect([...h.records.keys()].some((key) => key.startsWith('recovery-attempt-'))).toBe(true);
    await new Promise((done) => setTimeout(done, 2)); h.setDrained(false);
    h.deps.secrets.publish.mockImplementation(async () => undefined);
    await expect(publishRetainedObserver(options(), h.deps)).resolves.toMatchObject({ complete: false });
    expect(h.deps.connectObserver).toHaveBeenCalledTimes(2);
    expect(h.deps.secrets.publish.mock.calls.map(([dsn]) => dsn)).toEqual([h.retained.dsn, h.retained.dsn]);
  });
  it('sanitizes every CLI field independently and never prints raw error text', () => {
    const secret = 'PRIVATE-DSN';
    const error = { message: secret, publicationPhase: 'own-backend-close', closeDiagnostics: Object.fromEntries(['step', 'closeResult', 'errorCode', 'eventSource', 'inventory'].map((key) => [key, secret])) };
    expect(safePublicationRefusal(error)).toContain('close-step=unknown; close-result=unknown; error-code=unknown; event-source=none; inventory=unknown');
    expect(safePublicationRefusal(error)).not.toContain(secret);
    expect(safePublicationRefusal({ ...error, publicationPhase: secret })).not.toContain(secret);
    expect(safePublicationRefusal({ ...error, publicationPhase: 'owned-proof' })).not.toContain('close-step=');
  });
  it('passively waits beyond 120 seconds for the same backend, validating renewed leases every second', async () => {
    vi.useFakeTimers(); const h = harness(); const started = performance.now();
    overrideQuery(h.admin, (sql) => sql === INVENTORY_SQL && h.observer.end.mock.calls.length ? { rows: [{ complete: true, sessions: performance.now() - started < 121000 ? [h.identity] : [] }] } : undefined);
    const result = publishRetainedObserver(options(), h.deps);
    await vi.advanceTimersByTimeAsync(120000); expect(h.deps.secrets.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await expect(result).resolves.toMatchObject({ complete: false });
    expect(h.deps.quiescence.mock.calls.length).toBeGreaterThan(120);
    expect(h.deps.connectObserver).toHaveBeenCalledOnce();
    expect(h.observer.query.mock.calls.at(-1)?.[0]).toBe(HELD_SQL);
    const polls = h.admin.query.mock.calls.map(([sql]) => sql);
    polls.forEach((sql, n) => { if (sql === INVENTORY_SQL) expect(polls[n - 1]).toBe('select pg_catalog.pg_stat_clear_snapshot()'); });
    for (const client of [h.admin, h.observer]) expect(client.query.mock.calls.some(([sql]) => /pg_terminate_backend/.test(sql))).toBe(false);
  });
  it.each(['deadline', 'zero-at-deadline', 'zero-after-deadline', 'lease-expiry', 'replacement', 'reused-pid', 'additional', 'visibility', 'malformed', 'role', 'database'])('refuses passive drain %s', async (kind) => {
    vi.useFakeTimers(); const h = harness(), started = performance.now();
    h.deps.quiescence.mockImplementation(async () => { if (kind === 'lease-expiry' && performance.now() - started >= 2000) throw new Error('PRIVATE'); });
    overrideQuery(h.admin, async (sql) => {
      if (sql !== INVENTORY_SQL || !h.observer.end.mock.calls.length) return;
      const row = { ...h.identity };
      if (kind === 'replacement') row.pid++;
      if (kind === 'reused-pid') row.backend_start = '2026-11-07 17:56:00+00';
      if (kind === 'role') row.role = 'other';
      if (kind === 'database') row.database = 'other';
      if (kind === 'zero-at-deadline' || kind === 'zero-after-deadline') { await new Promise((done) => setTimeout(done, 100)); vi.advanceTimersByTime(150000 + (kind === 'zero-after-deadline' ? 1 : 0) - (performance.now() - started)); return { rows: [{ complete: true, sessions: [] }] }; }
      return { rows: [{ complete: kind !== 'visibility', sessions: kind === 'malformed' ? null : kind === 'additional' ? [row, { ...row, pid: 999 }] : [row] }] };
    });
    const result = publishRetainedObserver(options(), h.deps); const assertion = expect(result).rejects.toThrow('pending');
    await vi.runAllTimersAsync(); await assertion;
    expect(h.deps.secrets.publish).not.toHaveBeenCalled();
    if (!['deadline', 'zero-at-deadline', 'zero-after-deadline', 'lease-expiry'].includes(kind)) expect(performance.now() - started).toBeLessThan(1000);
    if (kind === 'deadline') expect(performance.now() - started).toBe(150000);
  });
  it('destroys timed-out query socket and waits for rejection instead of abandoning a raced query', async () => {
    vi.useFakeTimers(); let rejectQuery: (error: Error) => void = () => undefined;
    const client = { query: () => new Promise((_, reject) => { rejectQuery = reject; }), connection: { stream: { destroy: vi.fn(() => rejectQuery(Object.assign(new Error('private'), { code: 'ECONNRESET' }))) } } };
    const assertion = expect(boundedQuery(client, 'fixed', undefined, 10)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10); await assertion; expect(client.connection.stream.destroy).toHaveBeenCalledOnce();
  });
  it('returns valid published records as CI pending without remote IO and rejects altered binding', async () => {
    const h = harness(); await publishRetainedObserver(options(), h.deps);
    h.deps.connect.mockClear(); h.deps.secrets.publish.mockClear();
    await expect(publishRetainedObserver(options(), h.deps)).resolves.toMatchObject({ complete: false }); expect(h.deps.connect).not.toHaveBeenCalled(); expect(h.deps.secrets.publish).not.toHaveBeenCalled();
    h.records.get('recovery-published')!.operationSha256 = 'bad'; await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow();
  });
  it('retries ambiguous publication with identical bytes and fresh full proof', async () => {
    const h = harness(); h.deps.secrets.publish.mockRejectedValueOnce(new Error('lost response'));
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow();
    // Advance unique attempt name without altering original evidence.
    await new Promise((done) => setTimeout(done, 2)); h.setDrained(false);
    await expect(publishRetainedObserver(options(), h.deps)).resolves.toMatchObject({ complete: false });
    expect(h.deps.connectObserver).toHaveBeenCalledTimes(2); expect(h.deps.secrets.publish.mock.calls.map(([dsn]) => dsn)).toEqual([h.retained.dsn, h.retained.dsn]);
  });
  it('uses original private store mode, canonical path, symlink and lock protection', () => {
    const parent = realpathSync(mkdtempSync(`${tmpdir()}/retained-publication-`)); directories.push(parent); chmodSync(parent, 0o700);
    const directory = `${parent}/operation`; mkdirSync(directory, { mode: 0o700 });
    const store = rotationStore(directory, true); expect(() => rotationStore(directory, true)).toThrow(); store.close();
    writeFileSync(`${directory}/prepared.json`, '{}', { mode: 0o644 }); const again = rotationStore(directory, true); expect(() => again.read('prepared')).toThrow(); again.close();
    symlinkSync(directory, `${parent}/alias`); expect(() => rotationStore(`${parent}/alias`, true)).toThrow();
    chmodSync(directory, 0o755); expect(() => rotationStore(directory, true)).toThrow();
    chmodSync(directory, 0o700); expect(() => rotationStore(directory, true, () => { throw new Error('parent fsync'); })).toThrow('parent fsync');
  });
});


describe('initial bootstrap expiry renewal', () => {
  const observedAt = Date.parse('2026-11-07T18:09:53.409Z');
  function states() {
    const previous = harness().state;
    const current = structuredClone(previous);
    current.roles[0].valid_until = '2026-11-07T18:14:53.409478+00:00';
    return { previous, current };
  }
  it('recognizes the actual prior/fresh pair and pins the complete fresh digest without mutation', () => {
    const { previous, current } = states(), original = structuredClone(previous);
    expect(classifyBootstrapMetadata(previous, current, observedAt)).toEqual({ classification: 'cli-login-expiry-renewal', stateSha256: digest(current) });
    expect(previous).toEqual(original);
  });
  it('classifies an exact no-change state', () => {
    const { previous } = states();
    expect(classifyBootstrapMetadata(previous, structuredClone(previous), observedAt)).toEqual({ classification: 'unchanged', stateSha256: digest(previous) });
  });
  it.each(['wrong-role', 'missing-before', 'missing-after', 'duplicate-before', 'duplicate-after', 'bootstrap-attribute', 'observer-attribute', 'inventory', 'unrelated-section', 'missing-field', 'null', 'infinite', 'invalid', 'expired', 'backwards', 'overlong'])('rejects %s instead of weakening metadata equality', (kind) => {
    const { previous, current } = states();
    if (kind === 'wrong-role') { current.roles[0].valid_until = previous.roles[0].valid_until; current.roles[1].valid_until = '2026-11-07T18:14:53Z'; }
    if (kind === 'missing-before') previous.roles.shift();
    if (kind === 'missing-after') current.roles.shift();
    if (kind === 'duplicate-before') previous.roles.push({ ...previous.roles[0] });
    if (kind === 'duplicate-after') current.roles.push({ ...current.roles[0] });
    if (kind === 'bootstrap-attribute') current.roles[0].login = false;
    if (kind === 'observer-attribute') current.roles[1].login = false;
    if (kind === 'inventory') current.inventory.roles.push('drift' as never);
    if (kind === 'unrelated-section') Object.assign(current, { memberships: ['drift'] });
    if (kind === 'missing-field') Reflect.deleteProperty(current.roles[0], 'valid_until');
    if (kind === 'null') current.roles[0].valid_until = null;
    if (kind === 'infinite') current.roles[0].valid_until = 'infinity';
    if (kind === 'invalid') current.roles[0].valid_until = 'bad';
    if (kind === 'expired') current.roles[0].valid_until = '2026-11-07T18:05:00Z';
    if (kind === 'backwards') { previous.roles[0].valid_until = '2026-11-07T18:15:00Z'; }
    if (kind === 'overlong') current.roles[0].valid_until = new Date(observedAt + 600001).toISOString();
    expect(() => classifyBootstrapMetadata(previous, current, observedAt)).toThrow();
  });
  it('rejects nonfinite historical expiry even when the fresh expiry is bounded', () => {
    const { previous, current } = states(); previous.roles[0].valid_until = null;
    expect(() => classifyBootstrapMetadata(previous, current, observedAt)).toThrow();
  });
  it('accepts the ten-minute inclusive limit', () => {
    const { previous, current } = states(); current.roles[0].valid_until = new Date(observedAt + 600000).toISOString();
    expect(classifyBootstrapMetadata(previous, current, observedAt).classification).toBe('cli-login-expiry-renewal');
  });
  it.each(['renewed', 'unchanged'])('pins the entire %s first state and rejects a later expiry change', async (kind) => {
    vi.useFakeTimers(); vi.setSystemTime(observedAt);
    const h = harness(), current = structuredClone(h.state); let calls = 0;
    if (kind === 'renewed') current.roles[0].valid_until = '2026-11-07T18:14:53.409478+00:00';
    overrideQuery(h.admin, (sql) => {
      if (sql !== STATE_SQL) return;
      calls++;
      return { rows: [{ state: calls === 1 ? structuredClone(current) : { ...current, roles: current.roles.map((role, index) => index === 0 ? { ...role, valid_until: '2026-11-07T18:15:00Z' } : role) } }] };
    });
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('phase=publication-gates');
    expect(h.deps.secrets.publish).not.toHaveBeenCalled();
  });
  it('records renewal classification and complete fresh digest in the durable attempt', async () => {
    vi.useFakeTimers(); vi.setSystemTime(observedAt);
    const h = harness(), current = structuredClone(h.state); current.roles[0].valid_until = '2026-11-07T18:14:53.409478+00:00';
    overrideQuery(h.admin, (sql) => sql === STATE_SQL ? { rows: [{ state: current }] } : undefined);
    await publishRetainedObserver(options(), h.deps);
    const attempt = [...h.records.entries()].find(([name]) => name.startsWith('recovery-attempt-'))![1];
    expect(attempt.bootstrapMetadata).toEqual({ classification: 'cli-login-expiry-renewal', stateSha256: digest(current) });
    expect(h.retained.prestateSha256).toBe(digest(h.state));
  });
  it('suppresses arbitrary raw errors and exposes only a fixed phase', async () => {
    const h = harness(); h.deps.connectObserver.mockRejectedValue(new Error('PRIVATE-DRIVER-DSN'));
    await expect(publishRetainedObserver(options(), h.deps)).rejects.toThrow('phase=owned-proof');
    await expect(publishRetainedObserver(options(), h.deps)).rejects.not.toThrow('PRIVATE-DRIVER-DSN');
  });
});
